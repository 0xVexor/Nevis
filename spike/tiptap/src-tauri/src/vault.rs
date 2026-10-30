//! The Vault: a plain folder that is the source of truth (ADR-0003). Everything here is ordinary file I/O so a
//! sync tool (Google Drive, etc.) can move files between devices; no function keeps a file open or writes in place.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub type Res<T> = Result<T, String>;

pub const KEEP_VERSIONS: usize = 40;
pub const TRASH_KEEP_MS: i64 = 7 * 24 * 3600 * 1000;

pub fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}

pub fn check_id(s: &str) -> Res<&str> {
    if is_id(s) { Ok(s) } else { Err(format!("bad id: {s}")) }
}

/// Write a file so that a reader (or a crash, or the sync client) never sees half of it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Res<()> {
    let dir = path.parent().ok_or("bad path")?;
    fs::create_dir_all(dir).map_err(err)?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("bad path")?;
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let mut f = fs::File::create(&tmp).map_err(err)?;
    f.write_all(bytes).map_err(err)?;
    f.sync_all().map_err(err)?;
    drop(f);
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })?;
    #[cfg(unix)]
    fs::File::open(dir).and_then(|d|d.sync_all()).map_err(err)?;
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn updated_at(v: &Value) -> i64 {
    v.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64
}

/// The lowercase hex SHA-256 of `b`; attachments are named by it.
pub fn sha256_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(b))
}

fn marker_id(meta: &Value) -> Res<String> {
    if meta.get("format").and_then(Value::as_u64).unwrap_or(1) != 1 {
        return Err("VAULT_UNSUPPORTED_FORMAT".into());
    }
    let id = meta["id"].as_str().filter(|id| !id.is_empty()).ok_or(VAULT_MISSING)?;
    check_id(id)?;
    Ok(id.to_string())
}
/// What is at `root`, reading only: the vault `id` ("ok"), another vault ("mismatch") or nothing ("missing").
pub fn probe(root: &Path, id: &str) -> &'static str {
    match read_json(&root.join(".noviq/vault.json")) {
        None => "missing",
        Some(m) if marker_id(&m).is_ok_and(|actual|actual==id) => "ok",
        Some(_) => "mismatch",
    }
}

pub struct Vault {
    pub root: PathBuf,
    expected_id:String,
    _lock:std::sync::Arc<crate::vault_lock::Guard>,
}

/// Error codes the UI knows (see `explain` in the web app). They are plain strings because commands return `Res<T>`.
pub const VAULT_MISSING: &str = "VAULT_MISSING"; // the folder (or its marker) is gone: moved, deleted, drive unplugged
pub const VAULT_MISMATCH: &str = "VAULT_MISMATCH"; // the folder holds another vault than the one we expected

impl Vault {
    /// Opens a vault that exists. It never creates the folder or an identity: a vault whose folder vanished must not
    /// come back as an empty vault under a new id (a sync would then take that as "everything was deleted").
    pub fn open(root: PathBuf) -> Res<Vault> {
        if !root.is_dir() || !root.join(".noviq/vault.json").is_file() {
            return Err(VAULT_MISSING.into());
        }
        for p in [&root, &root.join(".noviq"), &root.join(".noviq/vault.json"), &root.join("pages"), &root.join("files"), &root.join("databases"), &root.join("kv"), &root.join("history"), &root.join("conflicts")] {
            if fs::symlink_metadata(p).is_ok_and(|m|m.file_type().is_symlink()){return Err("STORAGE:symlink".into());}
        }
        let expected_id=marker_id(&read_json(&root.join(".noviq/vault.json")).ok_or(VAULT_MISSING)?)?;
        let lock=crate::vault_lock::acquire(&root)?;
        let v = Vault { root,expected_id,_lock:lock };
        if v.id().is_empty() {
            return Err(VAULT_MISSING.into());
        }
        v.ensure_exclusive()?;
        v.make_dirs()?;
        Ok(v)
    }

    pub fn ensure_exclusive(&self)->Res<()> {
        match probe(&self.root,&self.expected_id){"ok"=>(),"missing"=>return Err(VAULT_MISSING.into()),_=>return Err(VAULT_MISMATCH.into())}
        self._lock.check(&self.root)
    }
    /// Like `open`, and also checks that the folder is the vault `id`.
    pub fn open_as(root: PathBuf, id: &str) -> Res<Vault> {
        let v = Vault::open(root)?;
        if v.id() != id {
            return Err(VAULT_MISMATCH.into());
        }
        Ok(v)
    }

    /// The user picked a folder that may be an existing vault or just a folder: it becomes a vault (gets an identity if it has none).
    pub fn adopt(root: PathBuf) -> Res<Vault> {
        if !root.is_dir() {
            return Err(VAULT_MISSING.into());
        }
        if !root.join(".noviq/vault.json").is_file() {
            let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("Nevis").to_string();
            fs::create_dir_all(root.join(".noviq")).map_err(err)?;
            let _initializing=crate::vault_lock::acquire(&root)?;
            if root.join(".noviq/vault.json").is_file(){return Vault::open(root);}
            write_atomic(&root.join(".noviq/vault.json"), json!({ "format": 1, "id": uuid::Uuid::new_v4().to_string(), "name": name }).to_string().as_bytes())?;
        }
        Vault::open(root)
    }

    fn make_dirs(&self) -> Res<()> {
        for d in ["pages", "files", "history", "kv", ".noviq", ".trash/pages", ".trash/files"] {
            fs::create_dir_all(self.root.join(d)).map_err(err)?;
        }
        let workspace=self.root.join("kv/workspace.json");
        if !workspace.exists() { write_atomic(&workspace, &serde_json::to_vec(&json!({"name":self.meta_value().get("name").and_then(Value::as_str).unwrap_or("Nevis")})).map_err(err)?)?; }
        Ok(())
    }

    fn meta_value(&self) -> Value {
        read_json(&self.root.join(".noviq/vault.json")).unwrap_or(Value::Null)
    }

    pub fn id(&self) -> String {
        self.expected_id.clone()
    }

    pub fn name(&self) -> String {
        self.meta_value().get("name").and_then(Value::as_str).unwrap_or("Nevis").to_string()
    }

    /// A new vault in `root` with the given display name.
    pub fn create(root: PathBuf, name: &str) -> Res<Vault> {
        fs::create_dir_all(root.join(".noviq")).map_err(err)?;
        let _initializing=crate::vault_lock::acquire(&root)?;
        let marker = root.join(".noviq/vault.json");
        if !marker.exists() {
            write_atomic(&marker, json!({ "format": 1, "id": uuid::Uuid::new_v4().to_string(), "name": name }).to_string().as_bytes())?;
        }
        Vault::open(root)
    }

    /// New display name, stored in the marker.
    pub fn rename(&self, name: &str) -> Res<()> {
        write_atomic(&self.root.join("kv/workspace.json"), &serde_json::to_vec(&json!({"name":name})).map_err(err)?)?;
        let mut meta = self.meta_value();
        meta["name"] = Value::String(name.to_string());
        write_atomic(&self.root.join(".noviq/vault.json"), meta.to_string().as_bytes())
    }

    pub fn pages_dir(&self) -> PathBuf {
        self.root.join("pages")
    }
    fn page_path(&self, id: &str) -> Res<PathBuf> {
        Ok(self.pages_dir().join(format!("{}.json", check_id(id)?)))
    }

    // ───── pages ─────

    /// All pages. Conflict copies made by the sync tool are merged first (rule 5 of ADR-0003).
    pub fn pages_all(&self) -> Res<Vec<Value>> {
        self.resolve_conflicts()?;
        let mut out = vec![];
        for e in fs::read_dir(self.pages_dir()).map_err(err)? {
            let e=e.map_err(err)?;
            let path = e.path();
            let Some(stem) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".json")) else { continue };
            if !is_id(stem) {
                continue;
            }
            match read_json(&path) {
                Some(mut v) if v.is_object() => {
                    v["id"] = Value::String(stem.to_string()); // the file name is the identity
                    out.push(v);
                }
                _ => return Err(format!("STORAGE:unreadable_page:{}",path.display())),
            }
        }
        Ok(out)
    }

    pub fn resolve_conflicts(&self) -> Res<()> {
        let rd = fs::read_dir(self.pages_dir()).map_err(err)?;
        for e in rd.flatten() {
            let path = e.path();
            let Some(stem) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".json")) else { continue };
            if is_id(stem) || stem.len() <= 36 || !stem.is_char_boundary(36) || !looks_like_uuid(&stem[..36]) {
                continue;
            }
            let Some(copy) = read_json(&path) else { continue };
            let main = self.pages_dir().join(format!("{}.json", &stem[..36]));
            let id = &stem[..36];
            if main.exists() && read_json(&main).is_none() { return Err("STORAGE:unreadable_page".into()); }
            let result = match read_json(&main) {
                None => write_atomic(&main, copy.to_string().as_bytes()),
                Some(cur) => {
                    // database rows merge cell by cell (stamps decide), and the complete losing version is kept in history
                    let (win, losers) = if copy.get("database").is_some() && cur.get("database").is_some() {
                        crate::database::merge::merge_pages(&copy, &cur)
                    } else if updated_at(&copy) > updated_at(&cur) {
                        (copy, vec![cur])
                    } else {
                        (cur, vec![copy])
                    };
                    for lose in &losers {
                        self.keep_loser(id, lose)?;
                        crate::database::keep_page_loser(&self.root, id, lose)?;
                    }
                    write_atomic(&main, win.to_string().as_bytes())
                }
            };
            result?;
            fs::remove_file(&path).map_err(err)?;
        }
        Ok(())
    }

    /// A page version that lost against a newer one is not dropped: it becomes a history entry.
    fn keep_loser(&self, id: &str, page: &Value) -> Res<()> {
        let mut ts = updated_at(page);
        let dir = self.root.join("history").join(check_id(id)?);
        while dir.join(format!("{ts}.json")).exists() {
            ts += 1;
        }
        let v = json!({ "pageId": id, "ts": ts, "title": page.get("title").cloned().unwrap_or(json!("")), "content": page.get("content").cloned().unwrap_or(Value::Null) });
        write_atomic(&dir.join(format!("{ts}.json")), v.to_string().as_bytes())?;
        self.trim_history(id);
        Ok(())
    }

    /// Returns the ids of pages whose version on disk was not the one the edit started from (`_base`, the `updatedAt`
    /// the editor loaded): that version came from another device, so it is kept in the history before ours replaces it.
    pub fn save_pages(&self, upserts: &[Value], removed: &[String], clear_first: bool) -> Res<Vec<String>> {
        let mut kept = vec![];
        for p in upserts {
            let id = p.get("id").and_then(Value::as_str).ok_or("page without id")?;
            let path = self.page_path(id)?;
            if path.exists() && read_json(&path).is_none() { return Err("STORAGE:unreadable_page".into()); }
            // `_base` is bookkeeping of the editor, not part of the page file
            let base = p.get("_base").and_then(Value::as_i64);
            let mut p = p.clone();
            if let Some(o) = p.as_object_mut() {
                o.remove("_base");
            }
            if !clear_first {
                if let Some(cur) = read_json(&path) {
                    if updated_at(&cur) > updated_at(&p) {
                        // another device saved a newer version of this page: ours must not overwrite it
                        self.keep_loser(id, &p)?;
                        continue;
                    }
                    if base.is_some_and(|b| updated_at(&cur) != b && updated_at(&cur) != updated_at(&p)) {
                        // the file changed under the editor (the sync brought another device's edit): do not lose that version
                        self.keep_loser(id, &cur)?;
                        kept.push(id.to_string());
                    }
                }
            }
            write_atomic(&path, p.to_string().as_bytes())?;
        }
        let mut gone: Vec<String> = removed.to_vec();
        if clear_first {
            let keep: std::collections::HashSet<&str> = upserts.iter().filter_map(|p| p.get("id").and_then(Value::as_str)).collect();
            for e in fs::read_dir(self.pages_dir()).map_err(err)?.flatten() {
                if let Some(stem) = e.file_name().to_str().and_then(|n| n.strip_suffix(".json")) {
                    if is_id(stem) && !keep.contains(stem) {
                        gone.push(stem.to_string());
                    }
                }
            }
        }
        for id in gone {
            let path = self.page_path(&id)?;
            if path.exists() { fs::remove_file(&path).map_err(err)?; }
            for p in [self.root.join(".trash/pages").join(format!("{id}.json")), self.root.join(".trash/pages").join(format!("{id}.del"))] {
                if p.exists(){fs::remove_file(p).map_err(err)?;}
            }
            self.versions_delete(&id)?;
        }
        Ok(kept)
    }

    /// Cheap fingerprint of the pages folder, to notice changes made by the sync tool.
    pub fn stamp(&self) -> String {
        let (mut n, mut newest, mut size) = (0u64, 0u128, 0u64);
        // pages plus the database record folders: a record changed by the sync tool must wake the UI as well
        let mut dirs = vec![self.pages_dir()];
        dirs.extend(crate::database::KINDS.iter().map(|(_, d)| self.root.join("databases").join(d)));
        for dir in dirs {
            if let Ok(rd) = fs::read_dir(dir) {
                for e in rd.flatten() {
                    if let Ok(m) = e.metadata() {
                        n += 1;
                        size += m.len();
                        let t = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                        newest = newest.max(t);
                    }
                }
            }
        }
        format!("{n}:{newest}:{size}")
    }

    // ───── history ─────

    fn trim_history(&self, id: &str) {
        let dir = self.root.join("history").join(id);
        let mut ts: Vec<i64> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json")?.parse().ok())
            .collect();
        ts.sort_unstable_by(|a, b| b.cmp(a));
        for t in ts.into_iter().skip(KEEP_VERSIONS) {
            let _ = fs::remove_file(dir.join(format!("{t}.json")));
        }
    }

    pub fn versions_list(&self, id: &str) -> Res<Vec<Value>> {
        let dir = self.root.join("history").join(check_id(id)?);
        let mut out: Vec<Value> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".json")))
            .filter_map(|e| read_json(&e.path()))
            .collect();
        out.sort_by_key(|v| std::cmp::Reverse(v.get("ts").and_then(Value::as_i64).unwrap_or(0)));
        Ok(out)
    }

    pub fn version_add(&self, version: &Value) -> Res<()> {
        let id = version.get("pageId").and_then(Value::as_str).ok_or("version without pageId")?;
        if !self.page_path(id)?.exists() {
            return Ok(()); // the page itself is not saved yet; its first snapshot is not worth failing for
        }
        let ts = version.get("ts").and_then(Value::as_i64).unwrap_or_else(now_ms);
        write_atomic(&self.root.join("history").join(id).join(format!("{ts}.json")), version.to_string().as_bytes())?;
        self.trim_history(id);
        Ok(())
    }

    pub fn versions_delete(&self, id: &str) -> Res<()> {
        let _ = fs::remove_dir_all(self.root.join("history").join(check_id(id)?));
        Ok(())
    }

    // ───── settings ─────

    pub fn kv_path(&self, key: &str) -> Res<PathBuf> {
        Ok(self.root.join("kv").join(format!("{}.json", check_id(key)?)))
    }

    // ───── attachments ─────

    fn file_path(&self, id: &str) -> Res<PathBuf> {
        if id.len() < 8 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("bad file id".into());
        }
        Ok(self.root.join("files").join(&id[..2]).join(id))
    }

    pub fn file_put(&self, id: &str, bytes: &[u8], mime: &str, name: &str, added_at: i64) -> Res<()> {
        let path = self.file_path(id)?;
        if sha256_hex(bytes) != id { return Err("FILE:hash_mismatch".into()); }
        let same = fs::read(&path).is_ok_and(|b| sha256_hex(&b) == id);
        if !same {
            write_atomic(&path, bytes)?;
        }
        // Keep the first name/timestamp for content-addressed duplicate imports.
        if same && path.with_extension("json").is_file() { return Ok(()); }
        // the sidecar is written after the bytes, so a synced sidecar always has its file
        let meta = json!({ "id": id, "type": mime, "size": bytes.len(), "name": name, "addedAt": added_at });
        write_atomic(&path.with_extension("json"), meta.to_string().as_bytes())
    }

    pub fn file_get(&self, id: &str) -> Res<Vec<u8>> {
        let path = self.file_path(id)?;
        fs::read(&path).or_else(|_| fs::read(self.root.join(".trash/files").join(id))).map_err(|_| "missing".to_string())
    }

    pub fn files_list(&self) -> Vec<Value> {
        let mut out = vec![];
        for d in fs::read_dir(self.root.join("files")).into_iter().flatten().flatten() {
            for e in fs::read_dir(d.path()).into_iter().flatten().flatten() {
                if e.file_name().to_str().is_some_and(|n| n.ends_with(".json")) {
                    if let Some(m) = read_json(&e.path()) {
                        out.push(m);
                    }
                }
            }
        }
        out
    }

    /// Permanently drops trash entries older than TRASH_KEEP_MS.
    pub fn purge_trash(&self) {
        for sub in [".trash/pages"] { // Retain trashed assets until the complete history/conflict reference index can prove them unused.
            let dir = self.root.join(sub);
            for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = e.path();
                if path.extension().and_then(|x| x.to_str()) != Some("del") {
                    continue;
                }
                let at: i64 = fs::read_to_string(&path).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                if now_ms() - at > TRASH_KEEP_MS {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let _ = fs::remove_file(dir.join(stem));
                        let _ = fs::remove_file(dir.join(format!("{stem}.json")));
                    }
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("noviq-test-{name}-{}", now_ms()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    const A: &str = "11111111-1111-4111-8111-111111111111";

    fn page(id: &str, title: &str, at: i64) -> Value {
        json!({ "id": id, "title": title, "content": { "type": "doc", "content": [] }, "updatedAt": at, "deletedAt": null })
    }

    #[test]
    fn roundtrip_and_stale_write_keeps_history() {
        let v = Vault::create(tmp("rt"), "T").unwrap();
        v.save_pages(&[page(A, "new", 200)], &[], false).unwrap();
        v.save_pages(&[page(A, "old", 100)], &[], false).unwrap(); // stale: must not overwrite
        let all = v.pages_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["title"], "new");
        let hist = v.versions_list(A).unwrap();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0]["title"], "old");
    }

    #[test]
    fn conflict_copy_is_merged() {
        let v = Vault::create(tmp("conf"), "T").unwrap();
        v.save_pages(&[page(A, "mine", 100)], &[], false).unwrap();
        write_atomic(&v.pages_dir().join(format!("{A} (1).json")), page(A, "theirs", 300).to_string().as_bytes()).unwrap();
        let all = v.pages_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["title"], "theirs");
        assert_eq!(v.versions_list(A).unwrap()[0]["title"], "mine");
        assert!(!v.pages_dir().join(format!("{A} (1).json")).exists());
    }

    #[test]
    fn removed_page_goes_to_trash_and_files_roundtrip() {
        let v = Vault::create(tmp("trash"), "T").unwrap();
        v.save_pages(&[page(A, "x", 1)], &[], false).unwrap();
        v.save_pages(&[], &[A.to_string()], false).unwrap();
        assert!(v.pages_all().unwrap().is_empty());
        assert!(!v.root.join(".trash/pages").join(format!("{A}.json")).exists());

        let id = sha256_hex(b"hello");
        v.file_put(&id, b"hello", "text/plain", "a.txt", 5).unwrap();
        assert_eq!(v.file_get(&id).unwrap(), b"hello");
        assert_eq!(v.files_list().len(), 1);
    }

    #[test]
    fn rejects_path_traversal() {
        let v = Vault::create(tmp("sec"), "T").unwrap();
        assert!(v.save_pages(&[page("../evil", "x", 1)], &[], false).is_err());
        assert!(v.versions_list("..").is_err());
    }

    #[test]
    fn open_never_recreates_a_vanished_vault() {
        let root = tmp("gone");
        let v = Vault::create(root.clone(), "T").unwrap();
        let id = v.id();
        assert!(Vault::open_as(root.clone(), &id).is_ok());
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(Vault::open(root.clone()).err().as_deref(), Some(VAULT_MISSING));
        assert!(!root.exists(), "the folder must not come back");
        // a folder that exists but has no marker is not a vault either (the user must adopt it on purpose)
        fs::create_dir_all(&root).unwrap();
        assert_eq!(Vault::open(root.clone()).err().as_deref(), Some(VAULT_MISSING));
        assert!(!root.join(".noviq").exists());
        let adopted = Vault::adopt(root.clone()).unwrap();
        assert_ne!(adopted.id(), id);
    }

    #[test]
    fn open_as_refuses_another_vault() {
        let root = tmp("other");
        let v = Vault::create(root.clone(), "T").unwrap();
        assert_eq!(Vault::open_as(root, "00000000-0000-4000-8000-000000000000").err().as_deref(), Some(VAULT_MISMATCH));
        drop(v);
    }

    #[test]
    fn a_stale_edit_keeps_the_version_it_would_overwrite() {
        let v = Vault::create(tmp("base"), "T").unwrap();
        v.save_pages(&[page(A, "v1", 100)], &[], false).unwrap();
        // another device's edit arrives (updatedAt 200) while the editor still works on v1
        v.save_pages(&[page(A, "from other device", 200)], &[], false).unwrap();
        let mut mine = page(A, "typed here", 300);
        mine["_base"] = json!(100);
        assert_eq!(v.save_pages(&[mine], &[], false).unwrap(), vec![A.to_string()]);
        let all = v.pages_all().unwrap();
        assert_eq!(all[0]["title"], "typed here");
        assert!(all[0].get("_base").is_none(), "bookkeeping must not reach the file");
        assert_eq!(v.versions_list(A).unwrap()[0]["title"], "from other device");
        // an edit based on what is on disk is a normal save
        let mut next = page(A, "typed again", 400);
        next["_base"] = json!(300);
        assert!(v.save_pages(&[next], &[], false).unwrap().is_empty());
    }

}

#[cfg(test)]
mod locking_tests {
    use super::*;
    #[test]
    fn process_probe() {
        let Ok(root)=std::env::var("NEVIS_TEST_LOCK_ROOT") else{return;};
        let expected=std::env::var("NEVIS_TEST_LOCK_EXPECT").unwrap();
        let result=Vault::open(PathBuf::from(root));
        if expected=="held"{assert_eq!(result.err().as_deref(),Some("VAULT_IN_USE"));}
        else{let v=result.unwrap();v.save_pages(&[json!({"id":"child","title":"written by child","updatedAt":1,"deletedAt":null,"content":{"type":"doc","content":[]}})],&[],false).unwrap();}
    }
    #[test]
    fn another_process_cannot_open_until_every_local_handle_is_closed(){
        let root=std::env::temp_dir().join(format!("nevis-lock-{}",uuid::Uuid::new_v4()));let a=Vault::create(root.clone(),"locked").unwrap();let b=Vault::open_as(root.clone(),&a.id()).unwrap();
        let child=|expect:&str|std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","vault::locking_tests::process_probe","--nocapture"]).env("NEVIS_TEST_LOCK_ROOT",&root).env("NEVIS_TEST_LOCK_EXPECT",expect).output().unwrap();
        assert!(child("held").status.success());drop(a);assert!(child("held").status.success());drop(b);let outcome=child("free");assert!(outcome.status.success(),"{}",String::from_utf8_lossy(&outcome.stderr));assert!(root.join("pages/child.json").is_file());fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_marker_of_an_unknown_format_is_refused() {
        let root = std::env::temp_dir().join(format!("nevis-format-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(root.clone(), "T").unwrap();
        let id = v.id();
        drop(v);
        write_atomic(&root.join(".noviq/vault.json"), &serde_json::to_vec(&json!({"format":2,"id":id,"name":"T"})).unwrap()).unwrap();
        assert_eq!(Vault::open(root.clone()).err().as_deref(), Some("VAULT_UNSUPPORTED_FORMAT"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn replacing_marker_never_changes_the_open_vault_identity(){
        let root=std::env::temp_dir().join(format!("nevis-identity-{}",uuid::Uuid::new_v4()));let v=Vault::create(root.clone(),"T").unwrap();let original=v.id();write_atomic(&root.join(".noviq/vault.json"),&serde_json::to_vec(&json!({"format":1,"id":uuid::Uuid::new_v4().to_string(),"name":"other"})).unwrap()).unwrap();assert_eq!(v.id(),original);assert_eq!(v.ensure_exclusive().unwrap_err(),VAULT_MISMATCH);drop(v);fs::remove_dir_all(root).unwrap();
    }
}
