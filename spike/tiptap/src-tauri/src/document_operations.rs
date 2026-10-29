//! Device-local retry records. A durable prepare owns a single-document commit;
//! every participating writer recovers it under the vault's OS lock first.
use crate::vault::{check_id, err, write_atomic, Res, Vault};
use serde_json::Value;
use base64::Engine;
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
// Attachment bytes remain in the durable prepare until recovery has installed both
// file and metadata. A page must never become visible before its files exist.
fn validated_assets(record: &Value) -> Res<Vec<(String, Vec<u8>, String, String)>> {
    let Some(value) = record.get("assets") else { return Ok(vec![]); };
    let assets = value.as_array().filter(|rows| !rows.is_empty() && rows.len() <= 20).ok_or("Invalid document attachments")?;
    let mut result = vec![];
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    fn bounded(value: &Value, depth: usize, count: &mut usize) -> bool {
        *count += 1;
        if depth > 32 || *count > 20000 { return false; }
        match value {
            Value::Array(rows) => rows.iter().all(|child| bounded(child, depth + 1, count)),
            Value::Object(rows) => rows.values().all(|child| bounded(child, depth + 1, count)),
            _ => true,
        }
    }
    for asset in assets {
        let object = asset.as_object().ok_or("Invalid document attachment")?;
        if object.len() != 4 || !["id", "data", "mimeType", "name"].iter().all(|key| object.contains_key(*key)) { return Err("Invalid document attachment".into()); }
        let id = asset["id"].as_str().filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).ok_or("Invalid attachment identity")?;
        if !seen.insert(id) { return Err("Duplicate document attachment".into()); }
        let name = asset["name"].as_str().filter(|name| name.chars().count() <= 256).ok_or("Invalid attachment name")?;
        let mime = asset["mimeType"].as_str().ok_or("Invalid attachment type")?;
        let data = asset["data"].as_str().filter(|data| !data.is_empty() && data.len() <= 262144).ok_or("Invalid attachment data")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "Invalid attachment encoding")?;
        total += bytes.len();
        if total > 196608 || format!("{:x}", Sha256::digest(&bytes)) != id { return Err("Invalid attachment digest or size".into()); }
        let valid = match mime {
            "image/png" => bytes.starts_with(&[137,80,78,71,13,10,26,10]),
            "image/jpeg" => bytes.starts_with(&[255,216,255]),
            "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            "application/vnd.excalidraw+json" => serde_json::from_slice::<Value>(&bytes).is_ok_and(|scene|
                scene["type"] == "excalidraw" && scene["elements"].is_array() && bounded(&scene, 0, &mut 0)),
            _ => false,
        };
        if !valid { return Err("Invalid attachment content type".into()); }
        result.push((id.to_string(), bytes, mime.to_string(), name.to_string()));
    }
    Ok(result)
}
fn install_assets(root: &Path, record: &Value) -> Res<()> {
    let vault = Vault { root: root.to_path_buf() };
    for (id, bytes, mime, name) in validated_assets(record)? {
        let dir = root.join("files").join(&id[..2]);
        ensure_dir(&dir)?;
        let path = dir.join(&id);
        // Repair an interrupted or corrupt file even when its byte length matches.
        if fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) { write_atomic(&path, &bytes)?; }
        vault.file_put(&id, &bytes, &mime, &name, record["receipt"]["committedAt"].as_i64().ok_or("Invalid attachment timestamp")?)?;
        sync_dir(&dir)?;
    }
    Ok(())
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
        || !receipt["committedAt"].as_u64().is_some_and(|n| n <= 9_007_199_254_740_991) || !revision(&receipt["revision"])
        || (if before.is_null() { !receipt["beforeRevision"].is_null() } else { !revision(&receipt["beforeRevision"]) })
        || fingerprint.len() != 67 || !fingerprint.starts_with("o1:") || !fingerprint[3..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid document operation record".into());
    }
    if let Some(history) = record.get("history") {
        if before.is_null() || history["pageId"] != id || history["ts"].as_i64().is_none()
            || history["title"] != before["title"] || history["content"] != before["content"] {
            return Err("Invalid document operation history".into());
        }
    }
    if record.get("undoOf").is_some() {
        token(record, "undoOf")?;
        if before.is_null() { return Err("Invalid undo origin".into()); }
    }
    if let Some(flag) = record.get("requireNoChildren") {
        if flag != &Value::Bool(true) || before.is_null() || !record["after"]["deletedAt"].as_u64().is_some_and(|n| n <= 9_007_199_254_740_991) { return Err("Invalid undo precondition".into()); }
    }
    validated_assets(record)?;
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

fn check_children(root: &Path, record: &Value) -> Res<()> {
    if record.get("requireNoChildren") != Some(&Value::Bool(true)) { return Ok(()); }
    if record["before"].is_null() || !record["after"]["deletedAt"].is_number() { return Err("Invalid undo precondition".into()); }
    for entry in fs::read_dir(root.join("pages")).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        if let Some(page) = read(&path)? {
            if page["parentId"] == record["after"]["id"] && page.get("deletedAt") == Some(&Value::Null) { return Err("Document revision conflict".into()); }
        }
    }
    Ok(())
}

fn check_creation(root: &Path, record: &Value) -> Res<()> {
    let Some(expected) = record.get("creation") else { return Ok(()); };
    if !record["before"].is_null() || expected["parentId"] != record["after"]["parentId"] { return Err("Invalid document creation precondition".into()); }
    let mut pages = std::collections::BTreeMap::<String, Value>::new();
    for entry in fs::read_dir(root.join("pages")).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).filter(|id| check_id(id).is_ok()) else { continue; };
        if let Some(page) = read(&path)? { pages.insert(id.to_string(), page); }
    }
    let mut ancestors = vec![];
    let mut seen = std::collections::BTreeSet::new();
    let mut parent = record["after"]["parentId"].clone();
    while !parent.is_null() {
        let id = parent.as_str().ok_or("Document revision conflict")?;
        let page = pages.get(id).ok_or("Document revision conflict")?;
        if page.get("deletedAt") != Some(&Value::Null) || page.get("parentId").is_none()
            || !seen.insert(id.to_string()) || ancestors.len() >= 128 { return Err("Document revision conflict".into()); }
        ancestors.push(serde_json::json!({"id":id,"parentId":page["parentId"],"deletedAt":null}));
        parent = page["parentId"].clone();
    }
    let parent = &record["after"]["parentId"];
    let mut siblings = vec![]; let mut max_sort: Option<i64> = None;
    for (id, page) in pages.iter().filter(|(_, page)| page.get("parentId") == Some(parent)) {
        let sort = page["sort"].as_f64().filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).ok_or("Document revision conflict")? as i64;
        siblings.push(serde_json::json!({"id":id,"sort":sort}));
        max_sort = Some(max_sort.map_or(sort, |previous| previous.max(sort)));
    }
    let sort = max_sort.map_or(0, |value| value.saturating_add(1));
    if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&sort) { return Err("Document revision conflict".into()); }
    let actual = serde_json::json!({"parentId":parent,"ancestors":ancestors,"siblings":siblings});
    if actual != *expected || record["after"]["sort"].as_f64() != Some(sort as f64) { return Err("Document revision conflict".into()); }
    Ok(())
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
            if current != record["after"] && current != record["before"] {
                return Err("Document operation recovery conflict; snapshots retained".into());
            }
            if current != record["after"] { check_children(root, &record).map_err(|_| "Document undo recovery conflict; snapshots retained".to_string())?; }
            if current != record["after"] { check_creation(root, &record).map_err(|_| "Document creation recovery conflict; snapshots retained".to_string())?; }
            install_assets(root, &record)?;
            if let Some(history) = record.get("history") {
                let ts = history["ts"].as_i64().ok_or("Invalid operation history")?;
                let path = root.join("history").join(&id).join(format!("{ts}.json"));
                if let Some(previous) = read(&path)? {
                    if previous != *history { return Err("Document operation history recovery conflict".into()); }
                } else { durable_write(&path, history)?; }
            }
            if current != record["after"] {
                if current != record["before"] { return Err("Document operation recovery conflict; snapshots retained".into()); }
                durable_write(&page_path, &record["after"])?;
            } else { sync_dir(&root.join("pages"))?; }
            durable_write(&done, &record)?;
        }
        fs::remove_file(&path).map_err(err)?;
        sync_dir(&pending)?;
        Vault { root: root.to_path_buf() }.trim_history(&id);
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
    find_locked(&vault.root, scope, operation)
}
/// The caller must hold the vault commit lock; do not reacquire it during admission.
pub fn find_locked(root: &Path, scope: &str, operation: &str) -> Res<Option<Value>> {
    let local = local_dir(root)?.ok_or("Document operation storage is unavailable")?;
    let record = read(&local.join("committed").join(operation_name(scope, operation)?))?;
    if let Some(record) = &record { validate(record)?; }
    Ok(record)
}
// Stream private records and retain at most 40 metadata entries; no snapshot bodies cross IPC.
fn list_at(local: &Path, scope: &str, document_id: &str) -> Res<Value> {
    operation_name(scope, "history")?;
    check_id(document_id)?;
    let dir = local.join("committed");
    let mut rows = Vec::<Value>::new();
    if !dir.exists() { return Ok(serde_json::json!([])); }
    for entry in fs::read_dir(dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let record = read(&path)?.ok_or("Missing document operation")?;
        if record["scopeId"] != scope || record["after"]["id"] != document_id { continue; }
        validate(&record)?;
        let receipt = &record["receipt"];
        rows.push(serde_json::json!({"operationId":receipt["operationId"],"documentId":receipt["documentId"],
            "beforeRevision":receipt["beforeRevision"],"revision":receipt["revision"],"committedAt":receipt["committedAt"]}));
        rows.sort_by(|a, b| b["committedAt"].as_f64().partial_cmp(&a["committedAt"].as_f64()).unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a["operationId"].as_str().cmp(&b["operationId"].as_str())));
        rows.truncate(40);
    }
    Ok(serde_json::json!(rows))
}
pub fn list(vault: &Vault, scope: &str, document_id: &str) -> Res<Value> {
    let _guard = crate::vault::commit_lock(&vault.root)?;
    let local = local_dir(&vault.root)?.ok_or("Document operation storage is unavailable")?;
    list_at(&local, scope, document_id)
}
fn commit_at(root: &Path, local: &Path, record: &Value) -> Res<Value> {
    Ok(commit_at_result(root, local, record)?.0)
}
fn commit_at_result(root: &Path, local: &Path, record: &Value) -> Res<(Value, bool)> {
    commit_at_result_authorized(root, local, record, |_, _| Ok(()))
}
fn commit_at_result_authorized<G>(root: &Path, local: &Path, record: &Value, authorize: impl FnOnce(&Path, &Value) -> Res<G>) -> Res<(Value, bool)> {
    recover_at(root, local)?;
    let (name, id) = validate(record)?;
    let done = local.join("committed").join(&name);
    if let Some(prior) = read(&done)? {
        if prior["fingerprint"] != record["fingerprint"] { return Err("Document operation ID reused with different payload".into()); }
        return Ok((prior["receipt"].clone(), true));
    }
    let page_path = root.join("pages").join(format!("{id}.json"));
    if read(&page_path)?.unwrap_or(Value::Null) != record["before"] { return Err("Document revision conflict".into()); }
    check_children(root, record)?;
    check_creation(root, record)?;
    let mut record = record.clone();
    if record.get("history").is_some() {
        let history_dir = root.join("history").join(&id);
        let mut ts = record["history"]["ts"].as_i64().ok_or("Invalid operation history")?;
        if history_dir.exists() {
            for entry in fs::read_dir(&history_dir).map_err(err)? {
                let path = entry.map_err(err)?.path();
                if let Some(previous) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<i64>().ok()) { ts = ts.max(previous.saturating_add(1)); }
            }
        }
        if !(0..=9_007_199_254_740_991).contains(&ts) { return Err("Invalid operation history clock".into()); }
        record["history"]["ts"] = serde_json::json!(ts);
    }
    let pending = local.join("pending").join(name);
    let permission = authorize(root, &record)?;
    durable_write(&pending, &record)?; // complete content/metadata + original receipt before touching the note
    drop(permission); // durable prepare is the admission point; later cancellation cannot undo an accepted commit
    // From here, a failed/lost response is indeterminate: recovery finishes the accepted prepare.
    recover_at(root, local)?;
    Ok((record["receipt"].clone(), false))
}
pub fn commit(vault: &Vault, record: &Value) -> Res<Value> {
    let _guard = crate::vault::commit_lock(&vault.root)?;
    vault.resolve_conflicts_locked();
    let local = local_dir(&vault.root)?.ok_or("Document operation storage is unavailable")?;
    commit_at(&vault.root, &local, record)
}
pub fn commit_result(vault: &Vault, record: &Value) -> Res<Value> {
    commit_result_authorized(vault, record, |_, _| Ok(()))
}
pub fn commit_result_authorized<G>(vault: &Vault, record: &Value, authorize: impl FnOnce(&Path, &Value) -> Res<G>) -> Res<Value> {
    let _guard = crate::vault::commit_lock(&vault.root)?;
    vault.resolve_conflicts_locked();
    let local = local_dir(&vault.root)?.ok_or("Document operation storage is unavailable")?;
    let (receipt, replayed) = commit_at_result_authorized(&vault.root, &local, record, authorize)?;
    vault.trim_history(record["after"]["id"].as_str().ok_or("Page without id")?);
    Ok(serde_json::json!({"receipt":receipt,"replayed":replayed}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (PathBuf, PathBuf, Value) {
        let base = std::env::temp_dir().join(format!("nevis-receipts-{}", uuid::Uuid::new_v4()));
        let root = base.join("vault"); let local = base.join("private");
        fs::create_dir_all(root.join("pages")).unwrap();
        fs::create_dir_all(root.join(".noviq")).unwrap();
        let record = json!({"format":1,"scopeId":"grant","operationId":"append","fingerprint":format!("o1:{}","a".repeat(64)),
            "before":{"id":"note","title":"before","content":{"custom":"RTL فارسی"}},
            "after":{"id":"note","title":"after","content":{"custom":"RTL فارسی appended"}},
            "history":{"pageId":"note","ts":2,"title":"before","content":{"custom":"RTL فارسی"}},
            "receipt":{"operationId":"append","documentId":"note","beforeRevision":format!("r1:{}","b".repeat(64)),"revision":format!("r1:{}","c".repeat(64)),"committedAt":1}});
        durable_write(&root.join("pages/note.json"), &record["before"]).unwrap();
        (root, local, record)
    }
    #[test]
    fn retained_history_lists_bounded_scoped_metadata_without_snapshot_bodies() {
        let (root, local, record) = fixture();
        for index in 0..42 {
            let mut record = record.clone();
            record["operationId"] = json!(format!("history-{index:02}"));
            record["receipt"]["operationId"] = record["operationId"].clone();
            record["receipt"]["committedAt"] = json!(index);
            if index == 41 { record["scopeId"] = json!("other"); }
            let name = validate(&record).unwrap().0;
            durable_write(&local.join("committed").join(name), &record).unwrap();
        }
        let listed = list_at(&local, "grant", "note").unwrap();
        let rows = listed.as_array().unwrap();
        assert_eq!(rows.len(), 40);
        assert_eq!(rows[0]["operationId"], "history-40");
        assert_eq!(rows[39]["operationId"], "history-01");
        assert!(rows.iter().all(|row| row.get("before").is_none() && row.get("after").is_none() && row.get("evidence").is_none()));
        assert_eq!(list_at(&local, "grant", "missing").unwrap(), json!([]));
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }
    #[test]
    fn attachment_recovery_installs_verified_bytes_before_document_and_rejects_corruption() {
        let (root, local, mut record) = fixture();
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let id = format!("{:x}", Sha256::digest(bytes));
        record["assets"] = json!([{ "id":id, "mimeType":"image/png", "name":"fixture.png",
            "data":base64::engine::general_purpose::STANDARD.encode(bytes) }]);
        let mut bad = record.clone(); bad["assets"][0]["id"] = json!("a".repeat(64));
        assert!(commit_at(&root, &local, &bad).unwrap_err().contains("digest"));
        bad = record.clone(); bad["assets"][0]["mimeType"] = json!("image/jpeg");
        assert!(commit_at(&root, &local, &bad).unwrap_err().contains("content type"));
        assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), record["before"]);
        let file = root.join("files").join(&id[..2]).join(&id);
        ensure_dir(file.parent().unwrap()).unwrap();
        fs::write(&file, vec![0; bytes.len()]).unwrap();
        let pending = local.join("pending").join(validate(&record).unwrap().0);
        durable_write(&pending, &record).unwrap();
        recover_at(&root, &local).unwrap();
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert_eq!(read(&file.with_extension("json")).unwrap().unwrap()["type"], "image/png");
        assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), record["after"]);
        assert!(commit_at_result(&root, &local, &record).unwrap().1);
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }
    #[test]
    fn retained_history_creation_undo_guards_children_at_commit_and_recovery() {
        let (root, local, mut record) = fixture();
        record["requireNoChildren"] = json!(true);
        record["after"]["deletedAt"] = json!(2);
        let child = json!({"id":"child","parentId":"note","deletedAt":null});
        durable_write(&root.join("pages/child.json"), &child).unwrap();
        assert!(commit_at(&root, &local, &record).unwrap_err().contains("revision conflict"));
        assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), record["before"]);
        let pending = local.join("pending").join(validate(&record).unwrap().0);
        durable_write(&pending, &record).unwrap();
        assert!(recover_at(&root, &local).unwrap_err().contains("undo recovery conflict"));
        assert!(pending.exists());
        fs::remove_file(root.join("pages/child.json")).unwrap();
        recover_at(&root, &local).unwrap();
        assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), record["after"]);
        assert_eq!(list_at(&local, "grant", "note").unwrap().as_array().unwrap().len(), 1);
        assert!(commit_at_result(&root, &local, &record).unwrap().1);
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
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
            assert_eq!(read(&root.join("history/note/2.json")).unwrap().unwrap(), record["history"]);
            let vault = Vault { root: root.clone() };
            let ui_history = json!({"pageId":"note","ts":2,"title":"after","content":record["after"]["content"]});
            vault.version_add(&ui_history).unwrap();
            vault.version_add(&ui_history).unwrap();
            assert_eq!(vault.versions_list("note").unwrap().len(), 2);
            assert_eq!(read(&root.join("history/note/2.json")).unwrap().unwrap(), record["history"]);
            let later = json!({"id":"note","title":"human edit"});
            durable_write(&root.join("pages/note.json"), &later).unwrap();
            // Crash after the committed receipt, before pending cleanup: do not replay over later content.
            durable_write(&local.join("pending").join(&name), &record).unwrap();
            recover_at(&root, &local).unwrap();
            let (receipt, replayed) = commit_at_result(&root, &local, &record).unwrap();
            assert_eq!(receipt, record["receipt"]); assert!(replayed);
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
        record.as_object_mut().unwrap().remove("history");
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
    #[test]
    fn create_checks_sibling_and_parent_preconditions_before_prepare_and_deduplicates_after_commit() {
        let (root, local, mut record) = fixture();
        let parent = serde_json::json!({"id":"parent","parentId":null,"sort":7,"deletedAt":null});
        fs::remove_file(root.join("pages/note.json")).unwrap();
        durable_write(&root.join("pages/parent.json"), &parent).unwrap();
        record["before"] = Value::Null; record["receipt"]["beforeRevision"] = Value::Null;
        record.as_object_mut().unwrap().remove("history");
        record["after"]["id"] = serde_json::json!("created"); record["receipt"]["documentId"] = serde_json::json!("created");
        record["after"]["parentId"] = Value::Null; record["after"]["sort"] = serde_json::json!(8);
        record["creation"] = serde_json::json!({"parentId":null,"ancestors":[],"siblings":[{"id":"parent","sort":7}]});
        assert!(!commit_at_result(&root, &local, &record).unwrap().1);
        assert!(commit_at_result(&root, &local, &record).unwrap().1);
        let mut stale = record.clone(); stale["operationId"] = serde_json::json!("next"); stale["receipt"]["operationId"] = serde_json::json!("next");
        stale["after"]["id"] = serde_json::json!("other"); stale["receipt"]["documentId"] = serde_json::json!("other");
        assert!(commit_at_result(&root, &local, &stale).unwrap_err().contains("revision conflict"));
        stale["after"]["parentId"] = serde_json::json!("parent"); stale["after"]["sort"] = serde_json::json!(0);
        stale["creation"] = serde_json::json!({"parentId":"parent","ancestors":[{"id":"parent","parentId":null,"deletedAt":null}],"siblings":[]});
        let mut trashed = parent.clone(); trashed["deletedAt"] = serde_json::json!(1);
        durable_write(&root.join("pages/parent.json"), &trashed).unwrap();
        assert!(commit_at_result(&root, &local, &stale).unwrap_err().contains("revision conflict"));
        assert!(!root.join("pages/other.json").exists());
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }
    #[test]
    fn admission_failure_precedes_durable_prepare_and_leaves_no_partial_save() {
        let (root, local, record) = fixture();
        let result = commit_at_result_authorized(&root, &local, &record, |_, _| Err::<(), _>("Write admission access denied".to_string()));
        assert!(result.unwrap_err().contains("access denied"));
        assert!(!local.join("pending").exists());
        assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), record["before"]);
        assert_eq!(commit_at_result_authorized(&root, &local, &record, |_, _| Ok(())).unwrap().1, false);
        assert_eq!(read(&root.join("pages/note.json")).unwrap().unwrap(), record["after"]);
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

}
