//! Immutable per-device log. Replay is canonical, causal and independent of arrival order.
//! Compaction never deletes input to this replay until a separate coverage proof exists.
use super::super::snapshot::{hash, safe_path};
use crate::vault::{err, write_atomic, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub const MAX_BATCH: usize = 2 * 1024 * 1024;
pub type Documents = BTreeMap<String, Value>;
pub type Frontier = BTreeMap<String, u64>;
pub fn bytes<T: Serialize>(v: &T) -> Res<Vec<u8>> {
    serde_json::to_vec(v).map_err(err)
}
// JSON null is a value; absence is a deletion. Serde Option<Value> alone conflates them.
mod optional_value {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::{json, Value};
    pub fn serialize<S: Serializer>(
        value: &Option<Value>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(v) => json!({"present":true,"value":v}).serialize(serializer),
            None => json!({"present":false}).serialize(serializer),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Value>, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            present: bool,
            #[serde(default)]
            value: Value,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.present {
            Ok(Some(wire.value))
        } else if wire.value.is_null() {
            Ok(None)
        } else {
            Err(serde::de::Error::custom("absent value has content"))
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<Delta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_object: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_object: Option<String>,
    #[serde(with = "optional_value")]
    pub base: Option<Value>,
    #[serde(with = "optional_value")]
    pub next: Option<Value>,
    #[serde(default)]
    pub resolves: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    pub pointer: Vec<String>,
    #[serde(with = "optional_value")]
    pub base: Option<Value>,
    #[serde(with = "optional_value")]
    pub next: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delta {
    pub base_hash: String,
    pub patches: Vec<Patch>,
}
fn diff(base: Option<&Value>, next: Option<&Value>, pointer: Vec<String>, out: &mut Vec<Patch>) {
    if base == next {
        return;
    }
    if let (Some(Value::Object(a)), Some(Value::Object(b))) = (base, next) {
        for k in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
            let mut p = pointer.clone();
            p.push(k.clone());
            diff(a.get(k), b.get(k), p, out);
        }
        return;
    }
    out.push(Patch {
        pointer,
        base: base.cloned(),
        next: next.cloned(),
    });
}
fn patched(base: &Value, patches: &[Patch]) -> Res<Value> {
    let mut out = base.clone();
    for patch in patches {
        if patch.pointer.len() > 64 {
            return Err("DRIVE:patch_depth".into());
        }
        let mut value = &mut out;
        for part in patch
            .pointer
            .iter()
            .take(patch.pointer.len().saturating_sub(1))
        {
            value = value.get_mut(part).ok_or("DRIVE:patch_precondition")?;
        }
        if let Some(key) = patch.pointer.last() {
            let object = value.as_object_mut().ok_or("DRIVE:patch_precondition")?;
            if object.get(key) != patch.base.as_ref() {
                return Err("DRIVE:patch_precondition".into());
            }
            if let Some(next) = &patch.next {
                object.insert(key.clone(), next.clone());
            } else {
                object.remove(key);
            }
        } else {
            if Some(&*value) != patch.base.as_ref() {
                return Err("DRIVE:patch_precondition".into());
            }
            *value = patch.next.clone().ok_or("DRIVE:patch_precondition")?;
        }
    }
    Ok(out)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtomicGroup {
    pub id: String,
    pub index: u32,
    pub count: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub protocol: String,
    pub schema_version: u32,
    pub vault_id: String,
    pub device_id: String,
    pub sequence: u64,
    pub previous_batch_id: Option<String>,
    pub seen_frontier: Frontier,
    pub operations: Vec<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atomic_group: Option<AtomicGroup>,
    pub required_objects: BTreeSet<String>,
    pub batch_id: String,
}
impl Batch {
    fn digest(&self) -> Res<String> {
        let mut b = self.clone();
        b.batch_id.clear();
        Ok(hash(&bytes(&b)?))
    }
    pub fn seal(mut self) -> Res<Self> {
        self.batch_id = self.digest()?;
        self.validate(&self.vault_id)?;
        Ok(self)
    }
    pub fn validate(&self, vault: &str) -> Res<()> {
        if self.protocol != "nevis-drive-sync" || self.schema_version != 1 {
            return Err("DRIVE:unsupported_schema".into());
        }
        if self.vault_id != vault
            || uuid::Uuid::parse_str(vault).is_err()
            || uuid::Uuid::parse_str(&self.device_id).is_err()
        {
            return Err("DRIVE:identity_mismatch".into());
        }
        if self.sequence == 0
            || self.operations.is_empty()
            || self.operations.len() > 200
            || bytes(self)?.len() > MAX_BATCH
        {
            return Err("DRIVE:batch_limit".into());
        }
        if self.batch_id != self.digest()? {
            return Err("DRIVE:integrity".into());
        }
        if self
            .seen_frontier
            .get(&self.device_id)
            .copied()
            .unwrap_or(0)
            != self.sequence - 1
        {
            return Err("DRIVE:sequence".into());
        }
        if (self.sequence == 1) != self.previous_batch_id.is_none() {
            return Err("DRIVE:previous_batch".into());
        }
        for (d, n) in &self.seen_frontier {
            if uuid::Uuid::parse_str(d).is_err() || *n == 0 {
                return Err("DRIVE:frontier".into());
            }
        }
        if let Some(group) = &self.atomic_group {
            if group.count == 0
                || group.count > 1000
                || group.index >= group.count
                || uuid::Uuid::parse_str(&group.id).is_err()
                || self
                    .sequence
                    .checked_sub(group.index as u64)
                    .is_none_or(|n| n == 0)
            {
                return Err("DRIVE:atomic_group_invalid".into());
            }
        }
        for o in &self.operations {
            safe_path(&o.path)?;
            if (o.base_object.is_some() && o.base.is_some())
                || (o.next_object.is_some() && o.next.is_some())
                || (o.delta.is_some() && (o.base_object.is_some() || o.next_object.is_some()))
            {
                return Err("DRIVE:invalid_delta".into());
            }
            for h in [o.base_object.as_ref(), o.next_object.as_ref()]
                .into_iter()
                .flatten()
            {
                if !valid_hash(h) || !self.required_objects.contains(h) {
                    return Err("DRIVE:missing_dependency".into());
                }
            }
        }
        for o in &self.operations {
            if let Some(d) = &o.delta {
                if o.base.is_some()
                    || o.next.is_some()
                    || !valid_hash(&d.base_hash)
                    || !self.required_objects.contains(&d.base_hash)
                    || d.patches.len() > 20000
                {
                    return Err("DRIVE:invalid_delta".into());
                }
            }
        }
        for h in &self.required_objects {
            if !valid_hash(h) {
                return Err("DRIVE:invalid_hash".into());
            }
        }
        Ok(())
    }
}
pub fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub path: String,
    pub pointer: String,
    pub base: Option<Value>,
    pub a: Option<Value>,
    pub b: Option<Value>,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq)]
pub struct Materialized {
    pub documents: Documents,
    pub frontier: Frontier,
    pub conflicts: BTreeMap<String, Conflict>,
    pub tombstones: BTreeSet<String>,
    #[serde(default)]
    pub provenance: BTreeMap<String, Frontier>,
}

// Preserve both candidates. Missing vs edited is resurrection; timestamps never pick a winner.
/// Merge sibling identity order using three-way pair constraints. Ambiguous cycles archive.
/// Bound quadratic work; larger ambiguous orders use the conservative full-array conflict path.
fn merge_order(base: Option<&Value>, a: &Value, b: &Value) -> Option<Value> {
    let aa = a.as_array()?;
    let bb = b.as_array()?;
    let empty = vec![];
    let old = base.and_then(Value::as_array).unwrap_or(&empty);
    let positions = |values: &[Value]| -> Option<BTreeMap<String, usize>> {
        let mut out = BTreeMap::new();
        for (i, v) in values.iter().enumerate() {
            if out.insert(v.as_str()?.to_string(), i).is_some() {
                return None;
            }
        }
        Some(out)
    };
    let pa = positions(aa)?;
    let pb = positions(bb)?;
    let po = positions(old)?;
    let ids: Vec<_> = pa
        .keys()
        .chain(pb.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.len() > 200 {
        return None;
    }
    let relation = |p: &BTreeMap<String, usize>, x: &str, y: &str| -> Option<bool> {
        Some(p.get(x)? < p.get(y)?)
    };
    let mut edges: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut degree: BTreeMap<String, usize> = ids.iter().map(|id| (id.clone(), 0)).collect();
    for (i, x) in ids.iter().enumerate() {
        for y in ids.iter().skip(i + 1) {
            let ra = relation(&pa, x, y);
            let rb = relation(&pb, x, y);
            let ro = relation(&po, x, y);
            let selected = match (ra, rb) {
                (Some(a), Some(b)) if a == b => Some(a),
                (Some(a), Some(b)) if Some(a) == ro => Some(b),
                (Some(a), Some(b)) if Some(b) == ro => Some(a),
                (Some(_), Some(_)) => return None,
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            if let Some(before) = selected {
                let (from, to) = if before { (x, y) } else { (y, x) };
                if edges.entry(from.clone()).or_default().insert(to.clone()) {
                    *degree.get_mut(to)? += 1;
                }
            }
        }
    }
    let mut ready: BTreeSet<_> = degree
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(id, _)| id.clone())
        .collect();
    let mut order = vec![];
    while let Some(id) = ready.pop_first() {
        order.push(id.clone());
        if let Some(next) = edges.get(&id) {
            for child in next {
                let n = degree.get_mut(child)?;
                *n -= 1;
                if *n == 0 {
                    ready.insert(child.clone());
                }
            }
        }
    }
    if order.len() != ids.len() {
        return None;
    }
    Some(json!(order))
}
fn merge(
    path: &str,
    pointer: &str,
    base: Option<&Value>,
    a: Option<&Value>,
    b: Option<&Value>,
    conflicts: &mut BTreeMap<String, Conflict>,
    context: &Frontier,
) -> Option<Value> {
    if a == b {
        return a.cloned();
    }
    if a == base {
        return b.cloned();
    }
    if b == base {
        return a.cloned();
    }
    if pointer.contains("/$nevisTreeV1/orders/") {
        if let (Some(a), Some(b)) = (a, b) {
            if let Some(order) = merge_order(base, a, b) {
                return Some(order);
            }
        }
    }
    if let (Some(Value::Object(aa)), Some(Value::Object(bb))) = (a, b) {
        let empty = serde_json::Map::new();
        let old = base.and_then(Value::as_object).unwrap_or(&empty);
        let keys: BTreeSet<_> = aa.keys().chain(bb.keys()).chain(old.keys()).collect();
        let mut out = serde_json::Map::new();
        for k in keys {
            if k == "updatedAt" {
                if let (Some(a), Some(b)) = (
                    aa.get(k).and_then(Value::as_i64),
                    bb.get(k).and_then(Value::as_i64),
                ) {
                    out.insert(k.clone(), json!(a.max(b)));
                    continue;
                }
            }
            let ptr = format!("{pointer}/{}", k.replace('~', "~0").replace('/', "~1"));
            if let Some(v) = merge(
                path,
                &ptr,
                old.get(k),
                aa.get(k),
                bb.get(k),
                conflicts,
                context,
            ) {
                out.insert(k.clone(), v);
            }
        }
        return Some(Value::Object(out));
    }
    // Rich text arrays without stable identities remain atomic. Full preimages survive.
    let id =
        hash(&bytes(&json!([path, pointer, base, a, b, context])).expect("JSON values serialize"));
    conflicts.insert(
        id.clone(),
        Conflict {
            id,
            path: path.into(),
            pointer: pointer.into(),
            base: base.cloned(),
            a: a.cloned(),
            b: b.cloned(),
        },
    );
    // A deterministic temporary candidate, with edited content winning over a deletion.
    b.or(a).cloned()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaySeed {
    pub vault_id: String,
    pub state: Materialized,
    pub heads: BTreeMap<String, String>,
    pub covered_batches: BTreeMap<String, String>,
    pub retained_objects: BTreeSet<String>,
}
pub fn stream_key(device: &str, sequence: u64) -> String {
    format!("{device}:{sequence}")
}
impl ReplaySeed {
    pub fn validate(&self, vault: &str) -> Res<()> {
        if self.vault_id != vault {
            return Err("DRIVE:checkpoint_identity".into());
        }
        validate_coverage(&self.state.frontier, &self.heads, &self.covered_batches)?;
        if self.retained_objects.iter().any(|h| !valid_hash(h)) {
            return Err("DRIVE:checkpoint_inventory".into());
        }
        if self.state.documents.is_empty() {
            return Err("DRIVE:checkpoint_empty".into());
        }
        for (path, value) in &self.state.documents {
            safe_path(path)?;
            if let Some(h) = blob_hash(value) {
                if !valid_hash(h) {
                    return Err("DRIVE:invalid_hash".into());
                }
            }
        }
        for (id, c) in &self.state.conflicts {
            if !valid_hash(id) || id != &c.id || c.pointer.len() > 4096 {
                return Err("DRIVE:checkpoint_conflict".into());
            }
            safe_path(&c.path)?;
        }
        for (path, frontier) in &self.state.provenance {
            safe_path(path)?;
            if frontier.iter().any(|(device, n)| {
                *n == 0 || *n > self.state.frontier.get(device).copied().unwrap_or(0)
            }) {
                return Err("DRIVE:checkpoint_provenance".into());
            }
        }
        for path in &self.state.tombstones {
            safe_path(path)?;
        }
        Ok(())
    }
    pub fn covers(&self, batch: &Batch) -> Res<bool> {
        if batch.sequence
            > self
                .state
                .frontier
                .get(&batch.device_id)
                .copied()
                .unwrap_or(0)
        {
            return Ok(false);
        }
        if self
            .covered_batches
            .get(&stream_key(&batch.device_id, batch.sequence))
            != Some(&batch.batch_id)
        {
            return Err("DRIVE:device_id_collision".into());
        }
        Ok(true)
    }
}
pub fn validate_coverage(
    frontier: &Frontier,
    heads: &BTreeMap<String, String>,
    ledger: &BTreeMap<String, String>,
) -> Res<()> {
    let total = frontier
        .values()
        .try_fold(0usize, |n, seq| n.checked_add(usize::try_from(*seq).ok()?))
        .ok_or("DRIVE:checkpoint_coverage_limit")?;
    if total > 100_000 || total != ledger.len() || heads.len() != frontier.len() {
        return Err("DRIVE:checkpoint_coverage".into());
    }
    for (device, n) in frontier {
        if uuid::Uuid::parse_str(device).is_err() || *n == 0 {
            return Err("DRIVE:checkpoint_frontier".into());
        }
        for seq in 1..=*n {
            let h = ledger
                .get(&stream_key(device, seq))
                .ok_or("DRIVE:checkpoint_gap")?;
            if !valid_hash(h) {
                return Err("DRIVE:checkpoint_coverage".into());
            }
        }
        if heads.get(device) != ledger.get(&stream_key(device, *n)) {
            return Err("DRIVE:checkpoint_head".into());
        }
    }
    Ok(())
}
pub fn coverage(j: &Journal) -> Res<(BTreeMap<String, String>, BTreeMap<String, String>)> {
    let mut ledger = j
        .seed
        .as_ref()
        .map(|s| s.covered_batches.clone())
        .unwrap_or_default();
    for b in j.batches.values() {
        let k = stream_key(&b.device_id, b.sequence);
        if ledger.get(&k).is_some_and(|h| h != &b.batch_id) {
            return Err("DRIVE:device_id_collision".into());
        }
        ledger.insert(k, b.batch_id.clone());
    }
    let mut heads = BTreeMap::new();
    for (device, n) in &j.capture_frontier {
        heads.insert(
            device.clone(),
            ledger
                .get(&stream_key(device, *n))
                .ok_or("DRIVE:checkpoint_gap")?
                .clone(),
        );
    }
    validate_coverage(&j.capture_frontier, &heads, &ledger)?;
    Ok((heads, ledger))
}
pub fn replay(
    vault: &str,
    batches: &BTreeMap<String, Batch>,
    preimages: &BTreeMap<String, Value>,
) -> Res<Materialized> {
    replay_seeded(vault, batches, preimages, None)
}
pub fn replay_seeded(
    vault: &str,
    batches: &BTreeMap<String, Batch>,
    preimages: &BTreeMap<String, Value>,
    seed: Option<&ReplaySeed>,
) -> Res<Materialized> {
    if let Some(seed) = seed {
        seed.validate(vault)?;
    }
    let mut pending = BTreeMap::new();
    for b in batches.values() {
        b.validate(vault)?;
        if let Some(seed) = seed {
            if seed.covers(b)? {
                continue;
            }
        }
        if let Some(old) = pending.insert((b.device_id.clone(), b.sequence), b) {
            if old.batch_id != b.batch_id {
                return Err("DRIVE:device_id_collision".into());
            }
        }
    }
    for batch in pending.values() {
        if let Some(group) = &batch.atomic_group {
            let first = batch.sequence - group.index as u64;
            for index in 0..group.count {
                let sequence = first
                    .checked_add(index as u64)
                    .ok_or("DRIVE:atomic_group_invalid")?;
                if seed.is_some_and(|s| {
                    sequence <= s.state.frontier.get(&batch.device_id).copied().unwrap_or(0)
                }) {
                    return Err("DRIVE:checkpoint_group_boundary".into());
                }
                let member = pending
                    .get(&(batch.device_id.clone(), sequence))
                    .ok_or("DRIVE:waiting_atomic_group")?;
                if member
                    .atomic_group
                    .as_ref()
                    .is_none_or(|g| g.id != group.id || g.index != index || g.count != group.count)
                {
                    return Err("DRIVE:atomic_group_invalid".into());
                }
            }
        }
    }
    let mut out = seed.map(|s| s.state.clone()).unwrap_or_default();
    let mut heads = seed.map(|s| s.heads.clone()).unwrap_or_default();
    while !pending.is_empty() {
        let key = pending
            .iter()
            .find(|(_, b)| {
                b.sequence == out.frontier.get(&b.device_id).copied().unwrap_or(0) + 1
                    && b.seen_frontier
                        .iter()
                        .all(|(d, n)| out.frontier.get(d).copied().unwrap_or(0) >= *n)
            })
            .map(|(k, _)| k.clone())
            .ok_or("DRIVE:waiting_dependency")?;
        let b = pending.remove(&key).unwrap();
        if b.previous_batch_id.as_ref() != heads.get(&b.device_id) {
            return Err("DRIVE:previous_batch".into());
        }
        for op in &b.operations {
            let (base, next) = if let Some(delta) = &op.delta {
                let base = preimages
                    .get(&delta.base_hash)
                    .ok_or("DRIVE:missing_dependency")?;
                if hash(&bytes(base)?) != delta.base_hash {
                    return Err("DRIVE:integrity".into());
                }
                (Some(base.clone()), Some(patched(base, &delta.patches)?))
            } else {
                let load = |key: &Option<String>, inline: &Option<Value>| -> Res<Option<Value>> {
                    if let Some(h) = key {
                        let value = preimages.get(h).ok_or("DRIVE:missing_dependency")?;
                        if hash(&bytes(value)?) != *h {
                            return Err("DRIVE:integrity".into());
                        }
                        Ok(Some(value.clone()))
                    } else {
                        Ok(inline.clone())
                    }
                };
                (
                    load(&op.base_object, &op.base)?,
                    load(&op.next_object, &op.next)?,
                )
            };
            let mut context = out.provenance.get(&op.path).cloned().unwrap_or_default();
            context.insert(b.device_id.clone(), b.sequence);
            let old = out.documents.get(&op.path).cloned();
            let existing: BTreeSet<_> = out.conflicts.keys().cloned().collect();
            let mut merged = merge(
                &op.path,
                "",
                base.as_ref(),
                old.as_ref(),
                next.as_ref(),
                &mut out.conflicts,
                &context,
            );
            // Independent creations sharing one database identity must never synthesize a hybrid record.
            if op.path.starts_with("databases/")
                && base.is_none()
                && old.is_some()
                && next.is_some()
                && old != next
            {
                let id = hash(&bytes(&json!([
                    "record-identity-collision",
                    op.path,
                    old,
                    next,
                    context
                ]))?);
                out.conflicts.insert(
                    id.clone(),
                    Conflict {
                        id,
                        path: op.path.clone(),
                        pointer: String::new(),
                        base: None,
                        a: old.clone(),
                        b: next.clone(),
                    },
                );
                merged = if bytes(&old)? <= bytes(&next)? {
                    old.clone()
                } else {
                    next.clone()
                };
            }
            if op.path.starts_with("pages/") {
                if let Some(page) = merged.as_mut() {
                    if super::stable::repair_structure(
                        page,
                        [base.as_ref(), old.as_ref(), next.as_ref()],
                    )? {
                        let id = hash(&bytes(&json!([
                            "structural-recovery",
                            op.path,
                            base,
                            old,
                            next,
                            context
                        ]))?);
                        out.conflicts.insert(
                            id.clone(),
                            Conflict {
                                id,
                                path: op.path.clone(),
                                pointer: "/content".into(),
                                base: base.clone(),
                                a: old.clone(),
                                b: next.clone(),
                            },
                        );
                    }
                }
            }
            if op.path.starts_with("pages/") || op.path.starts_with("databases/") {
                let deleted =
                    |v: &Option<Value>| v.as_ref().is_some_and(|v| !v["deletedAt"].is_null());
                let edited = |v: &Option<Value>| {
                    let clean = |v: &Option<Value>| {
                        v.as_ref().map(|v| {
                            let mut v = v.clone();
                            if let Some(o) = v.as_object_mut() {
                                for key in ["updatedAt", "deletedAt", "revision", "lastOperationId"]
                                {
                                    o.remove(key);
                                }
                            }
                            v
                        })
                    };
                    clean(v) != clean(&base)
                };
                if (deleted(&old) && !deleted(&next) && edited(&next))
                    || (deleted(&next) && !deleted(&old) && edited(&old))
                {
                    if let Some(Value::Object(v)) = &mut merged {
                        v.insert("deletedAt".into(), Value::Null);
                    }
                    let id = hash(&bytes(&json!([
                        "resurrection",
                        op.path,
                        base,
                        old,
                        next,
                        context
                    ]))?);
                    out.conflicts.insert(
                        id.clone(),
                        Conflict {
                            id,
                            path: op.path.clone(),
                            pointer: "/deletedAt".into(),
                            base: base.clone(),
                            a: old.clone(),
                            b: next.clone(),
                        },
                    );
                    out.tombstones.insert(op.path.clone());
                }
            }
            for (id, c) in out.conflicts.iter_mut() {
                if !existing.contains(id) {
                    c.base = base.clone();
                    c.a = old.clone();
                    c.b = next.clone();
                }
            }
            let next = merged
                .map(|v| {
                    super::stable::denormalize(&v).map(|plain| super::stable::normalize(&plain))
                })
                .transpose()?;
            if op.delta.is_none() && op.next.is_none() && op.next_object.is_none() {
                out.tombstones.insert(op.path.clone());
            }
            match next {
                Some(v) => {
                    out.documents.insert(op.path.clone(), v);
                }
                None => {
                    out.documents.remove(&op.path);
                }
            }
            out.provenance.insert(op.path.clone(), context);
            // Resolution is an explicit causal operation. Archives remain in immutable batches.
            for id in &op.resolves {
                out.conflicts.remove(id);
            }
        }
        super::settings::sanitize(&mut out.documents)?;
        out.frontier.insert(b.device_id.clone(), b.sequence);
        heads.insert(b.device_id.clone(), b.batch_id.clone());
    }
    Ok(out)
}
pub fn local_head(j: &Journal) -> Option<String> {
    let local = j
        .batches
        .values()
        .filter(|b| b.device_id == j.device_id)
        .max_by_key(|b| b.sequence);
    let covered = j
        .seed
        .as_ref()
        .and_then(|s| s.state.frontier.get(&j.device_id))
        .copied()
        .unwrap_or(0);
    if local.is_some_and(|b| b.sequence >= covered) {
        local.map(|b| b.batch_id.clone())
    } else {
        j.seed
            .as_ref()
            .and_then(|s| s.heads.get(&j.device_id).cloned())
    }
}
pub fn freeze_operation(op: &mut Operation, preimages: &mut BTreeMap<String, Value>) -> Res<()> {
    if bytes(op)?.len() > 256 * 1024 {
        if let Some(delta) = op.delta.take() {
            let base = preimages
                .get(&delta.base_hash)
                .ok_or("DRIVE:missing_dependency")?
                .clone();
            let next = patched(&base, &delta.patches)?;
            op.base = Some(base);
            op.next = Some(next);
        }
    }
    for (value, reference) in [
        (&mut op.base, &mut op.base_object),
        (&mut op.next, &mut op.next_object),
    ] {
        if value
            .as_ref()
            .is_some_and(|v| bytes(v).is_ok_and(|b| b.len() > 32 * 1024))
        {
            let value = value.take().unwrap();
            let h = hash(&bytes(&value)?);
            preimages.insert(h.clone(), value);
            *reference = Some(h);
        }
    }
    Ok(())
}
pub fn operation_objects(op: &Operation) -> BTreeSet<String> {
    let mut out: BTreeSet<_> = [op.base.as_ref(), op.next.as_ref()]
        .into_iter()
        .flatten()
        .filter_map(blob_hash)
        .map(str::to_string)
        .collect();
    out.extend(
        [
            op.base_object.clone(),
            op.next_object.clone(),
            op.delta.as_ref().map(|d| d.base_hash.clone()),
        ]
        .into_iter()
        .flatten(),
    );
    out
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outbox {
    pub batch: Batch,
    pub remote_id: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub schema_version: u32,
    pub vault_id: String,
    pub device_id: String,
    pub baseline: Documents,
    #[serde(default)]
    pub preimages: BTreeMap<String, Value>,
    #[serde(default)]
    pub seed: Option<ReplaySeed>,
    pub batches: BTreeMap<String, Batch>,
    pub outbox: Vec<Outbox>,
    pub cursor: Option<String>,
    #[serde(default)]
    pub capture_frontier: Frontier,
    pub inbox: BTreeSet<String>,
    pub last_verified_at: i64,
    pub apply_pending: Option<Documents>,
    #[serde(default)]
    pub apply_before: Option<Documents>,
}
impl Journal {
    pub fn load(path: &Path, vault: &str, device: &str) -> Res<Self> {
        match fs::read(path) {
            Ok(b) => {
                let j: Self = serde_json::from_slice(&b).map_err(|_| "DRIVE:journal_corrupt")?;
                if j.schema_version != 1 || j.vault_id != vault || j.device_id != device {
                    return Err("DRIVE:journal_identity".into());
                }
                if let Some(seed) = &j.seed {
                    seed.validate(vault)?;
                }
                for b in j.batches.values() {
                    b.validate(vault)?;
                }
                for o in &j.outbox {
                    o.batch.validate(vault)?;
                }
                Ok(j)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                schema_version: 1,
                vault_id: vault.into(),
                device_id: device.into(),
                ..Default::default()
            }),
            Err(_) => Err("DRIVE:journal_unreadable".into()),
        }
    }
    pub fn save(&self, path: &Path) -> Res<()> {
        let data = bytes(self)?;
        if fs::read(path).ok().as_ref() == Some(&data) {
            return Ok(());
        }
        write_atomic(path, &data)
    }
    pub fn capture(&mut self, current: &Documents) -> Res<()> {
        if self.apply_pending.is_some() {
            return Err("DRIVE:apply_recovery_required".into());
        }
        let keys: BTreeSet<_> = self.baseline.keys().chain(current.keys()).collect();
        let mut ops = vec![];
        for k in keys {
            if self.baseline.get(k) != current.get(k) {
                let base = self.baseline.get(k).cloned();
                let next = current.get(k).cloned();
                let mut op = Operation {
                    path: k.clone(),
                    delta: None,
                    base_object: None,
                    next_object: None,
                    base: base.clone(),
                    next: next.clone(),
                    resolves: vec![],
                };
                if let (Some(a), Some(b)) = (&base, &next) {
                    if blob_hash(a).is_none() && blob_hash(b).is_none() {
                        let h = hash(&bytes(a)?);
                        let mut patches = vec![];
                        diff(Some(a), Some(b), vec![], &mut patches);
                        self.preimages.insert(h.clone(), a.clone());
                        op.delta = Some(Delta {
                            base_hash: h,
                            patches,
                        });
                        op.base = None;
                        op.next = None;
                    }
                }
                freeze_operation(&mut op, &mut self.preimages)?;
                ops.push(op);
            }
        }
        if ops.is_empty() {
            return Ok(());
        }
        let mut frontier = self.capture_frontier.clone();
        // Multiple queued captures are included in batches, even before remote ack.
        let mut previous = local_head(self);
        let mut chunks = vec![];
        while !ops.is_empty() {
            let mut chunk = vec![];
            let mut size = 0;
            while !ops.is_empty() && chunk.len() < 200 {
                let n = bytes(&ops[0])?.len();
                if n > MAX_BATCH / 2 {
                    return Err("DRIVE:item_too_large".into());
                }
                if size + n > 512 * 1024 && !chunk.is_empty() {
                    break;
                }
                size += n;
                chunk.push(ops.remove(0));
            }
            chunks.push(chunk);
        }
        let group_id = uuid::Uuid::new_v4().to_string();
        let count = u32::try_from(chunks.len()).map_err(|_| "DRIVE:atomic_group_invalid")?;
        if count > 1000 {
            return Err("DRIVE:atomic_group_invalid".into());
        }
        for (index, chunk) in chunks.into_iter().enumerate() {
            let seq = frontier
                .get(&self.device_id)
                .copied()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or("DRIVE:sequence_exhausted")?;
            let objects: BTreeSet<_> = chunk.iter().flat_map(operation_objects).collect();
            let b = Batch {
                protocol: "nevis-drive-sync".into(),
                schema_version: 1,
                vault_id: self.vault_id.clone(),
                device_id: self.device_id.clone(),
                sequence: seq,
                previous_batch_id: previous,
                seen_frontier: frontier.clone(),
                operations: chunk,
                atomic_group: Some(AtomicGroup {
                    id: group_id.clone(),
                    index: index as u32,
                    count,
                }),
                required_objects: objects,
                batch_id: String::new(),
            }
            .seal()?;
            previous = Some(b.batch_id.clone());
            frontier.insert(self.device_id.clone(), seq);
            self.batches.insert(b.batch_id.clone(), b.clone());
            self.outbox.push(Outbox {
                batch: b,
                remote_id: None,
            });
        }
        self.capture_frontier = frontier;
        self.baseline = current.clone();
        Ok(())
    }
    pub fn ingest(&mut self, b: Batch) -> Res<()> {
        b.validate(&self.vault_id)?;
        if self.batches.values().any(|old| {
            old.device_id == b.device_id && old.sequence == b.sequence && old.batch_id != b.batch_id
        }) {
            return Err("DRIVE:device_id_collision".into());
        }
        self.batches.insert(b.batch_id.clone(), b);
        Ok(())
    }
}
pub fn blob_hash(v: &Value) -> Option<&str> {
    v.get("$nevisBlob").and_then(Value::as_str)
}
pub fn gc_plan(j: &Journal) -> Value {
    json!({"destructiveEnabled":false,"candidates":0,"retainedBatches":j.batches.len(),"reason":"GC_DEFERRED: cold-restore coverage and stale-device rebase proof required"})
}
