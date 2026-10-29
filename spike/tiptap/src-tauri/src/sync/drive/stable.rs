//! Versioned deterministic legacy identity migration; caller creates a verified backup first.
use super::super::snapshot;
use crate::vault::{err, write_atomic, Res, Vault};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
fn assign(node: &mut Value, page: &str, path: &str, seen: &mut BTreeSet<String>) -> Res<()> {
    let kind = node["type"].as_str().unwrap_or("").to_string();
    if !inline_kind(&kind) && kind != "doc" && !kind.is_empty() {
        let id = node["attrs"]["stableBlockId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "v1-{}",
                    &snapshot::hash(format!("nevis-block-v1/{page}/{path}/{kind}").as_bytes())
                        [..32]
                )
            });
        if !seen.insert(id.clone()) {
            return Err("DRIVE:duplicate_block_identity".into());
        }
        if node.get("attrs").is_none() || node["attrs"].is_null() {
            node["attrs"] = json!({});
        }
        node["attrs"]["stableBlockId"] = json!(id);
    }
    if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
        for (i, child) in children.iter_mut().enumerate() {
            assign(child, page, &format!("{path}/{i}"), seen)?;
        }
    }
    Ok(())
}
pub fn migrate(v: &Vault) -> Res<()> {
    let marker = v.root.join(".noviq/drive-block-schema.json");
    for (p, b) in snapshot::read_metadata(v)? {
        if !p.starts_with("pages/") {
            continue;
        }
        let mut value: Value = serde_json::from_slice(&b).map_err(err)?;
        if value["content"].is_object() {
            let page = value["id"]
                .as_str()
                .ok_or("DRIVE:invalid_page")?
                .to_string();
            assign(&mut value["content"], &page, "", &mut BTreeSet::new())?;
            let bytes = super::core::bytes(&value)?;
            snapshot::validate(&p, &bytes)?;
            snapshot::checked_parents(&v.root, &p)?;
            write_atomic(&v.root.join(p), &bytes)?;
        }
    }
    write_atomic(
        &marker,
        &super::core::bytes(
            &json!({"version":1,"identity":"nevis-block-v1","requiresDriveCompatibleClient":true}),
        )?,
    )
}
fn inline_kind(kind: &str) -> bool {
    matches!(
        kind,
        "text" | "hardBreak" | "mathInline" | "inlineIcon" | "pageLink"
    )
}
/// A page-wide registry separates a node's location from its rich-text payload.
/// Moving a node between parents must not turn into deletion plus an unrelated copy.
fn tree(v: &Value) -> Option<Value> {
    if v["type"] != "doc" {
        return None;
    }
    let children = v.get("content")?.as_array()?;
    let mut nodes = serde_json::Map::new();
    let mut orders = serde_json::Map::new();
    fn siblings(
        children: &[Value],
        parent: &str,
        nodes: &mut serde_json::Map<String, Value>,
        orders: &mut serde_json::Map<String, Value>,
    ) -> Option<()> {
        let mut ids = vec![];
        for node in children {
            if inline_kind(node["type"].as_str()?) {
                return None;
            }
            let id = node["attrs"]["stableBlockId"].as_str()?.to_string();
            if id.is_empty() || nodes.contains_key(&id) {
                return None;
            }
            let mut value = node.clone();
            let structural = node
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|a| {
                    a.is_empty()
                        || a.iter().all(|n| {
                            n["attrs"]["stableBlockId"].is_string()
                                && !inline_kind(n["type"].as_str().unwrap_or(""))
                        })
                });
            if structural {
                value.as_object_mut()?.remove("content");
            }
            nodes.insert(
                id.clone(),
                json!({"parent":parent,"value":value,"children":structural}),
            );
            ids.push(id.clone());
            if structural {
                siblings(node["content"].as_array()?, &id, nodes, orders)?;
            }
        }
        orders.insert(parent.into(), json!(ids));
        Some(())
    }
    siblings(children, "$root", &mut nodes, &mut orders)?;
    let mut root = v.clone();
    root.as_object_mut()?.remove("content");
    Some(json!({"$nevisTreeV1":{"root":root,"nodes":nodes,"orders":orders}}))
}
// Legacy arrays remain readable; newly identified documents use the page-wide registry.
// Transform identified sibling arrays to maps in the wire/domain representation. Editor JSON remains unchanged.
pub fn normalize(v: &Value) -> Value {
    if let Some(t) = tree(v) {
        return t;
    }
    if v.as_object().is_some_and(|o| {
        (o.len() == 1
            && o.keys()
                .any(|k| matches!(k.as_str(), "$nevisTreeV1" | "$nevisLiteral" | "$nevisBlob")))
            || (o.len() == 2 && o.contains_key("$nevisNodes") && o.contains_key("$nevisOrder"))
    }) {
        return json!({"$nevisLiteral":v});
    }
    match v {
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), normalize(v))).collect())
        }
        Value::Array(a)
            if !a.is_empty()
                && a.iter()
                    .all(|v| v["attrs"]["stableBlockId"].as_str().is_some()) =>
        {
            let ids: Vec<_> = a
                .iter()
                .map(|v| v["attrs"]["stableBlockId"].as_str().unwrap())
                .collect();
            if ids.iter().copied().collect::<BTreeSet<_>>().len() != a.len() {
                return v.clone();
            }
            let nodes: serde_json::Map<_, _> = ids
                .iter()
                .zip(a.iter())
                .map(|(id, v)| ((*id).to_string(), normalize(v)))
                .collect();
            json!({"$nevisNodes":nodes,"$nevisOrder":ids})
        }
        Value::Array(a) => Value::Array(a.iter().map(normalize).collect()),
        _ => v.clone(),
    }
}
pub fn denormalize(v: &Value) -> Res<Value> {
    if let Some(literal) = v.get("$nevisLiteral") {
        if v.as_object().is_some_and(|o| o.len() == 1) {
            return Ok(literal.clone());
        }
    }
    if v.as_object().is_some_and(|o| o.len() == 1) {
        if let Some(t) = v.get("$nevisTreeV1") {
            return render_tree(t);
        }
    }
    match v {
        Value::Object(o)
            if o.len() == 2 && o.contains_key("$nevisNodes") && o.contains_key("$nevisOrder") =>
        {
            let nodes = o["$nevisNodes"]
                .as_object()
                .ok_or("DRIVE:invalid_block_map")?;
            let order = o["$nevisOrder"]
                .as_array()
                .ok_or("DRIVE:invalid_block_order")?;
            let mut out = vec![];
            let mut seen = BTreeSet::new();
            for id in order {
                let id = id.as_str().ok_or("DRIVE:invalid_block_order")?;
                if !seen.insert(id) {
                    return Err("DRIVE:duplicate_block_identity".into());
                }
                if let Some(n) = nodes.get(id) {
                    out.push(denormalize(n)?);
                }
            }
            // Concurrent inserts whose order lost a structural conflict are retained in stable ID order.
            for (id, node) in nodes {
                if !seen.contains(id.as_str()) {
                    out.push(denormalize(node)?);
                }
            }
            Ok(Value::Array(out))
        }
        Value::Object(o) => Ok(Value::Object(
            o.iter()
                .map(|(k, v)| Ok((k.clone(), denormalize(v)?)))
                .collect::<Res<_>>()?,
        )),
        Value::Array(a) => Ok(Value::Array(a.iter().map(denormalize).collect::<Res<_>>()?)),
        _ => Ok(v.clone()),
    }
}
pub fn validate(v: &Value) -> Res<()> {
    fn walk(v: &Value, ids: &mut BTreeSet<String>) -> Res<()> {
        if let Some(id) = v["attrs"]["stableBlockId"].as_str() {
            if !ids.insert(id.into()) {
                return Err("DRIVE:duplicate_block_identity".into());
            }
        }
        if let Some(a) = v["content"].as_array() {
            for n in a {
                walk(n, ids)?;
            }
        }
        Ok(())
    }
    if v["content"].is_object() {
        walk(&v["content"], &mut BTreeSet::new())?;
    }
    Ok(())
}

fn render_tree(t: &Value) -> Res<Value> {
    let nodes = t["nodes"]
        .as_object()
        .ok_or("DRIVE:invalid_block_registry")?;
    let orders = t["orders"].as_object().ok_or("DRIVE:invalid_block_order")?;
    if nodes.len() > 100_000 {
        return Err("DRIVE:block_limit".into());
    }
    let mut children: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (id, node) in nodes {
        let parent = node["parent"]
            .as_str()
            .ok_or("DRIVE:invalid_block_parent")?;
        if parent != "$root" && !nodes.contains_key(parent) {
            return Err("DRIVE:orphan_block".into());
        }
        if node["value"]["attrs"]["stableBlockId"] != id.as_str() {
            return Err("DRIVE:block_identity_mismatch".into());
        }
        children
            .entry(parent.into())
            .or_default()
            .insert(id.clone());
    }
    fn render(
        parent: &str,
        depth: usize,
        nodes: &serde_json::Map<String, Value>,
        orders: &serde_json::Map<String, Value>,
        children: &BTreeMap<String, BTreeSet<String>>,
        seen: &mut BTreeSet<String>,
    ) -> Res<Vec<Value>> {
        if depth > 100 {
            return Err("DRIVE:block_depth".into());
        }
        let mut pending = children.get(parent).cloned().unwrap_or_default();
        let mut ids = vec![];
        let mut order_seen = BTreeSet::new();
        if let Some(order) = orders.get(parent) {
            for value in order.as_array().ok_or("DRIVE:invalid_block_order")? {
                let id = value.as_str().ok_or("DRIVE:invalid_block_order")?;
                if !order_seen.insert(id) {
                    return Err("DRIVE:duplicate_block_identity".into());
                }
                if pending.remove(id) {
                    ids.push(id.to_string());
                }
            }
        }
        ids.extend(pending);
        let mut out = vec![];
        for id in ids {
            if !seen.insert(id.clone()) {
                return Err("DRIVE:block_cycle".into());
            }
            let record = &nodes[&id];
            let mut node = record["value"].clone();
            if !node.is_object() {
                return Err("DRIVE:invalid_block_registry".into());
            }
            if record["children"] == true {
                node["content"] = json!(render(&id, depth + 1, nodes, orders, children, seen)?);
            } else if children.get(&id).is_some_and(|c| !c.is_empty()) {
                return Err("DRIVE:invalid_block_parent".into());
            }
            out.push(node);
        }
        Ok(out)
    }
    let mut seen = BTreeSet::new();
    let mut root = t["root"].clone();
    if root["type"] != "doc" {
        return Err("DRIVE:invalid_document".into());
    }
    root["content"] = json!(render("$root", 0, nodes, orders, &children, &mut seen)?);
    if seen.len() != nodes.len() {
        return Err("DRIVE:block_cycle".into());
    }
    Ok(root)
}
/// Restore missing ancestors from preserved candidates. New children must never become orphans.
/// Cyclic concurrent moves revert only their locations to a known valid candidate, retaining an archive.
pub fn repair_structure(page: &mut Value, candidates: [Option<&Value>; 3]) -> Res<bool> {
    let Some(tree) = page
        .get_mut("content")
        .and_then(|v| v.get_mut("$nevisTreeV1"))
    else {
        return Ok(false);
    };
    let sources: Vec<_> = candidates
        .iter()
        .flatten()
        .filter_map(|v| v.get("content")?.get("$nevisTreeV1"))
        .collect();
    let nodes = tree["nodes"]
        .as_object_mut()
        .ok_or("DRIVE:invalid_block_registry")?;
    let mut repaired = false;
    let mut restore_orders = BTreeMap::new();
    for _ in 0..=100 {
        let missing: BTreeSet<_> = nodes
            .values()
            .filter_map(|n| n["parent"].as_str())
            .filter(|p| *p != "$root" && !nodes.contains_key(*p))
            .map(str::to_string)
            .collect();
        if missing.is_empty() {
            break;
        }
        for id in missing {
            let source = sources
                .iter()
                .find(|s| s["nodes"].get(&id).is_some())
                .ok_or("DRIVE:orphan_block")?;
            let original = source["nodes"]
                .as_object()
                .ok_or("DRIVE:invalid_block_registry")?;
            for (child, node) in original {
                let mut current = child.as_str();
                let mut depth = 0;
                loop {
                    if current == id {
                        nodes.entry(child.clone()).or_insert_with(|| node.clone());
                        if let Some(order) = source["orders"].get(child) {
                            restore_orders.insert(child.clone(), order.clone());
                        }
                        break;
                    }
                    if current == "$root" {
                        break;
                    }
                    current = original
                        .get(current)
                        .and_then(|n| n["parent"].as_str())
                        .ok_or("DRIVE:orphan_block")?;
                    depth += 1;
                    if depth > 100 {
                        return Err("DRIVE:block_depth".into());
                    }
                }
            }
            repaired = true;
        }
    }
    let ids: Vec<_> = nodes.keys().cloned().collect();
    let mut cycle = BTreeSet::new();
    for id in &ids {
        let mut chain = BTreeSet::new();
        let mut current = id.as_str();
        while current != "$root" {
            if !chain.insert(current.to_string()) {
                cycle.extend(chain);
                break;
            }
            current = nodes
                .get(current)
                .and_then(|n| n["parent"].as_str())
                .ok_or("DRIVE:orphan_block")?;
            if chain.len() > 100 {
                return Err("DRIVE:block_depth".into());
            }
        }
    }
    if !cycle.is_empty() {
        let source = sources
            .iter()
            .find(|s| render_tree(s).is_ok() && cycle.iter().all(|id| s["nodes"].get(id).is_some()))
            .ok_or("DRIVE:block_cycle")?;
        for id in cycle {
            nodes.get_mut(&id).unwrap()["parent"] = source["nodes"][&id]["parent"].clone();
            repaired = true;
        }
    }
    let orders = tree["orders"]
        .as_object_mut()
        .ok_or("DRIVE:invalid_block_order")?;
    for (parent, order) in restore_orders {
        orders.entry(parent).or_insert(order);
    }
    render_tree(tree)?;
    Ok(repaired)
}
