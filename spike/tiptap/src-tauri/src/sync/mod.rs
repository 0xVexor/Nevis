//! Sync of a vault with a remote copy (the Noviq sync server, see hub.rs) without any help from the user.
//! The engine is independent of the remote: it only needs the `Remote` trait, so it is tested with an in-memory one.
//!
//! Method: a file-level three-way comparison. For every path the engine knows the local content hash, the remote
//! content hash and `base`, the hash both sides agreed on at the last sync. Whoever differs from `base` changed.
//!
//! Safety rules (docs/sync-design-research.md): a file that is merely *absent* is not proof of a deletion, so
//! nothing runs against a vault or a cloud folder that is not there (preflight), a sync that would delete a lot waits
//! for the user, nothing is ever deleted outright (it goes to the trash of the vault / of the server), and a file that
//! changed while we were talking to the server is never overwritten.

pub mod account;
pub mod hub;

use crate::vault::{err, now_ms, write_atomic, Res, Vault, VAULT_MISMATCH, VAULT_MISSING};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// The cloud copy of the vault does not exist (any more): deleted on the server or from another device, or a wrong account.
pub const CLOUD_GONE: &str = "CLOUD_GONE";

#[derive(Clone, Debug)]
pub struct RemoteFile {
    pub id: String,
    pub path: String,
    pub md5: String,
    pub modified_ms: i64,
}

pub trait Remote {
    /// The cloud folder is there and usable; `Err(CLOUD_GONE)` when it is not.
    fn check(&mut self) -> Res<()>;
    fn list(&mut self) -> Res<Vec<RemoteFile>>;
    fn download(&mut self, f: &RemoteFile) -> Res<Vec<u8>>;
    /// Creates the file, or replaces its content when `existing` is the id of the current remote file.
    fn upload(&mut self, path: &str, existing: Option<&str>, bytes: &[u8]) -> Res<RemoteFile>;
    /// The file as it is right now; `None` when it is gone or in the trash.
    fn get(&mut self, id: &str) -> Res<Option<RemoteFile>>;
    /// Moves the file to the trash of the remote (never an outright delete).
    fn trash(&mut self, id: &str) -> Res<()>;
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
    /// The account and server this state belongs to (`user@server`). Another account is another cloud: the bookkeeping starts over.
    #[serde(default)]
    pub account: String,
    /// What this device knows about the server's copy; see hub.rs.
    #[serde(default)]
    pub hub: hub::Cache,
    pub files: BTreeMap<String, Entry>,
    /// The user confirmed the deletions that were held back; used up by the next sync.
    #[serde(default)]
    pub allow_deletes_once: bool,
}

impl SyncState {
    /// A state file that cannot be read is moved aside and the sync starts from a clean slate: without `base` the
    /// engine only adds (uploads what is only here, downloads what is only there) and never deletes.
    pub fn load(path: &Path) -> SyncState {
        match fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|_| {
                let _ = fs::rename(path, path.with_extension("corrupt"));
                SyncState::default()
            }),
            Err(_) => SyncState::default(),
        }
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

/// Pure decision table; see the module comment. Paths in `unknown` (could not be read right now) are left alone.
pub fn plan(local: &BTreeMap<String, Local>, remote: &BTreeMap<String, RemoteFile>, base: &BTreeMap<String, Entry>, unknown: &BTreeSet<String>) -> Vec<Action> {
    let mut paths: Vec<&String> = local.keys().chain(remote.keys()).chain(base.keys()).collect();
    paths.sort();
    paths.dedup();
    let mut out = vec![];
    for p in paths {
        if unknown.contains(p) {
            continue; // a file we cannot see is neither deleted nor changed
        }
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

/// Deletions wait for the user when they look like a mistake instead of an edit: many at once, all of them, or
/// one side is empty although we know it had files (an unplugged drive, a broken listing, a wiped cloud).
fn hold_deletes(deletes: usize, tracked: usize, local_empty: bool, remote_empty: bool) -> bool {
    deletes > 0 && (deletes > 5usize.max(tracked / 5) || (tracked >= 5 && deletes == tracked) || ((local_empty || remote_empty) && tracked > 0))
}

fn md5_hex(bytes: &[u8]) -> String {
    Md5::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Everything that belongs to the vault and is worth syncing.
const ROOTS: [&str; 5] = ["pages", "files", "history", "kv", ".trash"];

fn mtime_of(meta: &fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos())
}

/// The local files, and the paths that exist but could not be read right now (locked by another program...).
fn scan(root: &Path, cache: &BTreeMap<String, Entry>) -> Res<(BTreeMap<String, Local>, BTreeSet<String>)> {
    let mut out = BTreeMap::new();
    let mut unknown = BTreeSet::new();
    fn walk(root: &Path, dir: &Path, cache: &BTreeMap<String, Entry>, out: &mut BTreeMap<String, Local>, unknown: &mut BTreeSet<String>) -> Res<()> {
        // a folder we cannot list would make all its files look deleted: that is an error, not "unknown"
        for e in fs::read_dir(dir).map_err(err)?.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name.ends_with(".tmp") {
                continue; // a write in progress
            }
            let rel = path.strip_prefix(root).map_err(err)?.to_string_lossy().replace('\\', "/");
            let Ok(meta) = e.metadata() else {
                unknown.insert(rel);
                continue;
            };
            if meta.is_dir() {
                walk(root, &path, cache, out, unknown)?;
                continue;
            }
            let mtime = mtime_of(&meta);
            let md5 = match cache.get(&rel) {
                Some(c) if c.size == meta.len() && c.mtime == mtime && !c.md5.is_empty() => c.md5.clone(),
                _ => match fs::read(&path) {
                    Ok(b) => md5_hex(&b),
                    Err(_) => {
                        unknown.insert(rel);
                        continue;
                    }
                },
            };
            out.insert(rel, Local { md5, size: meta.len(), mtime });
        }
        Ok(())
    }
    for r in ROOTS {
        let d = root.join(r);
        if d.exists() {
            walk(root, &d, cache, &mut out, &mut unknown)?;
        }
    }
    let marker = root.join(".noviq/vault.json");
    match fs::read(&marker) {
        Ok(b) => {
            let m = fs::metadata(&marker).map_err(err)?;
            out.insert(".noviq/vault.json".into(), Local { md5: md5_hex(&b), size: m.len(), mtime: mtime_of(&m) });
        }
        Err(_) => {
            unknown.insert(".noviq/vault.json".into());
        }
    }
    Ok((out, unknown))
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
    /// left for the next round because the file changed while we were busy
    pub skipped: usize,
    /// deletions that wait for the user's confirmation
    pub held: usize,
    /// duplicate files of the same name that were cleaned up in the cloud
    pub deduped: usize,
    pub errors: Vec<String>,
}

impl Report {
    pub fn changed(&self) -> bool {
        self.uploaded + self.downloaded + self.deleted + self.conflicts > 0
    }
}

/// True when the file is not what the scan saw any more (edited, deleted or created since).
fn changed_since(path: &Path, md5: Option<&str>) -> bool {
    match (fs::read(path), md5) {
        (Ok(b), Some(m)) => md5_hex(&b) != m,
        (Ok(_), None) => true,
        (Err(_), Some(_)) => true,
        (Err(_), None) => path.exists(),
    }
}

/// Uploads and checks that the cloud stored what we sent; one more try before giving up on a damaged upload.
fn verified_upload(remote: &mut dyn Remote, path: &str, existing: Option<&str>, bytes: &[u8]) -> Res<RemoteFile> {
    let want = md5_hex(bytes);
    let mut up = remote.upload(path, existing, bytes)?;
    if !up.md5.is_empty() && up.md5 != want {
        up = remote.upload(path, Some(&up.id), bytes)?;
        if !up.md5.is_empty() && up.md5 != want {
            return Err(format!("upload of {path} is corrupt"));
        }
    }
    Ok(up)
}

/// A remote may hold several files of the same name (Drive did; the Noviq server cannot). Pick one
/// the same way on every device, keep the content of the others in the sync trash and trash them in the cloud.
fn dedupe(vault: &Vault, remote: &mut dyn Remote, listed: Vec<RemoteFile>, rep: &mut Report) -> BTreeMap<String, RemoteFile> {
    let mut groups: BTreeMap<String, Vec<RemoteFile>> = BTreeMap::new();
    for f in listed {
        groups.entry(f.path.clone()).or_default().push(f);
    }
    let mut out = BTreeMap::new();
    for (path, mut files) in groups {
        files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.id.cmp(&b.id)));
        let winner = files.remove(0);
        for dup in files {
            if !safe_rel(&path) {
                break;
            }
            let kept = dup.md5 == winner.md5 || remote.download(&dup).and_then(|b| vault.sync_trash_put(&path, &b)).is_ok();
            if !kept {
                continue; // its content could not be kept: leave it where it is
            }
            match remote.trash(&dup.id) {
                Ok(()) => rep.deduped += 1,
                Err(e) => rep.errors.push(format!("duplicate {path}: {e}")),
            }
        }
        out.insert(path, winner);
    }
    out
}

/// One synchronization. `progress` is called every now and then with the bookkeeping so far, so that a crash or a
/// lost connection in the middle costs only the work since then.
pub fn sync_once(vault: &Vault, remote: &mut dyn Remote, state: &mut SyncState, progress: &mut dyn FnMut(&SyncState)) -> Res<Report> {
    let root = &vault.root;
    // preflight: nothing below may run against a vault or a cloud folder that is not there
    if !root.is_dir() || vault.id().is_empty() {
        return Err(VAULT_MISSING.into());
    }
    remote.check()?;
    let (local, unknown) = scan(root, &state.files)?;
    let mut rep = Report::default();
    let listed = remote.list()?;
    let rmap = dedupe(vault, remote, listed, &mut rep);
    let mut actions = plan(&local, &rmap, &state.files, &unknown);

    let deletes = actions.iter().filter(|a| matches!(a, Action::DeleteLocal(_) | Action::DeleteRemote(_))).count();
    if hold_deletes(deletes, state.files.len(), local.is_empty(), rmap.is_empty()) && !state.allow_deletes_once {
        rep.held = deletes;
        actions.retain(|a| !matches!(a, Action::DeleteLocal(_) | Action::DeleteRemote(_)));
    }
    state.allow_deletes_once = false;

    let mut merged: Vec<(String, RemoteFile)> = vec![];

    let cache = |state: &mut SyncState, p: &str, l: &Local, base: &str, rid: &str| {
        state.files.insert(p.to_string(), Entry { base: base.to_string(), remote_id: rid.to_string(), size: l.size, mtime: l.mtime, md5: l.md5.clone() });
    };

    let mut done = 0usize;
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
                    // the cloud copy may have been replaced since we listed it: then this is a conflict for the next round
                    let existing = match rmap.get(p) {
                        Some(r) => match remote.get(&r.id)? {
                            Some(cur) if cur.md5 != r.md5 => {
                                rep.skipped += 1;
                                return Ok(());
                            }
                            Some(_) => Some(r.id.clone()),
                            None => None,
                        },
                        None => None,
                    };
                    let up = verified_upload(remote, p, existing.as_deref(), &bytes)?;
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
                    // an edit made here while we were downloading must not be overwritten: next round it is a conflict
                    if changed_since(&root.join(p), local.get(p).map(|l| l.md5.as_str())) {
                        rep.skipped += 1;
                        return Ok(());
                    }
                    write_atomic(&root.join(p), &bytes)?;
                    let m = fs::metadata(root.join(p)).map_err(err)?;
                    cache(state, p, &Local { md5: md5_hex(&bytes), size: m.len(), mtime: mtime_of(&m) }, &md5_hex(&bytes), &r.id);
                    rep.downloaded += 1;
                }
                Action::DeleteLocal(p) => {
                    if !safe_rel(p) {
                        return Err(format!("refusing remote path {p}"));
                    }
                    if p == ".noviq/vault.json" {
                        rep.skipped += 1; // the identity of the vault is never removed by a sync
                        return Ok(());
                    }
                    // proof that it is really gone from the cloud, not just missing from a listing
                    if let Some(e) = state.files.get(p).filter(|e| !e.remote_id.is_empty()) {
                        if remote.get(&e.remote_id)?.is_some() {
                            rep.skipped += 1;
                            return Ok(());
                        }
                    }
                    if changed_since(&root.join(p), local.get(p).map(|l| l.md5.as_str())) {
                        rep.skipped += 1;
                        return Ok(());
                    }
                    vault.sync_trash_move(p)?; // recoverable for 30 days; when it fails the file stays and so does `base`
                    state.files.remove(p);
                    rep.deleted += 1;
                }
                Action::DeleteRemote(p) => {
                    let id = rmap.get(p).map(|r| r.id.clone()).or_else(|| state.files.get(p).map(|e| e.remote_id.clone())).unwrap_or_default();
                    if !id.is_empty() {
                        remote.trash(&id)?;
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
                    if p == ".noviq/vault.json" && !state.files.contains_key(p) {
                        // first sync of a vault that was downloaded: its identity and name are the cloud's
                        let theirs = remote.download(r)?;
                        let id_of = |b: &[u8]| serde_json::from_slice::<serde_json::Value>(b).ok().and_then(|v| v.get("id").and_then(|i| i.as_str().map(String::from)));
                        if id_of(&theirs) != id_of(&fs::read(root.join(p)).map_err(err)?) {
                            return Err(VAULT_MISMATCH.into());
                        }
                        write_atomic(&root.join(p), &theirs)?;
                        state.files.insert(p.clone(), Entry { base: r.md5.clone(), remote_id: r.id.clone(), ..Default::default() });
                        rep.downloaded += 1;
                    } else if p.starts_with("pages/") && p.ends_with(".json") {
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
                        let up = verified_upload(remote, p, Some(&r.id), &both)?;
                        state.files.insert(p.clone(), Entry { base: md5_hex(&both), remote_id: up.id, ..Default::default() });
                        rep.uploaded += 1;
                    } else {
                        // anything else: the newer file wins, the other version waits in the sync trash
                        let local_ms = (l.mtime / 1_000_000) as i64;
                        if r.modified_ms > local_ms {
                            let mine = fs::read(root.join(p)).map_err(err)?;
                            let bytes = remote.download(r)?;
                            vault.sync_trash_put(p, &mine)?;
                            write_atomic(&root.join(p), &bytes)?;
                            state.files.insert(p.clone(), Entry { base: r.md5.clone(), remote_id: r.id.clone(), ..Default::default() });
                            rep.downloaded += 1;
                        } else {
                            let theirs = remote.download(r)?;
                            vault.sync_trash_put(p, &theirs)?;
                            let bytes = fs::read(root.join(p)).map_err(err)?;
                            let up = verified_upload(remote, p, Some(&r.id), &bytes)?;
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
        done += 1;
        if done % 25 == 0 {
            progress(state);
        }
    }
    if !merged.is_empty() {
        vault.resolve_conflicts();
        // the merged page is the new truth: send it right away unless it is exactly what the cloud already has
        for (p, r) in merged {
            let res: Res<()> = (|| {
                let bytes = fs::read(root.join(&p)).map_err(err)?;
                if md5_hex(&bytes) != r.md5 {
                    let up = verified_upload(remote, &p, Some(&r.id), &bytes)?;
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
        trashed: Vec<(RemoteFile, Vec<u8>)>,
        clock: i64,
        next: u32,
        gone: bool,            // the cloud folder does not exist any more
        hide_all: bool,        // the listing answers nothing (a broken listing)
        corrupt_uploads: bool, // the cloud reports another md5 than what was sent
        on_download: Option<Rc<dyn Fn()>>,
        on_get: Option<Rc<dyn Fn()>>,
    }

    #[derive(Clone, Default)]
    struct Shared(Rc<RefCell<Mem>>);

    impl Shared {
        /// A file created by "another device" directly in the cloud.
        fn put(&self, path: &str, bytes: &[u8], modified_ms: i64) -> RemoteFile {
            let mut m = self.0.borrow_mut();
            m.next += 1;
            let f = RemoteFile { id: format!("x{}", m.next), path: path.into(), md5: md5_hex(bytes), modified_ms };
            m.files.push((f.clone(), bytes.to_vec()));
            f
        }
    }

    impl Remote for Shared {
        fn check(&mut self) -> Res<()> {
            if self.0.borrow().gone { Err(CLOUD_GONE.into()) } else { Ok(()) }
        }
        fn list(&mut self) -> Res<Vec<RemoteFile>> {
            let m = self.0.borrow();
            Ok(if m.hide_all { vec![] } else { m.files.iter().map(|(f, _)| f.clone()).collect() })
        }
        fn download(&mut self, f: &RemoteFile) -> Res<Vec<u8>> {
            let hook = self.0.borrow().on_download.clone();
            if let Some(h) = hook {
                h();
            }
            self.0.borrow().files.iter().find(|(x, _)| x.id == f.id).map(|(_, b)| b.clone()).ok_or("gone".to_string())
        }
        fn upload(&mut self, path: &str, existing: Option<&str>, bytes: &[u8]) -> Res<RemoteFile> {
            let mut m = self.0.borrow_mut();
            m.clock += 1000;
            let at = m.clock;
            let mut out = if let Some(i) = m.files.iter().position(|(f, _)| Some(f.id.as_str()) == existing) {
                m.files[i] = (RemoteFile { id: m.files[i].0.id.clone(), path: path.into(), md5: md5_hex(bytes), modified_ms: at }, bytes.to_vec());
                m.files[i].0.clone()
            } else {
                m.next += 1;
                let f = RemoteFile { id: format!("r{}", m.next), path: path.into(), md5: md5_hex(bytes), modified_ms: at };
                m.files.push((f.clone(), bytes.to_vec()));
                f
            };
            if m.corrupt_uploads {
                out.md5 = "bad".into();
            }
            Ok(out)
        }
        fn get(&mut self, id: &str) -> Res<Option<RemoteFile>> {
            let hook = self.0.borrow().on_get.clone();
            if let Some(h) = hook {
                h();
            }
            Ok(self.0.borrow().files.iter().find(|(f, _)| f.id == id).map(|(f, _)| f.clone()))
        }
        fn trash(&mut self, id: &str) -> Res<()> {
            let mut m = self.0.borrow_mut();
            if let Some(i) = m.files.iter().position(|(f, _)| f.id == id) {
                let x = m.files.remove(i);
                m.trashed.push(x);
            }
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
        fn try_sync(&mut self) -> Res<Report> {
            sync_once(&self.vault, &mut self.remote, &mut self.state, &mut |_| {})
        }
        fn sync(&mut self) -> Report {
            let r = self.try_sync().unwrap();
            assert!(r.errors.is_empty(), "{:?}", r.errors);
            r
        }
        fn page(&self, id: &str) -> Option<Value> {
            self.vault.pages_all().unwrap().into_iter().find(|p| p["id"] == id)
        }
        fn save(&self, id: &str, title: &str, at: i64) {
            self.vault.save_pages(&[json!({ "id": id, "title": title, "content": {"type":"doc","content":[]}, "updatedAt": at, "deletedAt": null })], &[], false).unwrap();
        }
        fn page_count(&self) -> usize {
            self.vault.pages_all().unwrap().len()
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

    /// Does the sync trash of `v` hold `rel` with exactly this content?
    fn trash_has(v: &Vault, rel: &str, content: &[u8]) -> bool {
        fs::read_dir(v.sync_trash_dir()).into_iter().flatten().flatten().any(|e| fs::read(e.path().join(rel)).is_ok_and(|b| b == content))
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
        // the page file itself went to the sync trash, not into the void
        assert!(fs::read_dir(b.vault.sync_trash_dir()).unwrap().count() >= 1);
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
            plan(&lm, &rm, &bm, &BTreeSet::new())
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

    #[test]
    fn a_file_that_cannot_be_seen_is_left_alone() {
        let r = RemoteFile { id: "i".into(), path: "p".into(), md5: "a".into(), modified_ms: 0 };
        let rm = BTreeMap::from([("p".to_string(), r)]);
        let bm = BTreeMap::from([("p".to_string(), Entry { base: "a".into(), remote_id: "i".into(), ..Default::default() })]);
        // not in the local scan only because it could not be read: that is not "deleted here"
        assert_eq!(plan(&BTreeMap::new(), &rm, &bm, &BTreeSet::new()), [Action::DeleteRemote("p".into())]);
        assert!(plan(&BTreeMap::new(), &rm, &bm, &BTreeSet::from(["p".to_string()])).is_empty());
    }

    #[test]
    fn deletions_are_held_back_when_they_look_like_a_mistake() {
        assert!(!hold_deletes(0, 100, true, true));
        assert!(!hold_deletes(1, 100, false, false)); // an ordinary delete
        assert!(!hold_deletes(5, 20, false, false));
        assert!(hold_deletes(6, 20, false, false)); // more than the threshold
        assert!(hold_deletes(30, 100, false, false)); // more than 20%
        assert!(hold_deletes(5, 5, false, false)); // everything
        assert!(hold_deletes(1, 10, true, false)); // the local side is empty although we know files
        assert!(hold_deletes(1, 10, false, true)); // so is the cloud
        assert!(!hold_deletes(1, 0, true, true)); // nothing was ever synced: nothing to lose
    }

    // ───── lifecycle: a vault or a cloud that is not there must never turn into deletions ─────

    #[test]
    fn a_vanished_vault_folder_never_deletes_the_cloud() {
        let (mut a, _b) = pair();
        for (i, id) in [P1, P2].iter().enumerate() {
            a.save(id, "x", 100 + i as i64);
        }
        a.sync();
        let before = a.remote.0.borrow().files.len();
        assert!(before >= 2);
        fs::remove_dir_all(&a.vault.root).unwrap();
        assert_eq!(a.try_sync().err().as_deref(), Some(VAULT_MISSING));
        // the folder came back empty, without its marker (what the old `open` did): still nothing happens
        fs::create_dir_all(&a.vault.root).unwrap();
        assert_eq!(a.try_sync().err().as_deref(), Some(VAULT_MISSING));
        assert_eq!(a.remote.0.borrow().files.len(), before);
        assert!(a.remote.0.borrow().trashed.is_empty());
    }

    #[test]
    fn a_vault_that_lost_all_its_files_waits_for_the_user() {
        let (mut a, _b) = pair();
        for i in 0..8 {
            a.save(&format!("{i:08}-1111-4111-8111-111111111111"), "x", 100);
        }
        a.sync();
        for e in fs::read_dir(a.vault.pages_dir()).unwrap().flatten() {
            fs::remove_file(e.path()).unwrap();
        }
        let before = a.remote.0.borrow().files.len();
        let r = a.sync();
        assert_eq!(r.held, 8, "held for confirmation");
        assert_eq!((r.deleted, a.remote.0.borrow().files.len()), (0, before));
        // the user confirms: the pages go to the trash of the cloud, not into the void
        a.state.allow_deletes_once = true;
        let r = a.sync();
        assert_eq!(r.held, 0);
        assert_eq!(a.remote.0.borrow().trashed.len(), 8);
    }

    #[test]
    fn a_wiped_cloud_listing_never_deletes_local_files() {
        let (mut a, _b) = pair();
        a.save(P1, "mine", 100);
        a.save(P2, "mine too", 100);
        a.sync();
        a.remote.0.borrow_mut().hide_all = true;
        let r = a.sync();
        assert!(r.held > 0 && r.deleted == 0);
        assert_eq!(a.page_count(), 2);
    }

    #[test]
    fn a_cloud_folder_that_is_gone_stops_the_sync() {
        let (mut a, _b) = pair();
        a.save(P1, "mine", 100);
        a.sync();
        a.remote.0.borrow_mut().gone = true;
        assert_eq!(a.try_sync().err().as_deref(), Some(CLOUD_GONE));
        assert_eq!(a.page_count(), 1);
    }

    #[test]
    fn a_state_file_that_cannot_be_read_means_a_clean_slate_without_deletions() {
        let (mut a, mut b) = pair();
        a.save(P1, "one", 100);
        b.save(P2, "two", 100);
        a.sync();
        b.sync();
        a.sync();
        let file = std::env::temp_dir().join(format!("noviq-state-{}.json", now_ms()));
        fs::write(&file, b"{ this is not json").unwrap();
        a.state = SyncState::load(&file);
        assert!(a.state.files.is_empty() && file.with_extension("corrupt").exists());
        let r = a.sync();
        assert_eq!((r.deleted, r.held), (0, 0));
        assert_eq!((a.page_count(), b.page_count()), (2, 2));
    }

    // ───── concurrency: a file that changed while we were busy is not overwritten ─────

    #[test]
    fn an_edit_made_while_downloading_is_not_overwritten() {
        let (mut a, mut b) = pair();
        a.save(P1, "v1", 100);
        a.sync();
        b.sync();
        a.save(P1, "v2", 200);
        a.sync();
        // while b downloads v2, the user edits the page on b
        let root = b.vault.root.clone();
        b.remote.0.borrow_mut().on_download = Some(Rc::new(move || {
            let v = Vault { root: root.clone() };
            v.save_pages(&[json!({ "id": P1, "title": "typed on b", "content": {"type":"doc","content":[]}, "updatedAt": 500, "deletedAt": null })], &[], false).unwrap();
        }));
        let r = b.sync();
        assert_eq!(r.skipped, 1);
        assert_eq!(b.page(P1).unwrap()["title"], "typed on b", "the edit survives");
        // next rounds: both versions changed, the newer one wins and the other is in the history
        b.remote.0.borrow_mut().on_download = None;
        b.sync();
        a.sync();
        b.sync();
        assert_eq!(a.page(P1).unwrap()["title"], "typed on b");
        assert!(b.vault.versions_list(P1).unwrap().iter().any(|v| v["title"] == "v2"), "v2 is kept");
    }

    #[test]
    fn an_upload_over_a_cloud_file_that_changed_meanwhile_becomes_a_conflict() {
        let (mut a, mut b) = pair();
        a.save(P1, "v1", 100);
        a.sync();
        b.sync();
        a.save(P1, "from a", 200);
        // between listing and uploading, b's version reaches the cloud
        let cloud = a.remote.clone();
        let theirs = json!({ "id": P1, "title": "from b", "content": {"type":"doc","content":[]}, "updatedAt": 300, "deletedAt": null }).to_string();
        a.remote.0.borrow_mut().on_get = Some(Rc::new(move || {
            let id = cloud.0.borrow().files.iter().find(|(f, _)| f.path == format!("pages/{P1}.json")).map(|(f, _)| f.id.clone()).unwrap();
            let mut m = cloud.0.borrow_mut();
            let i = m.files.iter().position(|(f, _)| f.id == id).unwrap();
            m.files[i].0.md5 = md5_hex(theirs.as_bytes());
            m.files[i].1 = theirs.clone().into_bytes();
        }));
        let r = a.sync();
        assert_eq!(r.skipped, 1);
        let cloud_copy = a.remote.0.borrow().files.iter().find(|(f, _)| f.path == format!("pages/{P1}.json")).map(|(_, b)| b.clone()).unwrap();
        assert!(String::from_utf8(cloud_copy).unwrap().contains("from b"), "the other device's version is still in the cloud");
        a.remote.0.borrow_mut().on_get = None;
        a.sync();
        b.sync();
        a.sync();
        assert_eq!(a.page(P1).unwrap()["title"], "from b"); // newer
        assert!(a.vault.versions_list(P1).unwrap().iter().any(|v| v["title"] == "from a"));
    }

    #[test]
    fn a_damaged_upload_is_not_recorded_as_synced() {
        let (mut a, _b) = pair();
        a.save(P1, "x", 100);
        a.remote.0.borrow_mut().corrupt_uploads = true;
        let r = a.try_sync().unwrap();
        assert!(!r.errors.is_empty());
        assert!(!a.state.files.contains_key(&format!("pages/{P1}.json")));
    }

    #[test]
    fn the_loser_of_a_conflict_in_another_file_is_kept() {
        let (mut a, mut b) = pair();
        let put = |d: &Device, v: &str| write_atomic(&d.vault.root.join("kv/other.json"), v.as_bytes()).unwrap();
        put(&a, "{\"v\":1}");
        a.sync();
        b.sync();
        put(&a, "{\"v\":\"a\"}");
        put(&b, "{\"v\":\"b\"}");
        a.sync();
        b.sync();
        a.sync();
        let winner = fs::read(a.vault.root.join("kv/other.json")).unwrap();
        let loser: &[u8] = if winner == b"{\"v\":\"b\"}" { b"{\"v\":\"a\"}" } else { b"{\"v\":\"b\"}" };
        assert!(trash_has(&a.vault, "kv/other.json", loser) || trash_has(&b.vault, "kv/other.json", loser), "the other version is in a sync trash");
    }

    #[test]
    fn duplicate_files_in_the_cloud_are_resolved_the_same_way_everywhere() {
        let (mut a, mut b) = pair();
        a.save(P1, "x", 100);
        a.sync();
        let path = format!("pages/{P1}.json");
        // a retried upload left a second file of the same name, with other content
        a.remote.put(&path, b"{\"older\":true}", 1);
        let r = a.sync();
        assert_eq!(r.deduped, 1);
        assert_eq!(a.remote.0.borrow().files.iter().filter(|(f, _)| f.path == path).count(), 1);
        assert_eq!(a.remote.0.borrow().trashed.len(), 1);
        assert!(trash_has(&a.vault, &path, b"{\"older\":true}"), "its content is kept");
        b.sync();
        assert_eq!(b.page(P1).unwrap()["title"], "x");
    }

    #[test]
    fn the_name_of_a_downloaded_vault_comes_from_the_cloud() {
        let (mut a, _b) = pair();
        a.save(P1, "x", 100);
        a.sync();
        // a new device downloads the vault: its marker is made from the name the user typed
        let remote = a.remote.clone();
        let mut c = Device::new("c", &remote, Some("00000000-0000-4000-8000-000000000000"));
        c.vault.rename("Another name").unwrap();
        c.sync();
        assert_eq!(c.vault.name(), "T");
        assert_eq!(a.remote.0.borrow().files.iter().filter(|(f, _)| f.path == ".noviq/vault.json").count(), 1);
        // a marker of another vault is refused
        let mut d = Device::new("d", &remote, Some("99999999-9999-4999-8999-999999999999"));
        let r = d.try_sync().unwrap();
        assert!(r.errors.iter().any(|e| e.contains(VAULT_MISMATCH)));
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_file_does_not_stop_the_sync_or_get_deleted() {
        use std::os::windows::fs::OpenOptionsExt;
        let (mut a, _b) = pair();
        a.save(P1, "locked", 100);
        a.save(P2, "free", 100);
        a.sync();
        let _lock = fs::OpenOptions::new().read(true).share_mode(0).open(a.vault.pages_dir().join(format!("{P1}.json"))).unwrap();
        // the locked file is "unknown": the other page still syncs, nothing is deleted in the cloud
        a.save(P2, "free, edited", 200);
        let r = a.sync();
        assert_eq!(r.uploaded, 1);
        assert!(a.remote.0.borrow().files.iter().any(|(f, _)| f.path == format!("pages/{P1}.json")));
    }
}
