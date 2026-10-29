//! Immutable manifest-last restore points. Pruning remains fail-closed.
use super::super::snapshot::{self, Bundle, Files};
use super::{
    auth,
    core::{self, bytes, valid_hash, Frontier, Journal, Materialized, ReplaySeed},
    transport::{verify, Drive},
    Binding,
};
use crate::vault::{err, write_atomic, Res};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub protocol: String,
    pub schema_version: u32,
    pub vault_id: String,
    pub frontier: Frontier,
    pub heads: BTreeMap<String, String>,
    pub covered_batches: BTreeMap<String, String>,
    pub audit_tombstones: BTreeSet<String>,
    pub provenance: BTreeMap<String, Frontier>,
    pub inventory: BTreeMap<String, String>,
    pub retained_objects: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_archive: Option<String>,
    pub tombstones: BTreeSet<String>,
    pub created_at: i64,
    pub manifest_digest: String,
}
impl Checkpoint {
    pub fn from_journal(
        vault: &str,
        bundle: &Bundle,
        journal: &Journal,
        created_at: i64,
    ) -> Res<Self> {
        if bundle.manifest.vault != vault || journal.vault_id != vault {
            return Err("DRIVE:checkpoint_identity".into());
        }
        if super::settings::cloud_bundle(bundle)?.manifest != bundle.manifest {
            return Err("DRIVE:checkpoint_contains_device_values".into());
        }
        let (heads, covered_batches) = core::coverage(journal)?;
        let materialized = core::replay_seeded(
            vault,
            &journal.batches,
            &journal.preimages,
            journal.seed.as_ref(),
        )?;
        if super::documents(bundle)?.0 != materialized.documents {
            return Err("DRIVE:checkpoint_local_changed".into());
        }
        let archive_hash = snapshot::hash(&encode_history(&core::history(journal)?)?);
        let mut m = Self {
            protocol: "nevis-drive-sync".into(),
            schema_version: 1,
            vault_id: vault.into(),
            frontier: journal.capture_frontier.clone(),
            heads,
            covered_batches,
            audit_tombstones: materialized.tombstones,
            provenance: materialized.provenance,
            inventory: bundle.manifest.files.clone(),
            replay_archive: Some(archive_hash.clone()),
            retained_objects: journal
                .batches
                .values()
                .flat_map(|b| b.required_objects.iter().cloned())
                .chain(
                    journal
                        .seed
                        .iter()
                        .flat_map(|s| s.retained_objects.iter().cloned()),
                )
                .chain(bundle.manifest.files.values().cloned())
                .chain(std::iter::once(archive_hash))
                .collect(),
            tombstones: bundle.manifest.tombstones.clone(),
            created_at,
            manifest_digest: String::new(),
        };
        m.manifest_digest = m.digest()?;
        m.validate(vault)?;
        Ok(m)
    }
    fn digest(&self) -> Res<String> {
        let mut m = self.clone();
        m.manifest_digest.clear();
        Ok(snapshot::hash(&bytes(&m)?))
    }
    pub fn validate(&self, vault: &str) -> Res<()> {
        if bytes(self)?.len() > 4 * 1024 * 1024 {
            return Err("DRIVE:checkpoint_limit".into());
        }
        if self.protocol != "nevis-drive-sync"
            || self.schema_version != 1
            || self.vault_id != vault
            || self.manifest_digest != self.digest()?
        {
            return Err("DRIVE:checkpoint_integrity".into());
        }
        core::validate_coverage(&self.frontier, &self.heads, &self.covered_batches)?;
        if self
            .replay_archive
            .as_ref()
            .is_some_and(|h| !valid_hash(h) || !self.retained_objects.contains(h))
            || self.retained_objects.iter().any(|h| !valid_hash(h))
            || self
                .inventory
                .values()
                .any(|h| !self.retained_objects.contains(h))
        {
            return Err("DRIVE:checkpoint_inventory".into());
        }
        for p in &self.audit_tombstones {
            snapshot::safe_path(p)?;
        }
        let mut names = BTreeSet::new();
        for (p, h) in &self.inventory {
            snapshot::safe_path(p)?;
            if !valid_hash(h)
                || !names.insert(p.to_ascii_lowercase())
                || self.tombstones.contains(p)
            {
                return Err("DRIVE:checkpoint_inventory".into());
            }
        }
        for p in &self.tombstones {
            snapshot::safe_path(p)?;
        }
        Ok(())
    }
}
const MAX_HISTORY: u64 = 95 * 1024 * 1024;
pub(crate) fn encode_history(history: &core::ReplayHistory) -> Res<Vec<u8>> {
    use std::io::Write;
    let raw = bytes(history)?;
    if raw.len() as u64 > MAX_HISTORY {
        return Err("DRIVE:checkpoint_replay_limit".into());
    }
    let mut encoder = flate2::GzBuilder::new()
        .mtime(0)
        .operating_system(255)
        .write(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).map_err(err)?;
    encoder.finish().map_err(err)
}
fn decode_history(raw: &[u8]) -> Res<core::ReplayHistory> {
    decode_history_bounded(raw, MAX_HISTORY)
}
fn decode_history_bounded(raw: &[u8], limit: u64) -> Res<core::ReplayHistory> {
    use std::io::Read;
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(raw)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "DRIVE:checkpoint_replay_integrity")?;
    if bytes.len() as u64 > limit {
        return Err("DRIVE:checkpoint_replay_limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "DRIVE:checkpoint_replay_integrity".into())
}
pub fn due(frontier: &Frontier, last: Option<&Checkpoint>, now: i64) -> bool {
    let Some(last) = last else {
        return true;
    };
    let batches: u64 = frontier
        .iter()
        .map(|(d, n)| n.saturating_sub(last.frontier.get(d).copied().unwrap_or(0)))
        .sum();
    batches >= 1000 || now.saturating_sub(last.created_at) >= 24 * 3600 * 1000
}
pub fn publish(
    d: &mut Drive,
    b: &Binding,
    state: &Path,
    bundle: &Bundle,
    journal: &Journal,
) -> Res<String> {
    if auth::subject()? != b.subject {
        return Err("DRIVE:account_mismatch".into());
    }
    let safe = super::settings::cloud_bundle(bundle)?;
    let bundle = &safe;
    let files = bundle.decode_metadata()?;
    for (p, data) in &files {
        let h = bundle.manifest.files.get(p).ok_or("DRIVE:integrity")?;
        d.object_with_state(&b.objects_id, &b.vault_id, h, Some(data), state)?;
        write_atomic(&state.join("journal.objects").join(h), data)?;
    }
    let m = Checkpoint::from_journal(&b.vault_id, bundle, journal, crate::vault::now_ms())?;
    let archive = encode_history(&core::history(journal)?)?;
    let archive_hash = m
        .replay_archive
        .as_ref()
        .ok_or("DRIVE:checkpoint_replay_required")?;
    if snapshot::hash(&archive) != *archive_hash {
        return Err("DRIVE:checkpoint_replay_integrity".into());
    }
    write_atomic(&state.join("journal.objects").join(archive_hash), &archive)?;
    for (path, source) in &bundle.sources {
        let h = bundle.manifest.files.get(path).ok_or("DRIVE:integrity")?;
        d.object_file(&b.objects_id, &b.vault_id, h, source, true, state)?;
    }
    // Keep old preimages and conflict/history media on disk, without materializing their bytes.
    for h in &m.retained_objects {
        let target = state.join("journal.objects").join(h);
        if !target.exists() {
            if let Some(value) = journal.preimages.get(h) {
                write_atomic(&target, &bytes(value)?)?;
            }
        }
        let local = target.exists();
        d.object_file(&b.objects_id, &b.vault_id, h, &target, local, state)?;
    }
    // Independently reconstruct and validate from remote bytes before the publication marker.
    let restored = restore(d, b, &m, state)?;
    if restored.manifest != bundle.manifest {
        return Err("DRIVE:cold_restore_mismatch".into());
    }
    let pending = state.join("checkpoint-pending.json");
    let receipt = if pending.exists() {
        let old: Value = serde_json::from_slice(&fs::read(&pending).map_err(err)?)
            .map_err(|_| "DRIVE:checkpoint_pending_corrupt")?;
        let old_manifest: Checkpoint = serde_json::from_value(old["manifest"].clone())
            .map_err(|_| "DRIVE:checkpoint_pending_corrupt")?;
        old_manifest.validate(&b.vault_id)?;
        old
    } else {
        let r = json!({"id":d.generate_id()?,"manifest":m});
        write_atomic(&pending, &bytes(&r)?)?;
        r
    };
    let manifest: Checkpoint = serde_json::from_value(receipt["manifest"].clone())
        .map_err(|_| "DRIVE:checkpoint_pending_corrupt")?;
    restore(d, b, &manifest, state)?;
    d.put(
        receipt["id"]
            .as_str()
            .ok_or("DRIVE:checkpoint_pending_corrupt")?,
        &b.checkpoints_id,
        "checkpoint",
        &b.vault_id,
        &manifest.manifest_digest,
        &bytes(&manifest)?,
    )?;
    write_atomic(&state.join("checkpoint-last.json"), &bytes(&manifest)?)?;
    fs::remove_file(pending).map_err(err)?;
    Ok(manifest.manifest_digest)
}
pub fn list(d: &mut Drive, b: &Binding) -> Res<Value> {
    let rows=d.list(&format!("trashed = false and '{}' in parents and appProperties has {{ key='nevisKind' and value='checkpoint' }}",b.checkpoints_id))?;
    let mut out = vec![];
    for r in rows {
        let id = r["id"].as_str().ok_or("DRIVE:invalid_metadata")?;
        let h = r["appProperties"]["sha256"]
            .as_str()
            .ok_or("DRIVE:invalid_metadata")?;
        let key = r["appProperties"]["nevisKey"]
            .as_str()
            .ok_or("DRIVE:invalid_metadata")?;
        verify(&r, &b.checkpoints_id, "checkpoint", &b.vault_id, key, h)?;
        let m: Checkpoint = serde_json::from_slice(&d.download(id, h, 8 * 1024 * 1024)?)
            .map_err(|_| "DRIVE:checkpoint_corrupt")?;
        m.validate(&b.vault_id)?;
        if m.manifest_digest != key {
            return Err("DRIVE:checkpoint_integrity".into());
        }
        out.push(json!({"id":id,"digest":h,"checkpointId":key,"createdAt":m.created_at,"files":m.inventory.len(),"frontier":m.frontier}));
    }
    Ok(json!(out))
}
pub fn read(d: &mut Drive, b: &Binding, id: &str) -> Res<Checkpoint> {
    let r = d.metadata(id)?;
    let h = r["appProperties"]["sha256"]
        .as_str()
        .ok_or("DRIVE:invalid_metadata")?;
    let k = r["appProperties"]["nevisKey"]
        .as_str()
        .ok_or("DRIVE:invalid_metadata")?;
    verify(&r, &b.checkpoints_id, "checkpoint", &b.vault_id, k, h)?;
    let m: Checkpoint = serde_json::from_slice(&d.download(id, h, 8 * 1024 * 1024)?)
        .map_err(|_| "DRIVE:checkpoint_corrupt")?;
    m.validate(&b.vault_id)?;
    if m.manifest_digest != k {
        return Err("DRIVE:checkpoint_integrity".into());
    }
    Ok(m)
}
pub fn restore(d: &mut Drive, b: &Binding, m: &Checkpoint, state: &Path) -> Res<Bundle> {
    m.validate(&b.vault_id)?;
    let mut files = Files::new();
    let mut sources = BTreeMap::new();
    for (p, h) in &m.inventory {
        if p.starts_with("files/") && !p.ends_with(".json") {
            let target = state.join("journal.objects").join(h);
            d.object_file(&b.objects_id, &b.vault_id, h, &target, false, state)?;
            sources.insert(p.clone(), target);
        } else {
            let data = d.object(&b.objects_id, &b.vault_id, h, None)?;
            snapshot::validate(p, &data)?;
            write_atomic(&state.join("journal.objects").join(h), &data)?;
            files.insert(p.clone(), data);
        }
    }
    super::database::validate(&files)?;
    let mut bundle = Bundle::new(&b.vault_id, &files, m.tombstones.clone());
    bundle.sources = sources;
    for p in bundle.sources.keys() {
        bundle
            .manifest
            .files
            .insert(p.clone(), m.inventory[p].clone());
    }
    bundle.decode_metadata()?;
    Ok(bundle)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_archive_is_deterministic_bounded_and_integrity_checked() {
        use std::io::Write;
        let history = core::ReplayHistory::default();
        let a = encode_history(&history).unwrap();
        assert_eq!(a, encode_history(&history).unwrap());
        assert_eq!(decode_history(&a).unwrap(), history);
        let mut corrupt = a.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(decode_history(&corrupt).is_err());
        let mut zip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        zip.write_all(&vec![b'x'; 2048]).unwrap();
        assert_eq!(
            decode_history_bounded(&zip.finish().unwrap(), 1024).unwrap_err(),
            "DRIVE:checkpoint_replay_limit"
        );
    }
    #[test]
    fn incomparable_checkpoints_never_choose_the_latest_timestamp() {
        let base = Checkpoint {
            protocol: "nevis-drive-sync".into(),
            schema_version: 1,
            vault_id: "vault".into(),
            frontier: Frontier::new(),
            heads: Default::default(),
            covered_batches: Default::default(),
            audit_tombstones: Default::default(),
            provenance: Default::default(),
            inventory: Default::default(),
            replay_archive: None,
            retained_objects: Default::default(),
            tombstones: Default::default(),
            created_at: 0,
            manifest_digest: "a".into(),
        };
        let mut left = base.clone();
        left.frontier.insert("A".into(), 1);
        let mut right = base.clone();
        right.frontier.insert("B".into(), 1);
        right.created_at = 999_999;
        assert!(dominant(&[left.clone(), right.clone()]).is_none());
        let mut merged = base;
        merged.frontier = Frontier::from([("A".into(), 1), ("B".into(), 1)]);
        merged.manifest_digest = "merged".into();
        let all = [left, right, merged];
        assert_eq!(dominant(&all).unwrap().manifest_digest, "merged");
    }
    #[test]
    fn manifest_hash_paths_and_tamper_rejected() {
        let mut m = Checkpoint {
            protocol: "nevis-drive-sync".into(),
            schema_version: 1,
            vault_id: "vault".into(),
            frontier: Frontier::default(),
            heads: Default::default(),
            covered_batches: Default::default(),
            audit_tombstones: Default::default(),
            provenance: Default::default(),
            inventory: BTreeMap::from([("kv/tags.json".into(), snapshot::hash(b"[]"))]),
            replay_archive: None,
            retained_objects: BTreeSet::from([snapshot::hash(b"[]")]),
            tombstones: BTreeSet::new(),
            created_at: 0,
            manifest_digest: String::new(),
        };
        m.manifest_digest = m.digest().unwrap();
        m.validate("vault").unwrap();
        let mut oversized = m.clone();
        oversized
            .inventory
            .insert("kv/settings.json".into(), "x".repeat(5 * 1024 * 1024));
        assert_eq!(
            oversized.validate("vault").unwrap_err(),
            "DRIVE:checkpoint_limit"
        );
        let mut tampered = m.clone();
        tampered.frontier.insert("a".into(), 1);
        assert!(tampered.validate("vault").is_err());
        m.inventory.insert("../secret".into(), snapshot::hash(b"x"));
        m.manifest_digest = m.digest().unwrap();
        assert!(m.validate("vault").is_err());
    }
}

/// Choose only a checkpoint whose causal frontier dominates every candidate.
/// Incomparable checkpoints require retained-stream replay; timestamps never select state.
pub fn dominant<'a>(candidates: &'a [Checkpoint]) -> Option<&'a Checkpoint> {
    let mut choices: Vec<_> = candidates
        .iter()
        .filter(|candidate| {
            candidates.iter().all(|other| {
                other
                    .frontier
                    .iter()
                    .all(|(d, n)| candidate.frontier.get(d).copied().unwrap_or(0) >= *n)
            })
        })
        .collect();
    if let Some(first) = choices.first() {
        if choices.iter().any(|c| {
            c.frontier == first.frontier
                && (c.inventory != first.inventory
                    || c.covered_batches != first.covered_batches
                    || c.retained_objects != first.retained_objects)
        }) {
            return None;
        }
    }
    choices.sort_by(|a, b| a.manifest_digest.cmp(&b.manifest_digest));
    choices.into_iter().next()
}
pub fn seed(
    manifest: &Checkpoint,
    bundle: &Bundle,
    history: core::ReplayHistory,
) -> Res<ReplaySeed> {
    if manifest.replay_archive.as_ref() != Some(&snapshot::hash(&encode_history(&history)?)) {
        return Err("DRIVE:checkpoint_replay_integrity".into());
    }
    manifest.validate(&bundle.manifest.vault)?;
    if manifest.inventory != bundle.manifest.files
        || manifest.tombstones != bundle.manifest.tombstones
    {
        return Err("DRIVE:checkpoint_inventory".into());
    }
    let (documents, _) = super::documents(bundle)?;
    let mut conflicts = BTreeMap::new();
    let decode = |v: &Value, path: &str| -> Res<Option<Value>> {
        if v.is_null() {
            return Ok(None);
        }
        let b = B64
            .decode(v.as_str().ok_or("DRIVE:checkpoint_conflict")?)
            .map_err(|_| "DRIVE:checkpoint_conflict")?;
        let value: Value = serde_json::from_slice(&b).map_err(|_| "DRIVE:checkpoint_conflict")?;
        Ok(Some(
            if path.starts_with("files/") && !path.ends_with(".json") {
                value
            } else {
                super::stable::normalize(&value)
            },
        ))
    };
    for (path, data) in bundle.decode_metadata()? {
        if !path.starts_with("conflicts/") {
            continue;
        }
        let archive: Value =
            serde_json::from_slice(&data).map_err(|_| "DRIVE:checkpoint_conflict")?;
        if archive["provider"] != "drive" {
            continue;
        }
        let id = archive["id"]
            .as_str()
            .ok_or("DRIVE:checkpoint_conflict")?
            .to_string();
        if path != format!("conflicts/{id}.json") {
            return Err("DRIVE:checkpoint_conflict".into());
        }
        let conflict_path = archive["path"]
            .as_str()
            .ok_or("DRIVE:checkpoint_conflict")?;
        let c = core::Conflict {
            id: id.clone(),
            path: archive["path"]
                .as_str()
                .ok_or("DRIVE:checkpoint_conflict")?
                .into(),
            pointer: archive["pointer"].as_str().unwrap_or("").into(),
            base: decode(&archive["base"], &conflict_path)?,
            a: decode(&archive["local"], &conflict_path)?,
            b: decode(&archive["remote"], &conflict_path)?,
        };
        if conflicts.insert(id, c).is_some() {
            return Err("DRIVE:checkpoint_conflict".into());
        }
    }
    let seed = ReplaySeed {
        history: Some(history),
        vault_id: manifest.vault_id.clone(),
        state: Materialized {
            documents,
            frontier: manifest.frontier.clone(),
            conflicts,
            tombstones: manifest.audit_tombstones.clone(),
            provenance: manifest.provenance.clone(),
        },
        heads: manifest.heads.clone(),
        covered_batches: manifest.covered_batches.clone(),
        retained_objects: manifest.retained_objects.clone(),
    };
    seed.validate(&manifest.vault_id)?;
    Ok(seed)
}
pub fn bootstrap(d: &mut Drive, b: &Binding, state: &Path) -> Res<Option<super::Bootstrap>> {
    let rows=d.list(&format!("trashed = false and '{}' in parents and appProperties has {{ key='nevisKind' and value='checkpoint' }}",b.checkpoints_id))?;
    let mut candidates = vec![];
    for row in rows {
        let id = row["id"].as_str().ok_or("DRIVE:invalid_metadata")?;
        match read(d, b, id) {
            Ok(m) if m.replay_archive.is_some() => candidates.push(m),
            Ok(_) => continue,
            Err(e) if e.starts_with("DRIVE:checkpoint_") || e == "DRIVE:integrity" => continue,
            Err(e) => return Err(e),
        }
    }
    let Some(selected) = dominant(&candidates) else {
        return Ok(None);
    };
    match restore(d, b, selected, state) {
        Ok(bundle) => {
            let objects = super::documents(&bundle)?.1;
            for h in &selected.retained_objects {
                let target = state.join("journal.objects").join(h);
                if !target.exists() {
                    d.object_file(&b.objects_id, &b.vault_id, h, &target, false, state)?;
                }
            }
            let archive_hash = selected
                .replay_archive
                .as_ref()
                .ok_or("DRIVE:checkpoint_replay_required")?;
            let archive_path = state.join("journal.objects").join(archive_hash);
            if fs::metadata(&archive_path).map_err(err)?.len() > MAX_HISTORY + 1024 * 1024 {
                return Err("DRIVE:checkpoint_replay_limit".into());
            }
            let archive = fs::read(archive_path).map_err(err)?;
            if snapshot::hash(&archive) != *archive_hash {
                return Err("DRIVE:integrity".into());
            }
            let seed = seed(selected, &bundle, decode_history(&archive)?)?;
            Ok(Some(super::Bootstrap { seed, objects }))
        }
        Err(e)
            if e == "DRIVE:missing_dependency"
                || e == "DRIVE:integrity"
                || e == "DRIVE:remote_unavailable" =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    }
}
