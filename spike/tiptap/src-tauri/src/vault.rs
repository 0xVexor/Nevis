//! The Vault: a plain folder that is the source of truth (ADR-0003). Everything here is ordinary file I/O so a
//! sync tool (Google Drive, etc.) can move files between devices; no function keeps a file open or writes in place.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub type Res<T> = Result<T, String>;

pub const KEEP_VERSIONS: usize = 40;
pub const TRASH_KEEP_MS: i64 = 30 * 24 * 3600 * 1000;

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
    let tmp = dir.join(format!(".{name}.tmp"));
    let mut f = fs::File::create(&tmp).map_err(err)?;
    f.write_all(bytes).map_err(err)?;
    f.sync_all().map_err(err)?;
    drop(f);
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn updated_at(v: &Value) -> i64 {
    v.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64
}

pub struct Vault {
    pub root: PathBuf,
}

impl Vault {
    pub fn open(root: PathBuf) -> Res<Vault> {
        for d in ["pages", "files", "history", "kv", ".noviq", ".trash/pages", ".trash/files"] {
            fs::create_dir_all(root.join(d)).map_err(err)?;
        }
        let v = Vault { root };
        // the identity travels with the folder (and through sync), so every device knows it is the same vault
        let mut meta = v.meta_value();
        if meta.get("id").and_then(Value::as_str).is_none() {
            let name = v.root.file_name().and_then(|n| n.to_str()).unwrap_or("Noviq").to_string();
            meta = json!({ "format": 1, "id": uuid::Uuid::new_v4().to_string(), "name": name });
            write_atomic(&v.root.join(".noviq/vault.json"), meta.to_string().as_bytes())?;
        }
        Ok(v)
    }

    fn meta_value(&self) -> Value {
        read_json(&self.root.join(".noviq/vault.json")).unwrap_or(Value::Null)
    }

    pub fn id(&self) -> String {
        self.meta_value().get("id").and_then(Value::as_str).unwrap_or_default().to_string()
    }

    pub fn name(&self) -> String {
        self.meta_value().get("name").and_then(Value::as_str).unwrap_or("Noviq").to_string()
    }

    /// A new vault in `root` with the given display name.
    pub fn create(root: PathBuf, name: &str) -> Res<Vault> {
        Vault::create_with_id(root, name, &uuid::Uuid::new_v4().to_string())
    }

    /// Used when a vault that already exists in the cloud is downloaded: it keeps its identity.
    pub fn create_with_id(root: PathBuf, name: &str, id: &str) -> Res<Vault> {
        fs::create_dir_all(root.join(".noviq")).map_err(err)?;
        let marker = root.join(".noviq/vault.json");
        if !marker.exists() {
            write_atomic(&marker, json!({ "format": 1, "id": id, "name": name }).to_string().as_bytes())?;
        }
        Vault::open(root)
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
        self.resolve_conflicts();
        let mut out = vec![];
        for e in fs::read_dir(self.pages_dir()).map_err(err)?.flatten() {
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
                _ => eprintln!("unreadable page file: {}", path.display()),
            }
        }
        Ok(out)
    }

    pub fn resolve_conflicts(&self) {
        let Ok(rd) = fs::read_dir(self.pages_dir()) else { return };
        for e in rd.flatten() {
            let path = e.path();
            let Some(stem) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".json")) else { continue };
            if is_id(stem) || stem.len() <= 36 || !stem.is_char_boundary(36) || !looks_like_uuid(&stem[..36]) {
                continue;
            }
            let Some(copy) = read_json(&path) else { continue };
            let main = self.pages_dir().join(format!("{}.json", &stem[..36]));
            let id = &stem[..36];
            let result = match read_json(&main) {
                None => write_atomic(&main, copy.to_string().as_bytes()),
                Some(cur) => {
                    let (win, lose) = if updated_at(&copy) > updated_at(&cur) { (copy, cur) } else { (cur, copy) };
                    let _ = self.keep_loser(id, &lose);
                    write_atomic(&main, win.to_string().as_bytes())
                }
            };
            if result.is_ok() {
                let _ = fs::remove_file(&path);
            }
        }
    }

    /// A page version that lost against a newer one is not dropped: it becomes a history entry.
    fn keep_loser(&self, id: &str, page: &Value) -> Res<()> {
        if page.get("kind").and_then(Value::as_str) == Some("folder") {
            return Ok(());
        }
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

    pub fn save_pages(&self, upserts: &[Value], removed: &[String], clear_first: bool) -> Res<()> {
        for p in upserts {
            let id = p.get("id").and_then(Value::as_str).ok_or("page without id")?;
            let path = self.page_path(id)?;
            if !clear_first {
                if let Some(cur) = read_json(&path) {
                    if updated_at(&cur) > updated_at(p) {
                        // another device saved a newer version of this page: ours must not overwrite it
                        self.keep_loser(id, p)?;
                        continue;
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
            if path.exists() {
                let dest = self.root.join(".trash/pages").join(format!("{id}.json"));
                let _ = fs::remove_file(&dest);
                fs::rename(&path, &dest).map_err(err)?;
                write_atomic(&self.root.join(".trash/pages").join(format!("{id}.del")), now_ms().to_string().as_bytes())?;
            }
        }
        Ok(())
    }

    /// Cheap fingerprint of the pages folder, to notice changes made by the sync tool.
    pub fn stamp(&self) -> String {
        let (mut n, mut newest, mut size) = (0u64, 0u128, 0u64);
        if let Ok(rd) = fs::read_dir(self.pages_dir()) {
            for e in rd.flatten() {
                if let Ok(m) = e.metadata() {
                    n += 1;
                    size += m.len();
                    let t = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                    newest = newest.max(t);
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
        let same = fs::metadata(&path).is_ok_and(|m| m.len() == bytes.len() as u64);
        if !same {
            write_atomic(&path, bytes)?;
        }
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

    /// Never an immediate delete: the other devices may not have synced the page that still uses the file.
    pub fn file_delete(&self, id: &str) -> Res<()> {
        let path = self.file_path(id)?;
        let trash = self.root.join(".trash/files");
        if path.exists() {
            let _ = fs::remove_file(trash.join(id));
            fs::rename(&path, trash.join(id)).map_err(err)?;
            write_atomic(&trash.join(format!("{id}.del")), now_ms().to_string().as_bytes())?;
        }
        let _ = fs::remove_file(path.with_extension("json"));
        Ok(())
    }

    /// Permanently drops trash entries older than TRASH_KEEP_MS.
    pub fn purge_trash(&self) {
        for sub in [".trash/pages", ".trash/files"] {
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

    pub fn has_pages(&self) -> bool {
        fs::read_dir(self.pages_dir()).is_ok_and(|rd| rd.flatten().any(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".json"))))
    }

    /// Copies everything that belongs to the vault (not the trash) into `to`.
    pub fn copy_into(&self, to: &Path) -> Res<()> {
        fn walk(from: &Path, to: &Path) -> Res<()> {
            fs::create_dir_all(to).map_err(err)?;
            for e in fs::read_dir(from).map_err(err)?.flatten() {
                let (p, name) = (e.path(), e.file_name());
                if name.to_str().is_some_and(|n| n.starts_with('.') && n.ends_with(".tmp")) {
                    continue;
                }
                if p.is_dir() {
                    walk(&p, &to.join(&name))?;
                } else {
                    fs::copy(&p, to.join(&name)).map_err(err)?;
                }
            }
            Ok(())
        }
        for d in ["pages", "files", "history", "kv"] {
            walk(&self.root.join(d), &to.join(d))?;
        }
        Ok(())
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
        let v = Vault::open(tmp("rt")).unwrap();
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
        let v = Vault::open(tmp("conf")).unwrap();
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
        let v = Vault::open(tmp("trash")).unwrap();
        v.save_pages(&[page(A, "x", 1)], &[], false).unwrap();
        v.save_pages(&[], &[A.to_string()], false).unwrap();
        assert!(v.pages_all().unwrap().is_empty());
        assert!(v.root.join(".trash/pages").join(format!("{A}.json")).exists());

        let id = "ab".repeat(32);
        v.file_put(&id, b"hello", "text/plain", "a.txt", 5).unwrap();
        assert_eq!(v.file_get(&id).unwrap(), b"hello");
        assert_eq!(v.files_list().len(), 1);
        v.file_delete(&id).unwrap();
        assert!(v.files_list().is_empty());
        assert_eq!(v.file_get(&id).unwrap(), b"hello"); // still recoverable from the trash
    }

    #[test]
    fn rejects_path_traversal() {
        let v = Vault::open(tmp("sec")).unwrap();
        assert!(v.save_pages(&[page("../evil", "x", 1)], &[], false).is_err());
        assert!(v.versions_list("..").is_err());
    }
}
