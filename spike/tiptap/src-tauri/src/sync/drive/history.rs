//! Read-only restore-point summaries, followed by an explicit fresh-identity local copy.
#[cfg(test)]
use super::core::bytes;
use super::{
    checkpoint::{self, Checkpoint},
    snapshot::{self, Bundle},
    transport::{verify, Drive},
    Binding,
};
use crate::vault::{err, Res};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::collections::BTreeMap;
fn summary(m: &Checkpoint, titles: Vec<Value>, omitted: usize) -> Value {
    let pages = m
        .inventory
        .keys()
        .filter(|p| p.starts_with("pages/"))
        .count();
    let attachments = m
        .inventory
        .keys()
        .filter(|p| p.starts_with("files/") && !p.ends_with(".json"))
        .count();
    let mut databases: BTreeMap<String, usize> = BTreeMap::new();
    for p in m.inventory.keys().filter(|p| p.starts_with("databases/")) {
        if let Some(kind) = p.split('/').nth(1) {
            *databases.entry(kind.into()).or_default() += 1;
        }
    }
    json!({"checkpointId":m.manifest_digest,"vaultId":m.vault_id,"createdAt":m.created_at,"files":m.inventory.len(),"pages":pages,"attachments":attachments,"databases":databases,"titleSample":titles,"sampleOmitted":omitted,"fullyVerified":false})
}
pub fn preview(d: &mut Drive, b: &Binding, id: &str) -> Res<Value> {
    let m = checkpoint::read(d, b, id)?;
    let mut titles = vec![];
    let mut omitted = 0;
    for (p, h) in m.inventory.iter().filter(|(p, _)| p.starts_with("pages/")) {
        if titles.len() >= 20 {
            omitted += 1;
            continue;
        }
        let rows=d.list(&format!("trashed = false and '{}' in parents and appProperties has {{ key='nevisKey' and value='{h}' }}",b.objects_id))?;
        let object = rows.first().ok_or("DRIVE:missing_dependency")?;
        verify(object, &b.objects_id, "object", &b.vault_id, h, h)?;
        let size = object["size"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or("DRIVE:invalid_metadata")?;
        if size > 512 * 1024 {
            omitted += 1;
            continue;
        }
        let raw = d.download(
            object["id"].as_str().ok_or("DRIVE:invalid_metadata")?,
            h,
            512 * 1024,
        )?;
        snapshot::validate(p, &raw)?;
        let page: Value = serde_json::from_slice(&raw).map_err(err)?;
        titles.push(json!({"id":page["id"],"title":page["title"].as_str().unwrap_or("").chars().take(200).collect::<String>(),"deleted":!page["deletedAt"].is_null()}));
    }
    Ok(summary(&m, titles, omitted))
}
pub fn as_local_copy(original: &Bundle, new_id: &str, name: &str) -> Res<Bundle> {
    uuid::Uuid::parse_str(new_id).map_err(|_| "DRIVE:invalid_vault")?;
    if original.manifest.vault == new_id {
        return Err("DRIVE:copy_requires_new_identity".into());
    }
    if name.is_empty() || name.len() > 240 {
        return Err("DRIVE:invalid_copy_name".into());
    }
    original.decode_metadata()?;
    let mut copy = original.clone();
    copy.manifest.vault = new_id.into();
    let path = "kv/workspace.json";
    let metadata = snapshot::canonical(&json!({"name":name}))?;
    copy.sources.remove(path);
    copy.bytes.insert(path.into(), B64.encode(&metadata));
    copy.manifest
        .files
        .insert(path.into(), snapshot::hash(&metadata));
    copy.manifest.tombstones.remove(path);
    copy.decode_metadata()?;
    Ok(copy)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{write_atomic, Vault};
    use std::{collections::BTreeSet, fs};
    #[test]
    fn restore_copy_preserves_original_identity_and_contents_and_has_its_own_name() {
        let root =
            std::env::temp_dir().join(format!("nevis-history-copy-{}", uuid::Uuid::new_v4()));
        let original = Vault::create(root.join("original"), "Original").unwrap();
        let page = json!({"id":original.id(),"title":"kept","content":{"type":"doc","content":[]}});
        write_atomic(
            &original.pages_dir().join(format!("{}.json", original.id())),
            &bytes(&page).unwrap(),
        )
        .unwrap();
        let before =
            super::super::streaming::capture(&original, &root.join("source-state")).unwrap();
        let copy = Vault::create(root.join("copy"), "Restored copy").unwrap();
        let desired = as_local_copy(&before, &copy.id(), "Restored copy").unwrap();
        let current = super::super::streaming::capture(&copy, &root.join("copy-state")).unwrap();
        super::super::streaming::apply(&copy, &root.join("copy-state"), &current, &desired)
            .unwrap();
        assert_ne!(copy.id(), original.id());
        assert_eq!(copy.name(), "Restored copy");
        assert_eq!(copy.pages_all().unwrap(), original.pages_all().unwrap());
        assert_eq!(
            super::super::streaming::capture(&original, &root.join("source-state"))
                .unwrap()
                .manifest,
            before.manifest
        );
        assert!(as_local_copy(&before, &original.id(), "bad").is_err());
        drop(copy);
        drop(original);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preview_counts_inventory_without_claiming_full_restore_verification() {
        let m = Checkpoint {
            protocol: "nevis-drive-sync".into(),
            schema_version: 1,
            vault_id: "vault".into(),
            frontier: Default::default(),
            heads: Default::default(),
            covered_batches: Default::default(),
            audit_tombstones: BTreeSet::new(),
            provenance: Default::default(),
            inventory: BTreeMap::from([
                ("pages/p.json".into(), "h".into()),
                ("databases/views/v.json".into(), "h".into()),
                ("files/aa/asset".into(), "h".into()),
                ("files/aa/asset.json".into(), "h".into()),
            ]),
            replay_archive: None,
            retained_objects: BTreeSet::new(),
            tombstones: BTreeSet::new(),
            created_at: 1,
            manifest_digest: "digest".into(),
        };
        let preview = summary(&m, vec![json!({"id":"p","title":"Preview"})], 0);
        assert_eq!(preview["pages"], 1);
        assert_eq!(preview["attachments"], 1);
        assert_eq!(preview["databases"]["views"], 1);
        assert_eq!(preview["fullyVerified"], false);
        assert_eq!(preview["titleSample"][0]["title"], "Preview");
    }
}
