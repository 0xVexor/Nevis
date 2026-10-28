//! Device-local retry records. A durable prepare owns a single-document commit;
//! every participating writer recovers it under the vault's OS lock first.
use crate::vault::{check_id, err, write_atomic, Res, Vault};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}, sync::OnceLock};

static LOCAL: OnceLock<PathBuf> = OnceLock::new();

pub fn configure(app_data: &Path) -> Res<()> {
    let base = app_data.join("document-operations");
    ensure_dir(&base)?;
    LOCAL.set(base).map_err(|_| "Document operation storage already configured".into())
}

fn sync_dir(path: &Path) -> Res<()> {
    #[cfg(unix)]
    fs::File::open(path).map_err(err)?.sync_all().map_err(err)?;
    #[cfg(not(unix))]
    let _ = path; // Windows: file flush + atomic rename; no portable directory fsync.
    Ok(())
}
fn ensure_dir(path: &Path) -> Res<()> {
    if path.is_dir() { return Ok(()); }
    let parent = path.parent().ok_or("Invalid operation directory")?;
    ensure_dir(parent)?;
    fs::create_dir(path).or_else(|e| if path.is_dir() { Ok(()) } else { Err(e) }).map_err(err)?;
    sync_dir(parent)
}
fn durable_write(path: &Path, value: &Value) -> Res<()> {
    let dir = path.parent().ok_or("Invalid operation directory")?;
    ensure_dir(dir)?;
    write_atomic(path, value.to_string().as_bytes())?;
    sync_dir(dir)
}
fn read(path: &Path) -> Res<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(err)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn token(value: &Value, key: &str) -> Res<String> {
    let s = value[key].as_str().ok_or("Invalid document operation record")?;
    if s.is_empty() || s.len() > 128 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("Invalid document operation identity".into());
    }
    Ok(s.to_string())
}
fn operation_name(scope: &str, id: &str) -> Res<String> {
    let keys = serde_json::json!({"scopeId":scope,"operationId":id});
    token(&keys, "scopeId")?; token(&keys, "operationId")?;
    Ok(format!("{:x}.json", Sha256::digest(format!("{scope}/{id}").as_bytes())))
}
fn validate(record: &Value) -> Res<(String, String)> {
    if record["format"] != 1 { return Err("Unsupported document operation format".into()); }
    let scope = token(record, "scopeId")?;
    let operation = token(record, "operationId")?;
    let id = record["after"]["id"].as_str().ok_or("Page without id")?;
    check_id(id)?;
    let before = &record["before"];
    let receipt = &record["receipt"];
    let fingerprint = record["fingerprint"].as_str().unwrap_or_default();
    if !record["after"].is_object() || (!before.is_null() && before["id"] != id)
        || receipt["documentId"] != id || receipt["operationId"] != operation
        || !receipt["committedAt"].is_number() || !revision(&receipt["revision"])
        || (if before.is_null() { !receipt["beforeRevision"].is_null() } else { !revision(&receipt["beforeRevision"]) })
        || fingerprint.len() != 67 || !fingerprint.starts_with("o1:") || !fingerprint[3..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid document operation record".into());
    }
    Ok((operation_name(&scope, &operation)?, id.to_string()))
}
fn revision(value: &Value) -> bool {
    value.as_str().is_some_and(|s| (67..=131).contains(&s.len()) && s.starts_with("r1:") && s[3..].bytes().all(|b| b.is_ascii_hexdigit()))
}
fn local_dir(root: &Path) -> Res<Option<PathBuf>> {
    let Some(base) = LOCAL.get() else { return Ok(None); };
    if fs::canonicalize(base).map_err(err)?.starts_with(fs::canonicalize(root).map_err(err)?) {
        return Err("Document operation records must be outside the vault".into());
    }
    let marker = read(&root.join(".noviq/vault.json"))?.ok_or("Missing vault identity")?;
    let id = marker["id"].as_str().filter(|s| !s.is_empty()).ok_or("Missing vault identity")?;
    // Vault identity survives a folder move. Local records never travel with that folder.
    Ok(Some(base.join(format!("{:x}", Sha256::digest(id.as_bytes())))))
}

fn recover_at(root: &Path, local: &Path) -> Res<()> {
    let pending = local.join("pending");
    if !pending.exists() { return Ok(()); }
    for entry in fs::read_dir(&pending).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let record = read(&path)?.ok_or("Missing prepared operation")?;
        let (name, id) = validate(&record)?;
        if path.file_name() != Some(std::ffi::OsStr::new(&name)) { return Err("Invalid prepared operation path".into()); }
        let done = local.join("committed").join(name);
        if let Some(committed) = read(&done)? {
            if committed != record { return Err("Conflicting document operation record".into()); }
        } else {
            let page_path = root.join("pages").join(format!("{id}.json"));
            let current = read(&page_path)?.unwrap_or(Value::Null);
            if current != record["after"] {
                if current != record["before"] { return Err("Document operation recovery conflict; snapshots retained".into()); }
                durable_write(&page_path, &record["after"])?;
            } else { sync_dir(&root.join("pages"))?; }
            durable_write(&done, &record)?;
        }
        fs::remove_file(&path).map_err(err)?;
        sync_dir(&pending)?;
    }
    Ok(())
}

/** Called only after the shared OS commit lock has been acquired. */
pub fn recover_locked(root: &Path) -> Res<()> {
    if let Some(local) = local_dir(root)? { recover_at(root, &local)?; }
    Ok(())
}
pub fn find(vault: &Vault, scope: &str, operation: &str) -> Res<Option<Value>> {
    let _guard = crate::vault::commit_lock(&vault.root)?;
    let local = local_dir(&vault.root)?.ok_or("Document operation storage is unavailable")?;
    read(&local.join("committed").join(operation_name(scope, operation)?))
}
fn commit_at(root: &Path, local: &Path, record: &Value) -> Res<Value> {
    recover_at(root, local)?;
    let (name, id) = validate(record)?;
    let done = local.join("committed").join(&name);
    if let Some(prior) = read(&done)? {
        if prior["fingerprint"] != record["fingerprint"] { return Err("Document operation ID reused with different payload".into()); }
        return Ok(prior["receipt"].clone());
    }
    let page_path = root.join("pages").join(format!("{id}.json"));
    if read(&page_path)?.unwrap_or(Value::Null) != record["before"] { return Err("Document revision conflict".into()); }
    let pending = local.join("pending").join(name);
    durable_write(&pending, record)?; // complete content/metadata + original receipt before touching the note
    // From here, a failed/lost response is indeterminate: recovery finishes the accepted prepare.
    recover_at(root, local)?;
    Ok(record["receipt"].clone())
}
pub fn commit(vault: &Vault, record: &Value) -> Res<Value> {
    let _guard = crate::vault::commit_lock(&vault.root)?;
    vault.resolve_conflicts_locked();
    let local = local_dir(&vault.root)?.ok_or("Document operation storage is unavailable")?;
    commit_at(&vault.root, &local, record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (PathBuf, PathBuf, Value) {
        let base = std::env::temp_dir().join(format!("nevis-receipts-{}", uuid::Uuid::new_v4()));
        let root = base.join("vault"); let local = base.join("private");
        fs::create_dir_all(root.join("pages")).unwrap();
        let record = json!({"format":1,"scopeId":"grant","operationId":"append","fingerprint":format!("o1:{}","a".repeat(64)),
            "before":{"id":"note","title":"before","content":{"custom":"RTL فارسی"}},
            "after":{"id":"note","title":"after","content":{"custom":"RTL فارسی appended"}},
            "receipt":{"operationId":"append","documentId":"note","beforeRevision":format!("r1:{}","b".repeat(64)),"revision":format!("r1:{}","c".repeat(64)),"committedAt":1}});
        durable_write(&root.join("pages/note.json"), &record["before"]).unwrap();
        (root, local, record)
    }
    #[test]
    fn receipt_recovery_handles_crash_before_and_after_page_install_and_later_edits() {
        for installed in [false, true] {
            let (root, local, record) = fixture();
            let name = validate(&record).unwrap().0;
            durable_write(&local.join("pending").join(&name), &record).unwrap();
            if installed { durable_write(&root.join("pages/note.json"), &record["after"]).unwrap(); }
            recover_at(&root, &local).unwrap();
            assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), record["after"]);
            let later = json!({"id":"note","title":"human edit"});
            durable_write(&root.join("pages/note.json"), &later).unwrap();
            // Crash after the committed receipt, before pending cleanup: do not replay over later content.
            durable_write(&local.join("pending").join(&name), &record).unwrap();
            recover_at(&root, &local).unwrap();
            assert_eq!(commit_at(&root, &local, &record).unwrap(), record["receipt"]);
            assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), later);
            let mut different = record.clone(); different["fingerprint"] = json!(format!("o1:{}","b".repeat(64)));
            assert!(commit_at(&root, &local, &different).unwrap_err().contains("different payload"));
            assert!(!root.join("document-operations").exists());
            fs::remove_dir_all(root.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn receipt_recovery_create_conflict_and_failed_prepare_preserve_snapshots() {
        let (root, local, mut record) = fixture();
        fs::write(&local, b"blocked journal directory").unwrap();
        assert!(commit_at(&root, &local, &record).is_err());
        assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), record["before"]);
        fs::remove_file(&local).unwrap();
        record["before"] = Value::Null;
        record["receipt"]["beforeRevision"] = Value::Null;
        fs::remove_file(root.join("pages/note.json")).unwrap();
        assert_eq!(commit_at(&root, &local, &record).unwrap(), record["receipt"]);
        assert_eq!(commit_at(&root, &local, &record).unwrap(), record["receipt"]);
        let mut next = record.clone(); next["operationId"] = json!("next"); next["receipt"]["operationId"] = json!("next");
        let pending = local.join("pending").join(validate(&next).unwrap().0);
        durable_write(&pending, &next).unwrap();
        durable_write(&root.join("pages/note.json"), &json!({"id":"note","title":"external"})).unwrap();
        assert!(recover_at(&root, &local).unwrap_err().contains("recovery conflict"));
        assert!(pending.exists());
        assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap()["title"], "external");
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }
}
