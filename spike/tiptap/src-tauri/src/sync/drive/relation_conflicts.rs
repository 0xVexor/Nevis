//! Explicit decisions for concurrent relation links. No arbitrary link wins a cardinality constraint.
#[cfg(test)]
use super::core::Documents;
use super::{
    core::{self, bytes, Journal, Materialized},
    snapshot::Bundle,
};
use crate::vault::{now_ms, Res};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
#[derive(Clone)]
struct Edge {
    path: String,
    value: Value,
    from: String,
    to: String,
}
#[derive(Clone)]
struct Group {
    id: String,
    definition: Value,
    edges: Vec<Edge>,
}
fn edge_label(edge: &Edge, state: &Materialized) -> Value {
    let title = |id: &str| {
        state
            .documents
            .get(&format!("pages/{id}.json"))
            .and_then(|p| p["title"].as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .chars()
            .take(160)
            .collect::<String>()
    };
    json!({"id":edge.value["id"],"from":title(&edge.from),"to":title(&edge.to)})
}
fn groups(state: &Materialized) -> Res<Vec<Group>> {
    let mut out = vec![];
    for (def_path, definition) in state
        .documents
        .iter()
        .filter(|(p, v)| p.starts_with("databases/relations/") && v["deletedAt"].is_null())
    {
        let id = definition["id"].as_str().ok_or("DRIVE:db_identity")?;
        let symmetric = definition["mode"] == "self_symmetric";
        let one = !symmetric && definition["cardinality"] == "one";
        let inverse_one = !symmetric && definition["inverseCardinality"] == "one";
        let edges: Vec<_> = state
            .documents
            .iter()
            .filter(|(p, v)| {
                p.starts_with("databases/edges/")
                    && v["deletedAt"].is_null()
                    && v["definitionId"] == id
            })
            .map(|(path, value)| {
                value["id"].as_str().ok_or("DRIVE:db_identity")?;
                Ok(Edge {
                    path: path.clone(),
                    value: value.clone(),
                    from: value["fromPageId"]
                        .as_str()
                        .ok_or("DRIVE:db_reference_invalid")?
                        .into(),
                    to: value["toPageId"]
                        .as_str()
                        .ok_or("DRIVE:db_reference_invalid")?
                        .into(),
                })
            })
            .collect::<Res<_>>()?;
        let mut parent: Vec<_> = (0..edges.len()).collect();
        fn root(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i {
                let next = parent[i];
                parent[i] = parent[next];
                i = next;
            }
            i
        }
        let mut keys: BTreeMap<(u8, String, String), usize> = BTreeMap::new();
        for (i, e) in edges.iter().enumerate() {
            let mut constraints = vec![(0, e.from.clone(), e.to.clone())];
            if one {
                constraints.push((1, e.from.clone(), String::new()));
            }
            if inverse_one {
                constraints.push((2, e.to.clone(), String::new()));
            }
            for key in constraints {
                if let Some(previous) = keys.insert(key, i) {
                    let a = root(&mut parent, previous);
                    let b = root(&mut parent, i);
                    parent[b] = a;
                }
            }
        }
        let mut components: BTreeMap<usize, Vec<Edge>> = BTreeMap::new();
        for (i, edge) in edges.into_iter().enumerate() {
            components
                .entry(root(&mut parent, i))
                .or_default()
                .push(edge);
        }
        for edges in components.into_values().filter(|edges| edges.len() > 1) {
            let provenance: BTreeMap<_, _> = edges
                .iter()
                .map(|e| (e.path.clone(), state.provenance.get(&e.path)))
                .chain(std::iter::once((
                    def_path.clone(),
                    state.provenance.get(def_path),
                )))
                .collect();
            let content: Vec<_> = edges.iter().map(|e| (&e.path, &e.value)).collect();
            let id = super::snapshot::hash(&bytes(&json!([
                "relation-constraint",
                definition,
                content,
                provenance
            ]))?);
            out.push(Group {
                id,
                definition: definition.clone(),
                edges,
            });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}
fn plan(group: &Group, preferred: &str) -> Res<BTreeSet<String>> {
    let preferred = group
        .edges
        .iter()
        .position(|e| e.value["id"] == preferred)
        .ok_or("DRIVE:conflict_changed")?;
    let symmetric = group.definition["mode"] == "self_symmetric";
    let one = !symmetric && group.definition["cardinality"] == "one";
    let inverse_one = !symmetric && group.definition["inverseCardinality"] == "one";
    let mut from = BTreeSet::new();
    let mut to = BTreeSet::new();
    let mut pairs = BTreeSet::new();
    let mut kept = BTreeSet::new();
    for edge in std::iter::once(&group.edges[preferred]).chain(
        group
            .edges
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != preferred)
            .map(|(_, e)| e),
    ) {
        if (one && from.contains(&edge.from))
            || (inverse_one && to.contains(&edge.to))
            || pairs.contains(&(edge.from.clone(), edge.to.clone()))
        {
            continue;
        }
        from.insert(edge.from.clone());
        to.insert(edge.to.clone());
        pairs.insert((edge.from.clone(), edge.to.clone()));
        kept.insert(edge.path.clone());
    }
    Ok(kept)
}
fn digest(group: &Group, preferred: &str, kept: &BTreeSet<String>) -> Res<String> {
    Ok(super::snapshot::hash(&bytes(&json!([
        group.id, preferred, kept
    ]))?))
}
pub fn list(state: &Materialized) -> Res<Value> {
    Ok(Value::Array(groups(state)?.iter().map(|g|json!({"id":g.id,"definitionId":g.definition["id"],"choices":g.edges.iter().map(|e|edge_label(e,state)).collect::<Vec<_>>()})).collect()))
}
pub fn preview(state: &Materialized, id: &str, preferred: &str) -> Res<Value> {
    let group = groups(state)?
        .into_iter()
        .find(|g| g.id == id)
        .ok_or("DRIVE:conflict_changed")?;
    let kept = plan(&group, preferred)?;
    Ok(
        json!({"id":id,"preferred":preferred,"digest":digest(&group,preferred,&kept)?,"kept":group.edges.iter().filter(|e|kept.contains(&e.path)).map(|e|edge_label(e,state)).collect::<Vec<_>>(),"archived":group.edges.iter().filter(|e|!kept.contains(&e.path)).map(|e|edge_label(e,state)).collect::<Vec<_>>()}),
    )
}
fn record_decision(
    j: &mut Journal,
    state: &Materialized,
    id: &str,
    preferred: &str,
    expected: &str,
) -> Res<usize> {
    let group = groups(state)?
        .into_iter()
        .find(|g| g.id == id)
        .ok_or("DRIVE:conflict_changed")?;
    let kept = plan(&group, preferred)?;
    if digest(&group, preferred, &kept)? != expected {
        return Err("DRIVE:conflict_changed".into());
    }
    let mut desired = state.documents.clone();
    let at = now_ms();
    for edge in &group.edges {
        if !kept.contains(&edge.path) {
            let value = desired.get_mut(&edge.path).unwrap();
            value["deletedAt"] = json!(at);
            value["updatedAt"] = json!(at);
            if let Some(revision) = value["revision"].as_u64() {
                value["revision"] = json!(revision
                    .checked_add(1)
                    .ok_or("DRIVE:db_revision_overflow")?);
            }
        }
    }
    let native_baseline = j.baseline.clone();
    j.baseline = state.documents.clone();
    j.capture_frontier = state.frontier.clone();
    j.capture(&desired)?;
    let pending = j.outbox.last_mut().ok_or("DRIVE:conflict_changed")?;
    let previous_id = pending.batch.batch_id.clone();
    pending
        .batch
        .operations
        .last_mut()
        .ok_or("DRIVE:conflict_changed")?
        .resolves
        .push(id.into());
    pending.batch = pending.batch.clone().seal()?;
    j.batches.remove(&previous_id);
    j.batches
        .insert(pending.batch.batch_id.clone(), pending.batch.clone());
    j.baseline = native_baseline;
    let resolved = core::replay_seeded(&j.vault_id, &j.batches, &j.preimages, j.seed.as_ref())?;
    Ok(groups(&resolved)?.len())
}
pub fn state(data: &Path, vault: &str) -> Res<Materialized> {
    let j = Journal::load(
        &super::dir(data, vault).join("journal.json"),
        vault,
        &super::device(data)?,
    )?;
    core::replay_seeded(vault, &j.batches, &j.preimages, j.seed.as_ref())
}
pub struct Decision {
    pub after: Option<Bundle>,
    pub remaining: usize,
}
pub fn resolve(
    data: &Path,
    vault: &str,
    id: &str,
    preferred: &str,
    expected: &str,
    current: &Bundle,
) -> Res<Decision> {
    let path = super::dir(data, vault).join("journal.json");
    let mut j = Journal::load(&path, vault, &super::device(data)?)?;
    let (docs, blobs) = super::documents(current)?;
    j.capture(&docs)?;
    let state = core::replay_seeded(vault, &j.batches, &j.preimages, j.seed.as_ref())?;
    let remaining = record_decision(&mut j, &state, id, preferred, expected)?;
    j.save(&path)?;
    if remaining > 0 {
        return Ok(Decision {
            after: None,
            remaining,
        });
    }
    let state = core::replay_seeded(vault, &j.batches, &j.preimages, j.seed.as_ref())?;
    let after = super::bundle(vault, &state, current, |h| {
        let destination = path.with_extension("objects").join(h);
        if !destination.exists() {
            if let Some(bytes) = blobs.get(h) {
                crate::vault::write_atomic(&destination, bytes)?;
            } else {
                for (p, source) in &current.sources {
                    if current
                        .manifest
                        .files
                        .get(p)
                        .is_some_and(|value| value == h)
                    {
                        super::streaming::copy_verified(source, &destination, h)?;
                        break;
                    }
                }
            }
        }
        if destination.exists() {
            Ok(destination)
        } else {
            Err("DRIVE:missing_dependency".into())
        }
    })?;
    j.apply_before = Some(docs);
    j.apply_pending = Some(super::documents(&after)?.0);
    j.save(&path)?;
    Ok(Decision {
        after: Some(after),
        remaining: 0,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Journal, Materialized) {
        let vault = "11111111-1111-4111-8111-111111111111";
        let device = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let root =
            std::env::temp_dir().join(format!("nevis-relation-pure-{}", uuid::Uuid::new_v4()));
        let mut j = Journal::load(&root.join("journal.json"), vault, device).unwrap();
        let docs = Documents::from([
            (
                "databases/relations/r.json".into(),
                json!({"id":"r","cardinality":"one","inverseCardinality":"many","mode":"one_way"}),
            ),
            (
                "databases/edges/a.json".into(),
                json!({"id":"a","definitionId":"r","fromPageId":"from","toPageId":"left","deletedAt":null}),
            ),
            (
                "databases/edges/b.json".into(),
                json!({"id":"b","definitionId":"r","fromPageId":"from","toPageId":"right","deletedAt":null}),
            ),
            (
                "databases/edges/independent.json".into(),
                json!({"id":"independent","definitionId":"r","fromPageId":"another","toPageId":"elsewhere","deletedAt":null}),
            ),
        ]);
        j.capture(&docs).unwrap();
        let state = core::replay(vault, &j.batches, &j.preimages).unwrap();
        (j, state)
    }
    #[test]
    fn explicit_link_decision_keeps_all_candidates_and_unrelated_links() {
        let (mut j, state) = fixture();
        let conflicts = list(&state).unwrap();
        assert_eq!(conflicts.as_array().unwrap().len(), 1);
        let id = conflicts[0]["id"].as_str().unwrap();
        let p = preview(&state, id, "b").unwrap();
        assert_eq!(p["kept"].as_array().unwrap().len(), 1);
        record_decision(&mut j, &state, id, "b", p["digest"].as_str().unwrap()).unwrap();
        let result = core::replay(&j.vault_id, &j.batches, &j.preimages).unwrap();
        assert!(list(&result).unwrap().as_array().unwrap().is_empty());
        assert!(result.documents["databases/edges/b.json"]["deletedAt"].is_null());
        assert!(!result.documents["databases/edges/a.json"]["deletedAt"].is_null());
        assert!(result.documents["databases/edges/independent.json"]["deletedAt"].is_null());
        assert_eq!(result.documents.len(), state.documents.len());
        assert!(j
            .outbox
            .last()
            .unwrap()
            .batch
            .operations
            .iter()
            .any(|op| op.resolves.contains(&id.to_string())));
    }
    #[test]
    fn stale_link_preview_is_never_applied() {
        let (mut j, state) = fixture();
        let before = bytes(&j).unwrap();
        let conflicts = list(&state).unwrap();
        assert_eq!(
            record_decision(
                &mut j,
                &state,
                conflicts[0]["id"].as_str().unwrap(),
                "b",
                "stale"
            )
            .unwrap_err(),
            "DRIVE:conflict_changed"
        );
        assert_eq!(bytes(&j).unwrap(), before);
    }
}
