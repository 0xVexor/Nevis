//! The Vault: a plain folder that is the source of truth (ADR-0003). Everything here is ordinary file I/O so a
//! sync tool (Google Drive, etc.) can move files between devices; no function keeps a file open or writes in place.

use serde_json::{json, Value};
use std::fs;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::sync::atomic::{AtomicBool, Ordering};

static INSTALLING: AtomicBool = AtomicBool::new(false);
pub fn writes_paused() -> bool { INSTALLING.load(Ordering::SeqCst) }
pub struct WritePause { keep: bool }
impl WritePause {
    pub fn new() -> Self { INSTALLING.store(true, Ordering::SeqCst); Self { keep: false } }
    pub fn keep_until_restart(&mut self) { self.keep = true; }
}
impl Drop for WritePause {
    fn drop(&mut self) { if !self.keep { INSTALLING.store(false, Ordering::SeqCst); } }
}

/// Kernel locks release on process death and cannot be stolen by deleting a marker.
pub fn process_lease(root: &Path) -> Res<Arc<fs::File>> {
    static LEASES: OnceLock<Mutex<BTreeMap<PathBuf, Weak<fs::File>>>> = OnceLock::new();
    let key = root.canonicalize().map_err(err)?;
    safe_local(&key, ".noviq/writer.lock")?;
    let mut leases = LEASES.get_or_init(Default::default).lock().map_err(err)?;
    if let Some(file) = leases.get(&key).and_then(Weak::upgrade) { return Ok(file); }
    let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(key.join(".noviq/writer.lock")).map_err(err)?;
    file.try_lock().map_err(|_| "VAULT_IN_USE: close the other app using this workspace".to_string())?;
    let file = Arc::new(file);
    leases.insert(key, Arc::downgrade(&file));
    Ok(file)
}
use std::collections::BTreeMap;
use parking_lot::ReentrantMutex;
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

/// In-process serialization shared by commands, the sync worker and database writes.
/// Reentrant because a command can call several Vault operations under one guard.
pub fn local_lock(root: &Path) -> Arc<ReentrantMutex<()>> {
    static LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, Arc<ReentrantMutex<()>>>>> = OnceLock::new();
    let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
        .entry(key).or_insert_with(|| Arc::new(ReentrantMutex::new(()))).clone()
}

/// Reject links under the vault, including parents introduced after the scan.
pub fn safe_local(root: &Path, rel: &str) -> Res<()> {
    let mut path = root.to_path_buf();
    for part in Path::new(rel).components() {
        if !matches!(part, std::path::Component::Normal(_)) { return Err("unsafe local path".into()); }
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => return Err("HUB:unsafe_path\ndetail=symlink".into()),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(err(e)),
            _ => {}
        }
    }
    Ok(())
}

/// Unique temporary files prevent simultaneous writers from sharing an inode.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Res<()> {
    if writes_paused() { return Err("UPDATE_BUSY".into()); }
    let dir = path.parent().ok_or("bad path")?;
    fs::create_dir_all(dir).map_err(err)?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("bad path")?;
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(err)?;
        f.write_all(bytes).map_err(err)?;
        f.sync_all().map_err(err)?;
        drop(f);
        fs::rename(&tmp, path).map_err(err)?;
        #[cfg(unix)]
        fs::File::open(dir).and_then(|f| f.sync_all()).map_err(err)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}

/// Publish a fully written, verified file on the same volume.
pub fn publish_temporary(source: &Path, destination: &Path) -> Res<()> {
    if writes_paused() { return Err("UPDATE_BUSY".into()); }
    let parent = destination.parent().ok_or("bad path")?;
    fs::create_dir_all(parent).map_err(err)?;
    fs::rename(source, destination).map_err(err)?;
    #[cfg(unix)]
    fs::File::open(parent).and_then(|f| f.sync_all()).map_err(err)?;
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn updated_at(v: &Value) -> i64 {
    v.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64
}

/// What is at `root`, reading only: the vault `id` ("ok"), another vault ("mismatch") or nothing ("missing").
pub fn probe(root: &Path, id: &str) -> &'static str {
    match read_json(&root.join(".noviq/vault.json")) {
        None => "missing",
        Some(m) if m.get("id").and_then(Value::as_str) == Some(id) => "ok",
        Some(_) => "mismatch",
    }
}

pub struct Vault {
    pub root: PathBuf,
    pub(crate) _lease: Arc<fs::File>,
    identity: String,
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
        let identity = read_json(&root.join(".noviq/vault.json")).and_then(|v| v["id"].as_str().map(str::to_string)).ok_or(VAULT_MISSING)?;
        check_id(&identity)?;
        let v = Vault { _lease: process_lease(&root)?, root, identity };
        v.protect_legacy_conflicts()?;
        Ok(v)
    }

    fn protect_legacy_conflicts(&self) -> Res<()> {
        let mutex = local_lock(&self.root);
        let _guard = mutex.lock();
        let done = self.root.join(".noviq/history-format-2");
        if done.exists() { return Ok(()); }
        let history = self.root.join("history");
        if history.is_dir() {
            for dir in fs::read_dir(history).map_err(err)? {
                let dir = dir.map_err(err)?;
                if !dir.file_type().map_err(err)?.is_dir() { continue; }
                let id = dir.file_name().to_string_lossy().to_string();
                if !is_id(&id) { continue; }
                for entry in fs::read_dir(dir.path()).map_err(err)? {
                    let entry = entry.map_err(err)?;
                    let path = entry.path();
                    if path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<i64>().ok()).is_none() { continue; }
                    if let Some(v) = read_json(&path).filter(|v| v["conflict"] == true) {
                        // Copy before removing the legacy name; an interrupted
                        // migration leaves an extra recoverable version.
                        self.keep_loser(&id, v.get("page").unwrap_or(&v))?;
                        fs::remove_file(path).map_err(err)?;
                    }
                }
            }
        }
        write_atomic(&done, b"2")
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
            write_atomic(&root.join(".noviq/vault.json"), json!({ "format": 1, "id": uuid::Uuid::new_v4().to_string(), "name": name }).to_string().as_bytes())?;
        }
        let v = Vault::open(root)?;
        v.make_dirs()?;
        Ok(v)
    }

    fn make_dirs(&self) -> Res<()> {
        for d in ["pages", "files", "history", "kv", ".noviq", ".trash/pages", ".trash/files"] {
            fs::create_dir_all(self.root.join(d)).map_err(err)?;
        }
        Ok(())
    }

    /// Where files go that the sync would otherwise drop (deleted or overwritten by another device). Not synced, emptied after 30 days.
    pub fn sync_trash_dir(&self) -> PathBuf {
        self.root.join(".noviq/sync-trash")
    }

    /// Keeps `bytes` (the content of vault file `rel`) in the sync trash.
    pub fn sync_trash_put(&self, rel: &str, bytes: &[u8]) -> Res<()> {
        safe_local(&self.root, ".noviq/sync-trash")?;
        let mut ts = now_ms();
        while self.sync_trash_dir().join(ts.to_string()).join(rel).exists() {
            ts += 1;
        }
        write_atomic(&self.sync_trash_dir().join(ts.to_string()).join(rel), bytes)
    }

    /// Moves vault file `rel` into the sync trash instead of deleting it.
    pub fn sync_trash_move(&self, rel: &str) -> Res<()> {
        safe_local(&self.root, ".noviq/sync-trash")?;
        let mut ts = now_ms();
        while self.sync_trash_dir().join(ts.to_string()).join(rel).exists() {
            ts += 1;
        }
        let dest = self.sync_trash_dir().join(ts.to_string()).join(rel);
        fs::create_dir_all(dest.parent().ok_or("bad path")?).map_err(err)?;
        fs::rename(self.root.join(rel), &dest).map_err(err)
    }

    fn meta_value(&self) -> Value {
        read_json(&self.root.join(".noviq/vault.json")).unwrap_or(Value::Null)
    }

    pub fn id(&self) -> String {
        self.identity.clone()
    }

    pub fn name(&self) -> String {
        self.meta_value().get("name").and_then(Value::as_str).unwrap_or("Nevis").to_string()
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
        let v = Vault::open(root)?;
        v.make_dirs()?;
        Ok(v)
    }

    /// New display name, stored in the marker (it travels through sync like the id).
    pub fn rename(&self, name: &str) -> Res<()> {
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
        let mutex = local_lock(&self.root);
        let _guard = mutex.lock();
        self.resolve_conflicts()?;
        let mut out = vec![];
        for e in fs::read_dir(self.pages_dir()).map_err(err)? {
            let e = e.map_err(err)?;
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
                _ => return Err(format!("unreadable page file: {}", path.display())),
            }
        }
        Ok(out)
    }

    pub fn resolve_conflicts(&self) -> Res<()> {
        let mutex = local_lock(&self.root);
        let _guard = mutex.lock();
        let rd = fs::read_dir(self.pages_dir()).map_err(err)?;
        for e in rd {
            let e = e.map_err(err)?;
            let path = e.path();
            let Some(stem) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".json")) else { continue };
            if is_id(stem) { continue; }
            let id = stem.split_once(" (").map(|(id, _)| id).filter(|id| is_id(id))
                .or_else(|| (stem.len() > 36 && stem.is_char_boundary(36) && looks_like_uuid(&stem[..36])).then(|| &stem[..36]));
            let Some(id) = id else { continue };
            let copy = read_json(&path).filter(Value::is_object).ok_or_else(|| format!("unreadable conflict file: {}", path.display()))?;
            let main = self.pages_dir().join(format!("{id}.json"));
            safe_local(&self.root, &format!("pages/{id}.json"))?;
            let current = match fs::read(&main) {
                Ok(raw) => match serde_json::from_slice::<Value>(&raw) {
                    Ok(v) if v.is_object() => Some(v),
                    _ => { self.sync_trash_put(&format!("pages/{id}.json"), &raw)?; None }
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(err(e)),
            };
            let result = match current {
                None => write_atomic(&main, copy.to_string().as_bytes()),
                Some(cur) => {
                    // database rows merge cell by cell (stamps decide), and the complete losing version is kept in history
                    let (win, losers) = if copy.get("database").is_some() && cur.get("database").is_some() {
                        crate::database::merge::merge_pages(&copy, &cur)
                    } else if (updated_at(&copy), copy.to_string()) > (updated_at(&cur), cur.to_string()) {
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
        let ts = updated_at(page);
        let dir = self.root.join("history").join(check_id(id)?);
        // Older clients trim only numeric names. A content-addressed conflict
        // survives their ordinary retention and repeated delivery is idempotent.
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(page.to_string().as_bytes()));
        let name = format!("conflict-{hash}.json");
        safe_local(&self.root, &format!("history/{id}/{name}"))?;
        let v = json!({ "pageId": id, "ts": ts, "title": page.get("title").cloned().unwrap_or(json!("")), "content": page.get("content").cloned().unwrap_or(Value::Null), "page": page, "conflict": true });
        write_atomic(&dir.join(name), v.to_string().as_bytes())?;
        Ok(())
    }

    /// Returns the ids of pages whose version on disk was not the one the edit started from (`_base`, the `updatedAt`
    /// the editor loaded): that version came from another device, so it is kept in the history before ours replaces it.
    pub fn save_pages(&self, upserts: &[Value], removed: &[String], clear_first: bool) -> Res<Vec<String>> {
        let mutex = local_lock(&self.root);
        let _guard = mutex.lock();
        let mut kept = vec![];
        for p in upserts {
            let id = p.get("id").and_then(Value::as_str).ok_or("page without id")?;
            safe_local(&self.root, &format!("pages/{id}.json"))?;
            let path = self.page_path(id)?;
            // `_base` is bookkeeping of the editor, not part of the page file
            let base = p.get("_base").and_then(Value::as_i64);
            let base_page = p.get("_basePage").filter(|v| !v.is_null()).cloned();
            let mut p = p.clone();
            if let Some(o) = p.as_object_mut() {
                o.remove("_base");
                o.remove("_basePage");
            }
            if path.exists() && read_json(&path).is_none() {
                return Err(format!("unreadable page file: {}", path.display()));
            }
            if !clear_first {
                if let Some(cur) = read_json(&path) {
                    if updated_at(&cur) > updated_at(&p) {
                        // another device saved a newer version of this page: ours must not overwrite it
                        self.keep_loser(id, &p)?;
                        kept.push(id.to_string());
                        continue;
                    }
                    if (base_page.as_ref().map_or_else(|| base.is_some_and(|b| updated_at(&cur) != b), |b| b != &cur)) && cur != p {
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
            if path.exists() {
                let dest = self.root.join(".trash/pages").join(format!("{id}.json"));
                let _ = fs::remove_file(&dest);
                fs::rename(&path, &dest).map_err(err)?;
                write_atomic(&self.root.join(".trash/pages").join(format!("{id}.del")), now_ms().to_string().as_bytes())?;
            }
        }
        Ok(kept)
    }

    /// Content fingerprint: equal timestamps and equal-sized replacements still
    /// refresh the editor. Paths and each file's bytes participate in the hash.
    pub fn stamp(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        let mut dirs = vec![self.pages_dir()];
        dirs.extend(crate::database::KINDS.iter().map(|(_, d)| self.root.join("databases").join(d)));
        for dir in dirs {
            let mut entries: Vec<_> = fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok).collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                if entry.path().extension().and_then(|e| e.to_str()) != Some("json") { continue; }
                hash.update(entry.path().strip_prefix(&self.root).unwrap_or(&entry.path()).to_string_lossy().as_bytes());
                match fs::read(entry.path()) { Ok(bytes) => hash.update(sha2::Sha256::digest(&bytes)), Err(e) => hash.update(e.to_string().as_bytes()) }
            }
        }
        hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    // ───── history ─────

    fn trim_history(&self, id: &str) {
        let dir = self.root.join("history").join(id);
        let mut ts: Vec<i64> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| !read_json(&e.path()).is_some_and(|v| v["conflict"] == true))
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
        safe_local(&self.root, &format!("files/{}/{id}", &id[..2]))?;
        let same = fs::read(&path).is_ok_and(|existing| existing == bytes);
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
        // what the sync set aside (one folder per moment, named by its time)
        for e in fs::read_dir(self.sync_trash_dir()).into_iter().flatten().flatten() {
            let Some(at) = e.file_name().to_str().and_then(|n| n.parse::<i64>().ok()) else { continue };
            if now_ms() - at > TRASH_KEEP_MS {
                let _ = fs::remove_dir_all(e.path());
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

    #[test]
    fn process_lock_child() {
        let Some(root) = std::env::var_os("NEVIS_LEASE_TEST_ROOT") else { return };
        let result = Vault::open(PathBuf::from(root));
        assert!(result.err().is_some_and(|e| e.contains("VAULT_IN_USE")));
    }

    #[test]
    fn another_process_cannot_open_a_workspace_for_writing() {
        let v = Vault::create(tmp("lease"), "T").unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "vault::tests::process_lock_child", "--nocapture"])
            .env("NEVIS_LEASE_TEST_ROOT", &v.root).output().unwrap();
        assert!(child.status.success(), "{}", String::from_utf8_lossy(&child.stdout));
    }

    #[test]
    fn conflict_names_survive_numeric_retention_used_by_older_clients() {
        let v = Vault::create(tmp("legacy-retention"), "T").unwrap();
        v.save_pages(&[page(A, "original", 100)], &[], false).unwrap();
        v.keep_loser(A, &page(A, "preserved conflict", 50)).unwrap();
        for n in 0..60 { v.version_add(&json!({"pageId":A,"ts":1000+n,"title":"ordinary","content":{}})).unwrap(); }
        let dir = v.root.join("history").join(A);
        let mut numeric: Vec<_> = fs::read_dir(&dir).unwrap().flatten()
            .filter_map(|e| e.path().file_stem()?.to_str()?.parse::<i64>().ok()).collect();
        numeric.sort_by(|a,b| b.cmp(a));
        for ts in numeric.into_iter().skip(KEEP_VERSIONS) { fs::remove_file(dir.join(format!("{ts}.json"))).unwrap(); }
        assert!(v.versions_list(A).unwrap().iter().any(|v| v["page"]["title"] == "preserved conflict"));
    }

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

    #[test]
    fn sync_trash_keeps_files_and_purges_old_ones() {
        let v = Vault::create(tmp("strash"), "T").unwrap();
        v.save_pages(&[page(A, "x", 1)], &[], false).unwrap();
        v.sync_trash_move(&format!("pages/{A}.json")).unwrap();
        assert!(v.pages_all().unwrap().is_empty());
        v.sync_trash_put("kv/srs.json", b"{}").unwrap();
        let old = v.sync_trash_dir().join("1000");
        write_atomic(&old.join("pages/old.json"), b"{}").unwrap();
        v.purge_trash();
        assert!(!old.exists(), "older than the retention time");
        assert_eq!(fs::read_dir(v.sync_trash_dir()).unwrap().count(), 2, "recent entries stay");
    }
    #[test]
    fn a_failed_conflict_archive_leaves_both_source_files_untouched() {
        let v = Vault::create(tmp("archive-failure"), "T").unwrap();
        v.save_pages(&[page(A, "mine", 200)], &[], false).unwrap();
        let cloud = v.pages_dir().join(format!("{A} (cloud).json"));
        write_atomic(&cloud, page(A, "theirs", 100).to_string().as_bytes()).unwrap();
        fs::write(v.root.join("history").join(A), b"blocks the history directory").unwrap();
        assert!(v.resolve_conflicts().is_err());
        assert!(cloud.exists());
        assert_eq!(read_json(&v.page_path(A).unwrap()).unwrap()["title"], "mine");
    }

    #[test]
    fn a_conflict_retains_the_complete_page_and_is_not_trimmed_by_normal_history() {
        let v = Vault::create(tmp("full-history"), "T").unwrap();
        let mut old = page(A, "old", 100);
        old["parentId"] = json!("folder");
        old["tags"] = json!(["important"]);
        old["cover"] = json!({"kind":"image","file":"abcdef123456"});
        v.save_pages(&[old.clone()], &[], false).unwrap();
        write_atomic(&v.pages_dir().join(format!("{A} (cloud).json")), page(A, "new", 200).to_string().as_bytes()).unwrap();
        v.resolve_conflicts().unwrap();
        for n in 0..50 {
            v.version_add(&json!({"pageId":A,"ts":1000+n,"title":"snapshot","content":{}})).unwrap();
        }
        let versions = v.versions_list(A).unwrap();
        assert!(versions.iter().any(|version| version["conflict"] == true && version["page"] == old));
        assert_eq!(versions.iter().filter(|v| v["conflict"] != true).count(), KEEP_VERSIONS);
    }

    #[test]
    fn equal_timestamp_conflicts_choose_the_same_page_in_both_orders() {
        let x = page(A, "alpha", 100);
        let y = page(A, "zulu", 100);
        let mut winners = vec![];
        for (n, (main, cloud)) in [(x.clone(), y.clone()), (y, x)].into_iter().enumerate() {
            let v = Vault::create(tmp(&format!("tie-{n}")), "T").unwrap();
            v.save_pages(&[main], &[], false).unwrap();
            write_atomic(&v.pages_dir().join(format!("{A} (cloud).json")), cloud.to_string().as_bytes()).unwrap();
            winners.push(v.pages_all().unwrap()[0].clone());
        }
        assert_eq!(winners[0], winners[1]);
    }

    #[test]
    fn a_corrupt_main_is_quarantined_before_a_conflict_replaces_it() {
        let v = Vault::create(tmp("corrupt-main"), "T").unwrap();
        fs::write(v.page_path(A).unwrap(), b"{partial original").unwrap();
        write_atomic(&v.pages_dir().join(format!("{A} (cloud).json")), page(A, "valid", 200).to_string().as_bytes()).unwrap();
        v.resolve_conflicts().unwrap();
        assert_eq!(v.pages_all().unwrap()[0]["title"], "valid");
        assert!(fs::read_dir(v.sync_trash_dir()).unwrap().flatten().any(|e| fs::read(e.path().join(format!("pages/{A}.json"))).is_ok_and(|b| b == b"{partial original")));
    }

    #[test]
    fn concurrent_saves_publish_complete_json_and_keep_the_other_version() {
        let root = Vault::create(tmp("parallel"), "T").unwrap().root;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let jobs: Vec<_> = (0..2).map(|n| {
            let root = root.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let v = Vault::open(root).unwrap();
                barrier.wait();
                let mut value = page(A, &format!("writer-{n}"), 100 + n);
                value["_base"] = json!(0);
                v.save_pages(&[value], &[], false).unwrap();
            })
        }).collect();
        for job in jobs { job.join().unwrap(); }
        let v = Vault::open(root).unwrap();
        assert_eq!(v.pages_all().unwrap()[0]["title"], "writer-1");
        assert!(v.versions_list(A).unwrap().iter().any(|v| v["title"] == "writer-0"));
    }

    #[test]
    fn opening_a_vault_does_not_recreate_a_missing_subtree() {
        let v = Vault::create(tmp("missing-subtree"), "T").unwrap();
        fs::remove_dir(v.pages_dir()).unwrap();
        assert!(Vault::open_as(v.root.clone(), &v.id()).is_ok());
        assert!(!v.pages_dir().exists());
    }

    #[test]
    fn equal_timestamp_external_changes_are_detected_with_a_complete_baseline() {
        let v = Vault::create(tmp("baseline-page"), "T").unwrap();
        let original = page(A, "original", 100);
        v.save_pages(&[original.clone()], &[], false).unwrap();
        write_atomic(&v.page_path(A).unwrap(), page(A, "remote", 100).to_string().as_bytes()).unwrap();
        let mut edit = page(A, "local", 200);
        edit["_base"] = json!(100);
        edit["_basePage"] = original;
        assert_eq!(v.save_pages(&[edit], &[], false).unwrap(), vec![A.to_string()]);
        assert!(v.versions_list(A).unwrap().iter().any(|v| v["page"]["title"] == "remote"));
        assert!(read_json(&v.page_path(A).unwrap()).unwrap().get("_basePage").is_none());
    }

    #[test]
    fn short_legacy_ids_also_resolve_conflicts_into_visible_history() {
        let v = Vault::create(tmp("short-id"), "T").unwrap();
        v.save_pages(&[page("row1", "old", 100)], &[], false).unwrap();
        write_atomic(&v.pages_dir().join("row1 (cloud-copy).json"), page("row1", "new", 200).to_string().as_bytes()).unwrap();
        assert_eq!(v.pages_all().unwrap()[0]["title"], "new");
        assert_eq!(v.versions_list("row1").unwrap()[0]["page"]["title"], "old");
    }

}
