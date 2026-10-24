//! Sync of a vault with a remote copy (Google Drive, see drive.rs) without any help from the user.
//! The engine is independent of the remote: it only needs the `Remote` trait, so it is tested with an in-memory one.
//!
//! Method: a file-level three-way comparison. For every path the engine knows the local content hash, the remote
//! content hash and `base`, the hash both sides agreed on at the last sync. Whoever differs from `base` changed.

pub mod auth;
pub mod drive;

use crate::vault::{err, now_ms, write_atomic, Res, Vault};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug)]
pub struct RemoteFile {
    pub id: String,
    pub path: String,
    pub md5: String,
    pub modified_ms: i64,
}

pub trait Remote {
    fn list(&mut self) -> Res<Vec<RemoteFile>>;
    fn download(&mut self, f: &RemoteFile) -> Res<Vec<u8>>;
    /// Creates the file, or replaces its content when `existing` is the id of the current remote file.
    fn upload(&mut self, path: &str, existing: Option<&str>, bytes: &[u8]) -> Res<RemoteFile>;
    fn delete(&mut self, id: &str) -> Res<()>;
}

/// What the previous sync left behind, per path. Stored next to the app (per device), never in the vault.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Entry {
    pub base: String, // md5 both sides had after the last sync
    pub remote_id: String,
    #[serde(default)]
    pub size: u64, // with `mtime` and `md5`: cache of the local hash so unchanged files are not read again
    #[serde(default)]
    pub mtime: u128,
    #[serde(default)]
    pub md5: String,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct SyncState {
    pub remote_folder: String,
    pub files: BTreeMap<String, Entry>,
}

impl SyncState {
    pub fn load(path: &Path) -> SyncState {
        fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save(&self, path: &Path) -> Res<()> {
        write_atomic(path, &serde_json::to_vec(self).map_err(err)?)
    }
}

#[derive(Clone, Debug)]
pub struct Local {
    pub md5: String,
    pub size: u64,
    pub mtime: u128,
}

#[derive(Debug, PartialEq)]
pub enum Action {
    Upload(String),
    Download(String),
    DeleteLocal(String),
    DeleteRemote(String),
    /// both sides already have the same content
    Record(String),
    /// both sides changed since the last sync
    Conflict(String),
    Forget(String),
}

/// Pure decision table; see the module comment.
pub fn plan(local: &BTreeMap<String, Local>, remote: &BTreeMap<String, RemoteFile>, base: &BTreeMap<String, Entry>) -> Vec<Action> {
    let mut paths: Vec<&String> = local.keys().chain(remote.keys()).chain(base.keys()).collect();
    paths.sort();
    paths.dedup();
    let mut out = vec![];
    for p in paths {
        let (l, r, b) = (local.get(p), remote.get(p), base.get(p).map(|e| e.base.as_str()));
        let p = p.clone();
        match (l, r) {
            (Some(l), Some(r)) => {
                if l.md5 == r.md5 {
                    if b != Some(l.md5.as_str()) {
                        out.push(Action::Record(p));
                    }
                } else if b == Some(l.md5.as_str()) {
                    out.push(Action::Download(p)); // only the remote changed
                } else if b == Some(r.md5.as_str()) {
                    out.push(Action::Upload(p)); // only we changed
                } else {
                    out.push(Action::Conflict(p));
                }
            }
            (Some(l), None) => match b {
                Some(b) if b == l.md5 => out.push(Action::DeleteLocal(p)), // deleted elsewhere, untouched here
                _ => out.push(Action::Upload(p)),                          // new here, or edited here after the remote delete
            },
            (None, Some(r)) => match b {
                Some(b) if b == r.md5 => out.push(Action::DeleteRemote(p)), // deleted here, untouched elsewhere
                _ => out.push(Action::Download(p)),
            },
            (None, None) => out.push(Action::Forget(p)),
        }
    }
    out
}

fn md5_hex(bytes: &[u8]) -> String {
    Md5::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Everything that belongs to the vault and is worth syncing.
const ROOTS: [&str; 5] = ["pages", "files", "history", "kv", ".trash"];

fn scan(root: &Path, cache: &BTreeMap<String, Entry>) -> Res<BTreeMap<String, Local>> {
    let mut out = BTreeMap::new();
    fn walk(root: &Path, dir: &Path, cache: &BTreeMap<String, Entry>, out: &mut BTreeMap<String, Local>) -> Res<()> {
        for e in fs::read_dir(dir).map_err(err)?.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name.ends_with(".tmp") {
                continue; // a write in progress
            }
            let meta = e.metadata().map_err(err)?;
            if meta.is_dir() {
                walk(root, &path, cache, out)?;
                continue;
            }
            let rel = path.strip_prefix(root).map_err(err)?.to_string_lossy().replace('\\', "/");
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
            let md5 = match cache.get(&rel) {
                Some(c) if c.size == meta.len() && c.mtime == mtime && !c.md5.is_empty() => c.md5.clone(),
                _ => md5_hex(&fs::read(&path).map_err(err)?),
            };
            out.insert(rel, Local { md5, size: meta.len(), mtime });
        }
        Ok(())
    }
    for r in ROOTS {
        let d = root.join(r);
        if d.exists() {
            walk(root, &d, cache, &mut out)?;
        }
    }
    let marker = root.join(".noviq/vault.json");
    if let Ok(b) = fs::read(&marker) {
        let m = fs::metadata(&marker).map_err(err)?;
        let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
        out.insert(".noviq/vault.json".into(), Local { md5: md5_hex(&b), size: m.len(), mtime });
    }
    Ok(out)
}

/// Remote paths come from another device (or a hostile account): only known vault locations, no escaping.
fn safe_rel(p: &str) -> bool {
    !p.contains("..") && !p.contains('\\') && !p.starts_with('/') && !p.contains(':') && (p == ".noviq/vault.json" || ROOTS.iter().any(|r| p.starts_with(&format!("{r}/"))))
}


/// Settings files that two devices change independently are merged instead of letting the newer file win:
/// a review done on a phone must not be lost because the laptop saved its own schedule a minute later.
fn merge_kv(path: &str, local: &[u8], remote: &[u8]) -> Option<Vec<u8>> {
    use serde_json::{Map, Value};
    let (a, b): (Value, Value) = (serde_json::from_slice(local).ok()?, serde_json::from_slice(remote).ok()?);
    let (a, b) = (a.as_object()?, b.as_object()?);
    let mut out = Map::new();
    match path {
        // card key -> schedule: the more recently reviewed one wins (older files without `last`: more repetitions, then later due date)
        "kv/srs.json" => {
            let rank = |v: &Value| (v.get("last").and_then(Value::as_i64).unwrap_or(0), v.get("reps").and_then(Value::as_i64).unwrap_or(0), v.get("due").and_then(Value::as_i64).unwrap_or(0));
            for k in a.keys().chain(b.keys()) {
                let v = match (a.get(k), b.get(k)) {
                    (Some(x), Some(y)) => if rank(y) > rank(x) { y } else { x },
                    (Some(x), None) => x,
                    (None, Some(y)) => y,
                    (None, None) => continue,
                };
                out.insert(k.clone(), v.clone());
            }
        }
        // day -> device -> number of reviews: counters only grow, so the larger one per device and day is the truth
        "kv/reviewlog.json" => {
            for day in a.keys().chain(b.keys()) {
                let mut devices = Map::new();
                for side in [a.get(day), b.get(day)].into_iter().flatten().filter_map(Value::as_object) {
                    for (dev, n) in side {
                        let n = n.as_i64().unwrap_or(0);
                        if n > devices.get(dev).and_then(Value::as_i64).unwrap_or(-1) {
                            devices.insert(dev.clone(), Value::from(n));
                        }
                    }
                }
                out.insert(day.clone(), Value::Object(devices));
            }
        }
        _ => return None,
    }
    serde_json::to_vec(&Value::Object(out)).ok()
}
#[derive(Default, Debug)]
pub struct Report {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
}

impl Report {
    pub fn changed(&self) -> bool {
        self.uploaded + self.downloaded + self.deleted + self.conflicts > 0
    }
}

pub fn sync_once(vault: &Vault, remote: &mut dyn Remote, state: &mut SyncState) -> Res<Report> {
    let root = &vault.root;
    let local = scan(root, &state.files)?;
    let mut rmap: BTreeMap<String, RemoteFile> = BTreeMap::new();
    for f in remote.list()? {
        rmap.entry(f.path.clone()).or_insert(f); // a duplicate name (two devices created it at once) is ignored
    }
    let actions = plan(&local, &rmap, &state.files);
    let mut rep = Report::default();
    let mut merged: Vec<(String, RemoteFile)> = vec![];

    let cache = |state: &mut SyncState, p: &str, l: &Local, base: &str, rid: &str| {
        state.files.insert(p.to_string(), Entry { base: base.to_string(), remote_id: rid.to_string(), size: l.size, mtime: l.mtime, md5: l.md5.clone() });
    };

    for a in actions {
        let res: Res<()> = (|| {
            match &a {
                Action::Record(p) => {
                    let (l, r) = (&local[p], &rmap[p]);
                    cache(state, p, l, &l.md5, &r.id);
                }
                Action::Upload(p) => {
                    let l = &local[p];
                    let bytes = fs::read(root.join(p)).map_err(err)?;
                    let up = remote.upload(p, rmap.get(p).map(|r| r.id.as_str()), &bytes)?;
                    cache(state, p, l, &md5_hex(&bytes), &up.id);
                    rep.uploaded += 1;
                }
                Action::Download(p) => {
                    if !safe_rel(p) {
                        return Err(format!("refusing remote path {p}"));
                    }
                    let r = &rmap[p];
                    let bytes = remote.download(r)?;
                    if md5_hex(&bytes) != r.md5 && !r.md5.is_empty() {
                        return Err(format!("download of {p} is corrupt"));
                    }
                    write_atomic(&root.join(p), &bytes)?;
                    let m = fs::metadata(root.join(p)).map_err(err)?;
                    let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                    cache(state, p, &Local { md5: md5_hex(&bytes), size: m.len(), mtime }, &md5_hex(&bytes), &r.id);
                    rep.downloaded += 1;
                }
                Action::DeleteLocal(p) => {
                    if !safe_rel(p) {
                        return Err(format!("refusing remote path {p}"));
                    }
                    let _ = fs::remove_file(root.join(p));
                    state.files.remove(p);
                    rep.deleted += 1;
                }
                Action::DeleteRemote(p) => {
                    let id = state.files.get(p).map(|e| e.remote_id.clone()).unwrap_or_default();
                    if !id.is_empty() {
                        remote.delete(&id)?;
                    }
                    state.files.remove(p);
                    rep.deleted += 1;
                }
                Action::Forget(p) => {
                    state.files.remove(p);
                }
                Action::Conflict(p) => {
                    let (l, r) = (&local[p], &rmap[p]);
                    rep.conflicts += 1;
                    if p.starts_with("pages/") && p.ends_with(".json") {
                        // keep both: the remote copy lands as a conflict copy, which the vault merges (newer wins, older goes to history)
                        let stem = p.trim_start_matches("pages/").trim_end_matches(".json");
                        let bytes = remote.download(r)?;
                        write_atomic(&root.join(format!("pages/{stem} (cloud).json")), &bytes)?;
                        merged.push((p.clone(), r.clone()));
                        // from now on the remote content is the base: the merged result counts as a local change and is uploaded next round
                        state.files.insert(p.clone(), Entry { base: r.md5.clone(), remote_id: r.id.clone(), ..Default::default() });
                    } else if let Some(both) = {
                        let mine = fs::read(root.join(p)).map_err(err)?;
                        let theirs = remote.download(r)?;
                        merge_kv(p, &mine, &theirs)
                    } {
                        // flashcard schedule and review log: keep what either device did
                        write_atomic(&root.join(p), &both)?;
                        let up = remote.upload(p, Some(&r.id), &both)?;
                        state.files.insert(p.clone(), Entry { base: md5_hex(&both), remote_id: up.id, ..Default::default() });
                        rep.uploaded += 1;
                    } else {
                        // anything else: the newer file wins
                        let local_ms = (l.mtime / 1_000_000) as i64;
                        if r.modified_ms > local_ms {
                            let bytes = remote.download(r)?;
                            write_atomic(&root.join(p), &bytes)?;
                            state.files.insert(p.clone(), Entry { base: r.md5.clone(), remote_id: r.id.clone(), ..Default::default() });
                            rep.downloaded += 1;
                        } else {
                            let bytes = fs::read(root.join(p)).map_err(err)?;
                            let up = remote.upload(p, Some(&r.id), &bytes)?;
                            state.files.insert(p.clone(), Entry { base: md5_hex(&bytes), remote_id: up.id, ..Default::default() });
                            rep.uploaded += 1;
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = res {
            rep.errors.push(format!("{a:?}: {e}"));
        }
    }
    if !merged.is_empty() {
        vault.resolve_conflicts();
        // the merged page is the new truth: send it right away unless it is exactly what the cloud already has
        for (p, r) in merged {
            let res: Res<()> = (|| {
                let bytes = fs::read(root.join(&p)).map_err(err)?;
                if md5_hex(&bytes) != r.md5 {
                    let up = remote.upload(&p, Some(&r.id), &bytes)?;
                    state.files.insert(p.clone(), Entry { base: md5_hex(&bytes), remote_id: up.id, ..Default::default() });
                    rep.uploaded += 1;
                } else {
                    state.files.insert(p.clone(), Entry { base: r.md5.clone(), remote_id: r.id.clone(), ..Default::default() });
                }
                Ok(())
            })();
            if let Err(e) = res {
                rep.errors.push(format!("merge {p}: {e}"));
            }
        }
    }
    Ok(rep)
}

#[allow(dead_code)]
pub fn stamp_now() -> i64 {
    now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    #[derive(Default)]
    struct Mem {
        files: Vec<(RemoteFile, Vec<u8>)>,
        clock: i64,
        next: u32,
    }

    #[derive(Clone, Default)]
    struct Shared(Rc<RefCell<Mem>>);

    impl Remote for Shared {
        fn list(&mut self) -> Res<Vec<RemoteFile>> {
            Ok(self.0.borrow().files.iter().map(|(f, _)| f.clone()).collect())
        }
        fn download(&mut self, f: &RemoteFile) -> Res<Vec<u8>> {
            self.0.borrow().files.iter().find(|(x, _)| x.id == f.id).map(|(_, b)| b.clone()).ok_or("gone".to_string())
        }
        fn upload(&mut self, path: &str, existing: Option<&str>, bytes: &[u8]) -> Res<RemoteFile> {
            let mut m = self.0.borrow_mut();
            m.clock += 1000;
            let at = m.clock;
            if let Some(i) = m.files.iter().position(|(f, _)| Some(f.id.as_str()) == existing) {
                m.files[i] = (RemoteFile { id: m.files[i].0.id.clone(), path: path.into(), md5: md5_hex(bytes), modified_ms: at }, bytes.to_vec());
                return Ok(m.files[i].0.clone());
            }
            m.next += 1;
            let f = RemoteFile { id: format!("r{}", m.next), path: path.into(), md5: md5_hex(bytes), modified_ms: at };
            m.files.push((f.clone(), bytes.to_vec()));
            Ok(f)
        }
        fn delete(&mut self, id: &str) -> Res<()> {
            self.0.borrow_mut().files.retain(|(f, _)| f.id != id);
            Ok(())
        }
    }

    struct Device {
        vault: Vault,
        state: SyncState,
        remote: Shared,
    }

    impl Device {
        fn new(name: &str, remote: &Shared, id: Option<&str>) -> Device {
            static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let root: PathBuf = std::env::temp_dir().join(format!("noviq-sync-{name}-{}-{}", now_ms(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
            let _ = fs::remove_dir_all(&root);
            let vault = Vault::create(root, "T").unwrap();
            if let Some(id) = id {
                write_atomic(&vault.root.join(".noviq/vault.json"), json!({ "format": 1, "id": id, "name": "T" }).to_string().as_bytes()).unwrap();
            }
            Device { vault, state: SyncState::default(), remote: remote.clone() }
        }
        fn sync(&mut self) -> Report {
            let r = sync_once(&self.vault, &mut self.remote, &mut self.state).unwrap();
            assert!(r.errors.is_empty(), "{:?}", r.errors);
            r
        }
        fn page(&self, id: &str) -> Option<Value> {
            self.vault.pages_all().unwrap().into_iter().find(|p| p["id"] == id)
        }
        fn save(&self, id: &str, title: &str, at: i64) {
            self.vault.save_pages(&[json!({ "id": id, "title": title, "content": {"type":"doc","content":[]}, "updatedAt": at, "deletedAt": null })], &[], false).unwrap();
        }
    }

    const P1: &str = "11111111-1111-4111-8111-111111111111";
    const P2: &str = "22222222-2222-4222-8222-222222222222";

    fn pair() -> (Device, Device) {
        let remote = Shared::default();
        let a = Device::new("a", &remote, Some("00000000-0000-4000-8000-000000000000"));
        let b = Device::new("b", &remote, Some("00000000-0000-4000-8000-000000000000"));
        (a, b)
    }

    #[test]
    fn page_travels_both_ways_and_second_sync_is_a_noop() {
        let (mut a, mut b) = pair();
        a.save(P1, "hello", 100);
        a.sync();
        b.sync();
        assert_eq!(b.page(P1).unwrap()["title"], "hello");
        b.save(P1, "edited on b", 200);
        b.sync();
        a.sync();
        assert_eq!(a.page(P1).unwrap()["title"], "edited on b");
        assert!(!a.sync().changed() && !b.sync().changed());
    }

    #[test]
    fn different_pages_edited_at_once_both_survive() {
        let (mut a, mut b) = pair();
        a.save(P1, "one", 100);
        a.sync();
        b.sync();
        a.save(P1, "one-a", 200);
        b.save(P2, "two-b", 200);
        a.sync();
        b.sync();
        a.sync();
        assert_eq!(a.page(P2).unwrap()["title"], "two-b");
        assert_eq!(b.page(P1).unwrap()["title"], "one-a");
    }

    #[test]
    fn same_page_edited_on_both_newer_wins_and_older_is_kept() {
        let (mut a, mut b) = pair();
        a.save(P1, "base", 100);
        a.sync();
        b.sync();
        a.save(P1, "from a", 200);
        b.save(P1, "from b", 300);
        a.sync();
        b.sync(); // conflict on b: merges, b is newer
        a.sync();
        b.sync();
        assert_eq!(a.page(P1).unwrap()["title"], "from b");
        assert_eq!(b.page(P1).unwrap()["title"], "from b");
        assert_eq!(b.vault.versions_list(P1).unwrap()[0]["title"], "from a"); // nothing lost
        // the history entry made by the merge travels in the next round; after a few rounds nothing is left to do
        let rounds = (0..5).take_while(|_| a.sync().changed() | b.sync().changed()).count();
        assert!(rounds < 5, "did not settle");
    }

    #[test]
    fn deleting_a_page_reaches_the_other_device() {
        let (mut a, mut b) = pair();
        a.save(P1, "doomed", 100);
        a.sync();
        b.sync();
        a.vault.save_pages(&[], &[P1.to_string()], false).unwrap();
        a.sync();
        b.sync();
        assert!(b.page(P1).is_none());
        assert!(b.vault.root.join(".trash/pages").join(format!("{P1}.json")).exists()); // still recoverable
    }


    #[test]
    fn flashcard_progress_from_two_devices_is_merged() {
        let (mut a, mut b) = pair();
        let put = |d: &Device, name: &str, v: Value| write_atomic(&d.vault.root.join(name), v.to_string().as_bytes()).unwrap();
        let read = |d: &Device, name: &str| -> Value { serde_json::from_slice(&fs::read(d.vault.root.join(name)).unwrap()).unwrap() };
        put(&a, "kv/srs.json", json!({ "p:1": { "reps": 1, "due": 10, "last": 100 } }));
        a.sync();
        b.sync();
        // each device reviews a different card, and both also review card p:1 (b later)
        put(&a, "kv/srs.json", json!({ "p:1": { "reps": 2, "due": 20, "last": 200 }, "p:2": { "reps": 1, "due": 5, "last": 150 } }));
        put(&b, "kv/srs.json", json!({ "p:1": { "reps": 2, "due": 30, "last": 300 }, "p:3": { "reps": 1, "due": 6, "last": 160 } }));
        put(&a, "kv/reviewlog.json", json!({ "2026-10-24": { "A": 5 } }));
        put(&b, "kv/reviewlog.json", json!({ "2026-10-24": { "B": 7 }, "2026-10-23": { "B": 1 } }));
        a.sync();
        b.sync();
        a.sync();
        for d in [&a, &b] {
            let s = read(d, "kv/srs.json");
            assert!(s["p:2"].is_object() && s["p:3"].is_object(), "no review is lost");
            assert_eq!(s["p:1"]["last"], 300, "the later review of the same card wins");
            let l = read(d, "kv/reviewlog.json");
            assert_eq!(l["2026-10-24"], json!({ "A": 5, "B": 7 }));
            assert_eq!(l["2026-10-23"], json!({ "B": 1 }));
        }
    }
    #[test]
    fn remote_paths_cannot_escape_the_vault() {
        assert!(safe_rel("pages/x.json") && safe_rel(".noviq/vault.json"));
        assert!(!safe_rel("../x") && !safe_rel("pages/../../x") && !safe_rel("C:/x") && !safe_rel("other/x") && !safe_rel("/etc/x"));
    }

    #[test]
    fn plan_table() {
        let l = |m: &str| Local { md5: m.into(), size: 0, mtime: 0 };
        let r = |m: &str| RemoteFile { id: "i".into(), path: "p".into(), md5: m.into(), modified_ms: 0 };
        let e = |m: &str| Entry { base: m.into(), remote_id: "i".into(), ..Default::default() };
        let run = |lo: Option<&str>, re: Option<&str>, ba: Option<&str>| {
            let (mut lm, mut rm, mut bm) = (BTreeMap::new(), BTreeMap::new(), BTreeMap::new());
            lo.map(|m| lm.insert("p".to_string(), l(m)));
            re.map(|m| rm.insert("p".to_string(), r(m)));
            ba.map(|m| bm.insert("p".to_string(), e(m)));
            plan(&lm, &rm, &bm)
        };
        assert_eq!(run(Some("a"), None, None), [Action::Upload("p".into())]);
        assert_eq!(run(None, Some("a"), None), [Action::Download("p".into())]);
        assert_eq!(run(Some("b"), Some("a"), Some("a")), [Action::Upload("p".into())]);
        assert_eq!(run(Some("a"), Some("b"), Some("a")), [Action::Download("p".into())]);
        assert_eq!(run(Some("c"), Some("b"), Some("a")), [Action::Conflict("p".into())]);
        assert_eq!(run(Some("a"), None, Some("a")), [Action::DeleteLocal("p".into())]);
        assert_eq!(run(Some("z"), None, Some("a")), [Action::Upload("p".into())]); // edited here after it was deleted elsewhere: keep it
        assert_eq!(run(None, Some("a"), Some("a")), [Action::DeleteRemote("p".into())]);
        assert_eq!(run(None, None, Some("a")), [Action::Forget("p".into())]);
        assert!(run(Some("a"), Some("a"), Some("a")).is_empty());
    }
}
