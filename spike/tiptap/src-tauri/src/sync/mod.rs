//! Sync of a vault with a remote copy (the Nevis sync server, see hub.rs) without any help from the user.
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
pub mod snapshot;

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
    /// Check protocol compatibility before any file is changed or removed.
    fn validate_paths(&mut self, _paths: &[String]) -> Res<()> { Ok(()) }
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
    /// The last few contents (md5, oldest first, ending with `base`) this device has synced for the path. A local file
    /// that equals an earlier one while the cloud still holds `base` is a restore of old bytes, not an edit.
    #[serde(default)]
    pub seen: Vec<String>,
}

/// How many earlier contents per path are remembered in `Entry::seen`.
const SEEN_MAX: usize = 8;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct SyncState {
    /// The local folder whose absence/changes the baseline describes.
    #[serde(default)]
    pub local_root: String,
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
    pub fn reset_local_baseline(&mut self) {
        self.files.clear();
        self.allow_deletes_once = false;
    }

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
                    // only we changed, unless the file went back to an earlier synced content (an older copy of the folder
                    // was restored over it): then it is no edit, and the conflict rules decide so that the newer remote is not overwritten
                    out.push(if is_revert(&l.md5, base.get(&p)) { Action::Conflict(p) } else { Action::Upload(p) });
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

/// The file differs from what the last sync recorded but equals a content this device synced before: not an edit, a restore of old bytes.
fn is_revert(md5: &str, entry: Option<&Entry>) -> bool {
    entry.is_some_and(|e| md5 != e.base && e.seen.iter().any(|m| m == md5))
}

/// Records what a sync left behind for `p`, keeping the ring of earlier contents (`Entry::seen`) up to date.
fn track(state: &mut SyncState, p: &str, l: &Local, base: &str, remote_id: &str) {
    let mut seen = state.files.get(p).map(|e| e.seen.clone()).unwrap_or_default();
    seen.retain(|m| m != base);
    seen.push(base.to_string());
    if seen.len() > SEEN_MAX {
        seen.drain(..seen.len() - SEEN_MAX);
    }
    state.files.insert(p.to_string(), Entry { base: base.to_string(), remote_id: remote_id.to_string(), size: l.size, mtime: l.mtime, md5: l.md5.clone(), seen });
}

/// Like `track`, with the local cache fields taken from the file as it is now (an unreadable file just means a re-hash next time).
fn track_current(state: &mut SyncState, root: &Path, p: &str, base: &str, remote_id: &str) {
    let path = root.join(p);
    // metadata first: a write after this only makes the next scan hash the file again
    let meta = fs::metadata(&path).ok();
    let md5 = fs::read(&path).map(|b| md5_hex(&b)).unwrap_or_default();
    let l = match meta {
        Some(m) if !md5.is_empty() => Local { md5, size: m.len(), mtime: mtime_of(&m) },
        _ => Local { md5: String::new(), size: 0, mtime: 0 },
    };
    track(state, p, &l, base, remote_id);
}

/// Content paths are the ones under the ROOTS; the vault marker is not content (it always exists on both sides).
fn is_content(p: &str) -> bool {
    p.split_once('/').is_some_and(|(top, _)| ROOTS.contains(&top))
}

/// Whether the app writes a tombstone when it deletes this file. Other synced files (history trims, the trash,
/// version deletes) disappear without one, so their absence says nothing either way.
fn deletion_is_tombstoned_by_app(p: &str) -> bool {
    match p.strip_prefix("pages/").and_then(|f| f.strip_suffix(".json")) {
        Some(id) => crate::vault::check_id(id).is_ok(),
        None => p.starts_with("databases/") && snapshot::safe_path(p).is_ok(),
    }
}

/// Deletions wait for the user when they look like a mistake instead of an edit: many at once, all of them, or
/// one side is empty although we know it had files (an unplugged drive, a broken listing, a wiped cloud).
fn hold_deletes(deletes: usize, tracked: usize, local_empty: bool, remote_empty: bool) -> bool {
    deletes > 0 && (deletes > 5usize.max(tracked / 5) || (tracked >= 5 && deletes >= tracked) || ((local_empty || remote_empty) && tracked > 0))
}

fn md5_hex(bytes: &[u8]) -> String {
    Md5::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Everything that belongs to the vault and is worth syncing.
const ROOTS: [&str; 6] = ["pages", "files", "history", "kv", ".trash", "databases"];

fn mtime_of(meta: &fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos())
}

/// The local files, and the paths that exist but could not be read right now (locked by another program...).
fn scan(root: &Path, cache: &BTreeMap<String, Entry>) -> Res<(BTreeMap<String, Local>, BTreeSet<String>)> {
    let mut out = BTreeMap::new();
    let mut unknown = BTreeSet::new();
    fn walk(root: &Path, dir: &Path, cache: &BTreeMap<String, Entry>, out: &mut BTreeMap<String, Local>, unknown: &mut BTreeSet<String>) -> Res<()> {
        // a folder we cannot list would make all its files look deleted: that is an error, not "unknown"
        for e in fs::read_dir(dir).map_err(err)? {
            let e = e.map_err(err)?;
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name.ends_with(".tmp") {
                continue; // a write in progress
            }
            let relative = path.strip_prefix(root).map_err(err)?;
            let Some(relative) = relative.to_str() else {
                // a name that is not text cannot travel: leave that one file (or folder) alone, the rest syncs
                unknown.insert(relative.to_string_lossy().replace('\\', "/"));
                continue;
            };
            let rel = if cfg!(windows) { relative.replace('\\', "/") } else { relative.to_string() };
            if e.file_type().map_err(err)?.is_symlink() {
                return Err(format!("HUB:unsafe_path\npath={rel}\ndetail=symlink"));
            }
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
        if fs::symlink_metadata(&d).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("HUB:unsafe_path\npath={r}\ndetail=symlink"));
        }
        if d.exists() {
            walk(root, &d, cache, &mut out, &mut unknown)?;
        } else {
            // a missing folder (not mounted, moved away) is no proof that its files were deleted
            let prefix = format!("{r}/");
            unknown.extend(cache.keys().filter(|k| k.starts_with(&prefix)).cloned());
        }
    }
    let marker = root.join(".nevis/vault.json");
    if fs::symlink_metadata(&marker).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("HUB:unsafe_path\npath=.nevis/vault.json\ndetail=symlink".into());
    }
    match fs::read(&marker) {
        Ok(b) => {
            let m = fs::metadata(&marker).map_err(err)?;
            out.insert(".nevis/vault.json".into(), Local { md5: md5_hex(&b), size: m.len(), mtime: mtime_of(&m) });
        }
        Err(_) => {
            unknown.insert(".nevis/vault.json".into());
        }
    }
    Ok((out, unknown))
}

/// Remote paths come from another device (or a hostile account): only known vault locations, no escaping.
fn path_problem(p: &str) -> Option<&'static str> {
    use unicode_normalization::UnicodeNormalization;
    if p.is_empty() { return Some("empty"); }
    if p.encode_utf16().count() > 240 { return Some("too_long"); }
    if !p.nfc().eq(p.chars()) { return Some("not_nfc"); }
    if p.starts_with('/') { return Some("absolute"); }
    if p.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}' || "<>\"|?*:\\".contains(c)) { return Some("bad_char"); }
    if p == ".nevis/vault.json" { return None; }
    let parts: Vec<_> = p.split('/').collect();
    if parts.len() < 2 || !ROOTS.contains(&parts[0]) { return Some("outside_vault"); }
    for part in &parts {
        if part.is_empty() || *part == "." || *part == ".." || part.ends_with('.') || part.ends_with(' ') { return Some("bad_segment"); }
        let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        if ["con", "prn", "aux", "nul"].contains(&stem.as_str()) ||
            (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && matches!(stem.as_bytes()[3], b'1'..=b'9')) { return Some("reserved_name"); }
        if part.starts_with('.') && part.ends_with(".tmp") { return Some("temp_file"); }
    }
    if parts[0] == "databases" && !crate::database::safe_database_rel(p) { return Some("bad_database_path"); }
    None
}

fn safe_rel(p: &str) -> bool { path_problem(p).is_none() }

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
    /// local files whose name cannot be synced (control characters, not text...); they stay where they are
    pub skipped_paths: Vec<String>,
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

/// Writes `bytes` to vault file `p` unless it is not what the scan saw (`expected`) any more. The check and the write
/// happen under the commit lock, so that a page save of the app cannot slip in between. A path that was deleted here
/// before is alive again once the cloud's copy is written: its tombstone goes. True when written.
fn guarded_write(vault: &Vault, p: &str, expected: Option<&str>, bytes: &[u8]) -> Res<bool> {
    let _guard = crate::vault::commit_lock(&vault.root)?;
    let path = vault.root.join(p);
    if changed_since(&path, expected) {
        return Ok(false);
    }
    write_atomic(&path, bytes)?;
    if snapshot::safe_path(p).is_ok() {
        snapshot::untombstone(vault, p)?;
    }
    Ok(true)
}

/// Errors of one file that the server will never accept as they are: retrying changes nothing, and they say nothing
/// about whether the rest of the sync can be trusted. Every other error holds back deletions.
fn is_permanent_file_error(e: &str) -> bool {
    ["HUB:too_large", "HUB:bad_path", "HUB:path_case_clash", "HUB:quota_exceeded"].iter().any(|c| e.contains(c))
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

/// A remote may hold several files of the same name (Drive did; the Nevis server cannot). Pick one
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
    vault.ensure_exclusive()?;
    let root = &vault.root;
    // preflight: nothing below may run against a vault or a cloud folder that is not there
    if !root.is_dir() || vault.id().is_empty() {
        return Err(VAULT_MISSING.into());
    }
    remote.check()?;
    // `local_root` is informational: a fresh download resets the baseline in run_sync, and wiping it here would
    // forget the deletions of every state written before the field existed
    if state.local_root.is_empty() {
        state.allow_deletes_once = false; // a confirmation from before this state knew its folder must not apply to a reused baseline
    }
    if let Ok(canonical) = fs::canonicalize(root) {
        state.local_root = canonical.to_string_lossy().into_owned();
    }
    let (mut local, mut unknown) = scan(root, &state.files)?;
    let mut rep = Report::default();
    // one odd local file name (macOS "Icon\r"...) must not stop the sync of everything else: it is reported and left alone
    let odd = |p: &String| path_problem(p).is_some() || p.contains('\u{fffd}');
    rep.skipped_paths = local.keys().chain(unknown.iter()).filter(|p| odd(p)).cloned().collect();
    local.retain(|p, _| !odd(p));
    unknown.extend(rep.skipped_paths.iter().cloned());
    let mut listed = remote.list()?;
    // a remote path this client refuses (another client's idea of a name...) is reported and left alone, like a local one:
    // failing here would stop the sync on every device
    let refused: BTreeSet<String> = listed.iter().filter(|f| odd(&f.path)).map(|f| f.path.clone()).collect();
    listed.retain(|f| !refused.contains(&f.path));
    for p in refused {
        if !rep.skipped_paths.contains(&p) {
            rep.skipped_paths.push(p.clone());
        }
        unknown.insert(p);
    }
    // Reject incompatible or unsafe snapshots before deduplication can remove anything.
    let paths: Vec<String> = local.keys().cloned().chain(unknown.iter().filter(|p| !odd(p)).cloned()).chain(listed.iter().map(|f| f.path.clone())).collect();
    let mut folded = BTreeMap::new();
    for path in &paths {
        if let Some(detail) = path_problem(path) { return Err(format!("HUB:unsafe_path\npath={path}\ndetail={detail}")); }
        if let Some(previous) = folded.insert(path.to_lowercase(), path) {
            if previous != path { return Err(format!("HUB:path_case_clash\npath={path}\ndetail={previous}")); }
        }
    }
    remote.validate_paths(&paths)?;
    let rmap = dedupe(vault, remote, listed, &mut rep);
    let mut actions = plan(&local, &rmap, &state.files, &unknown);

    let deletes = actions.iter().filter(|a| matches!(a, Action::DeleteLocal(_) | Action::DeleteRemote(_))).count();
    // emptiness and the share of deletions are about the content of the vault, not about the marker file that is always there
    let tracked = state.files.keys().filter(|p| is_content(p)).count();
    let local_empty = !local.keys().any(|p| is_content(p));
    let remote_empty = !rmap.keys().any(|p| is_content(p));
    // a file that went back to an earlier synced content says an old copy of the folder was restored: no deletion round on top of that
    let regressed = local.iter().any(|(p, l)| rmap.get(p).is_some_and(|r| state.files.get(p).is_some_and(|e| e.base == r.md5)) && is_revert(&l.md5, state.files.get(p)));
    // a file that is gone here is only deleted in the cloud when the app saw it being deleted (a local tombstone)
    let tombstones = snapshot::tombstones(vault)?;
    // (only for files the app tombstones when it deletes them: history trims and the trash are deleted without one)
    let unconfirmed: BTreeSet<String> = actions
        .iter()
        .filter_map(|action| match action {
            Action::DeleteRemote(path) if deletion_is_tombstoned_by_app(path) && !tombstones.contains(path) => Some(path.clone()),
            _ => None,
        })
        .collect();
    if !state.allow_deletes_once {
        if hold_deletes(deletes, tracked, local_empty, remote_empty) || (deletes > 0 && regressed) {
            rep.held = deletes;
            actions.retain(|a| !matches!(a, Action::DeleteLocal(_) | Action::DeleteRemote(_)));
        } else if !unconfirmed.is_empty() {
            // only the files that vanished without the app noticing wait; the rest of the round goes on
            rep.held = unconfirmed.len();
            actions.retain(|a| !matches!(a, Action::DeleteRemote(p) if unconfirmed.contains(p)));
        }
    }
    state.allow_deletes_once = false;

    let mut merged: Vec<(String, RemoteFile)> = vec![];

    // Resolve and upload merges before any deletion. Keep deletion bookkeeping on failure.
    let (deletions, actions): (Vec<_>, Vec<_>) = actions.into_iter().partition(|a| matches!(a, Action::DeleteLocal(_) | Action::DeleteRemote(_)));
    let mut done = 0usize;
    for a in actions {
        let res: Res<()> = (|| {
            match &a {
                Action::Record(p) => {
                    let (l, r) = (&local[p], &rmap[p]);
                    track(state, p, l, &l.md5, &r.id);
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
                    track(state, p, l, &md5_hex(&bytes), &up.id);
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
                    if !guarded_write(vault, p, local.get(p).map(|l| l.md5.as_str()), &bytes)? {
                        rep.skipped += 1;
                        return Ok(());
                    }
                    let m = fs::metadata(root.join(p)).map_err(err)?;
                    track(state, p, &Local { md5: md5_hex(&bytes), size: m.len(), mtime: mtime_of(&m) }, &md5_hex(&bytes), &r.id);
                    rep.downloaded += 1;
                }
                Action::DeleteLocal(_) | Action::DeleteRemote(_) => unreachable!(),
                Action::Forget(p) => {
                    state.files.remove(p);
                }
                Action::Conflict(p) => {
                    let (l, r) = (&local[p], &rmap[p]);
                    rep.conflicts += 1;
                    if p == ".nevis/vault.json" && !state.files.contains_key(p) {
                        // first sync of a vault that was downloaded: its identity and name are the cloud's
                        let theirs = remote.download(r)?;
                        let id_of = |b: &[u8]| serde_json::from_slice::<serde_json::Value>(b).ok().and_then(|v| v.get("id").and_then(|i| i.as_str().map(String::from)));
                        if id_of(&theirs) != id_of(&fs::read(root.join(p)).map_err(err)?) {
                            return Err(VAULT_MISMATCH.into());
                        }
                        if !guarded_write(vault, p, Some(&l.md5), &theirs)? {
                            rep.conflicts -= 1;
                            rep.skipped += 1;
                            return Ok(());
                        }
                        track_current(state, root, p, &r.md5, &r.id);
                        rep.downloaded += 1;
                    } else if p.starts_with("databases/") && p.ends_with(".json") {
                        // a database record changed on both devices: keep both complete versions (the loser goes to history), upload the merge
                        let mine = fs::read(root.join(p)).map_err(err)?;
                        let theirs = remote.download(r)?;
                        match (serde_json::from_slice::<serde_json::Value>(&mine), serde_json::from_slice::<serde_json::Value>(&theirs)) {
                            (Ok(a), Ok(b)) => {
                                let (merged, losers) = crate::database::merge::merge_records(&a, &b);
                                let bytes = merged.to_string().into_bytes();
                                if !guarded_write(vault, p, Some(&l.md5), &bytes)? {
                                    rep.conflicts -= 1;
                                    rep.skipped += 1;
                                    return Ok(());
                                }
                                crate::database::keep_losers(root, p, &losers)?;
                                let up = verified_upload(remote, p, Some(&r.id), &bytes)?;
                                track_current(state, root, p, &md5_hex(&bytes), &up.id);
                                rep.uploaded += 1;
                            }
                            _ => {
                                // one side is unreadable: never pick silently. The remote bytes are kept next to the file and the local one is uploaded later.
                                write_atomic(&root.join(format!("{} (cloud).json", p.trim_end_matches(".json"))), &theirs)?;
                                track_current(state, root, p, &r.md5, &r.id);
                            }
                        }
                    } else if p.starts_with("pages/") && p.ends_with(".json") {
                        // keep both: the remote copy lands as a conflict copy, which the vault merges (newer wins, older goes to history)
                        let stem = p.trim_start_matches("pages/").trim_end_matches(".json");
                        let bytes = remote.download(r)?;
                        write_atomic(&root.join(format!("pages/{stem} (cloud).json")), &bytes)?;
                        merged.push((p.clone(), r.clone()));
                        // from now on the remote content is the base: the merged result counts as a local change and is uploaded next round
                        track_current(state, root, p, &r.md5, &r.id);
                    } else if let Some(both) = {
                        let mine = fs::read(root.join(p)).map_err(err)?;
                        let theirs = remote.download(r)?;
                        merge_kv(p, &mine, &theirs)
                    } {
                        // flashcard schedule and review log: keep what either device did
                        if !guarded_write(vault, p, Some(&l.md5), &both)? {
                            rep.conflicts -= 1;
                            rep.skipped += 1;
                            return Ok(());
                        }
                        let up = verified_upload(remote, p, Some(&r.id), &both)?;
                        track_current(state, root, p, &md5_hex(&both), &up.id);
                        rep.uploaded += 1;
                    } else {
                        // anything else: the newer file wins, the other version waits in the sync trash
                        let local_ms = (l.mtime / 1_000_000) as i64;
                        if r.modified_ms > local_ms {
                            let mine = fs::read(root.join(p)).map_err(err)?;
                            let bytes = remote.download(r)?;
                            if !guarded_write(vault, p, Some(&l.md5), &bytes)? {
                                rep.conflicts -= 1;
                                rep.skipped += 1;
                                return Ok(());
                            }
                            vault.sync_trash_put(p, &mine)?;
                            track_current(state, root, p, &r.md5, &r.id);
                            rep.downloaded += 1;
                        } else {
                            let theirs = remote.download(r)?;
                            vault.sync_trash_put(p, &theirs)?;
                            let bytes = fs::read(root.join(p)).map_err(err)?;
                            let up = verified_upload(remote, p, Some(&r.id), &bytes)?;
                            track_current(state, root, p, &md5_hex(&bytes), &up.id);
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
        {
            let _guard = crate::vault::commit_lock(&vault.root)?;
            vault.resolve_conflicts_locked()?;
        }
        // the merged page is the new truth: send it right away unless it is exactly what the cloud already has
        for (p, r) in merged {
            let res: Res<()> = (|| {
                let bytes = fs::read(root.join(&p)).map_err(err)?;
                if md5_hex(&bytes) != r.md5 {
                    let up = verified_upload(remote, &p, Some(&r.id), &bytes)?;
                    track_current(state, root, &p, &md5_hex(&bytes), &up.id);
                    rep.uploaded += 1;
                } else {
                    track_current(state, root, &p, &r.md5, &r.id);
                }
                Ok(())
            })();
            if let Err(e) = res {
                rep.errors.push(format!("merge {p}: {e}"));
            }
        }
    }
    for a in deletions {
        if rep.errors.iter().any(|e| !is_permanent_file_error(e)) {
            rep.held += 1;
            continue;
        }
        let res: Res<()> = (|| {
            match &a {
                Action::DeleteLocal(p) => {
                    if !safe_rel(p) {
                        return Err(format!("refusing remote path {p}"));
                    }
                    if p == ".nevis/vault.json" {
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
                    let _guard = crate::vault::commit_lock(&vault.root)?;
                    if changed_since(&root.join(p), local.get(p).map(|l| l.md5.as_str())) {
                        rep.skipped += 1;
                        return Ok(());
                    }
                    vault.sync_trash_move(p)?; // recoverable for TRASH_KEEP_MS (7 days); when it fails the file stays and so does `base`
                    state.files.remove(p);
                    rep.deleted += 1;
                    // only a file that is really gone is marked as deleted, otherwise a failed move would leave a live page "deleted"
                    if snapshot::safe_path(p).is_ok() {
                        snapshot::tombstone(vault, p)?;
                    }
                }
                Action::DeleteRemote(p) => {
                    let id = rmap.get(p).map(|r| r.id.clone()).or_else(|| state.files.get(p).map(|e| e.remote_id.clone())).unwrap_or_default();
                    if !id.is_empty() {
                        remote.trash(&id)?;
                    }
                    state.files.remove(p);
                    rep.deleted += 1;
                }
                _ => unreachable!(),
            }
            Ok(())
        })();
        if let Err(e) = res { rep.errors.push(format!("{a:?}: {e}")); }
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
        reject_paths: bool,
        corrupt_uploads: bool, // the cloud reports another md5 than what was sent
        refuse_upload: Option<String>, // the server refuses this one path for good (too large...)
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
        fn validate_paths(&mut self, _paths: &[String]) -> Res<()> {
            if self.0.borrow().reject_paths { Err("HUB:server_upgrade_required".into()) } else { Ok(()) }
        }
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
            if m.refuse_upload.as_deref() == Some(path) {
                return Err(format!("HUB:too_large\npath={path}"));
            }
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
            let root: PathBuf = std::env::temp_dir().join(format!("nevis-sync-{name}-{}-{}", now_ms(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
            let _ = fs::remove_dir_all(&root);
            let vault = match id { Some(id) => Vault::create_with_id(root, "T", id).unwrap(), None => Vault::create(root, "T").unwrap() };
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
    fn downloading_into_another_folder_preserves_server_pages() {
        let (mut original, mut downloaded) = pair();
        original.save(P1, "uploaded page", 100);
        original.sync();
        downloaded.state = original.state.clone();
        downloaded.state.reset_local_baseline(); // what run_sync does for a download
        downloaded.sync();
        assert_eq!(downloaded.page(P1).unwrap()["title"], "uploaded page");
        original.sync();
        assert_eq!(original.page(P1).unwrap()["title"], "uploaded page");
    }

    /// The state of a device that synced before `local_root` existed.
    fn legacy(state: &SyncState) -> SyncState {
        let mut legacy = serde_json::to_value(state).unwrap();
        legacy.as_object_mut().unwrap().remove("local_root");
        serde_json::from_value(legacy).unwrap()
    }

    #[test]
    fn legacy_baseline_without_a_local_folder_does_not_delete_cloud_pages() {
        let (mut original, mut downloaded) = pair();
        original.save(P1, "keep on server", 100);
        original.sync();
        downloaded.state = legacy(&original.state);
        downloaded.state.allow_deletes_once = true;
        let rep = downloaded.sync();
        // the baseline is not wiped: the page is missing here without a tombstone, so it waits instead of being downloaded
        assert!(!downloaded.state.files.is_empty());
        assert!(rep.held > 0 && rep.deleted == 0);
        assert!(downloaded.page(P1).is_none());
        assert!(original.remote.0.borrow().trashed.is_empty());
        assert_eq!(original.remote.0.borrow().files.iter().filter(|(f, _)| f.path == format!("pages/{P1}.json")).count(), 1);
        assert!(!downloaded.state.allow_deletes_once);
    }

    #[test]
    fn a_legacy_state_still_deletes_what_the_app_deleted_here() {
        let (mut original, _) = pair();
        original.save(P1, "gone here", 100);
        original.save(P2, "stays", 100);
        original.sync();
        original.vault.save_pages(&[], &[P1.to_string()], false).unwrap();
        original.state = legacy(&original.state);
        let rep = original.sync();
        assert_eq!(rep.held, 0);
        assert_eq!(rep.downloaded, 0);
        assert!(original.page(P1).is_none());
        assert!(!original.remote.0.borrow().files.iter().any(|(f, _)| f.path == format!("pages/{P1}.json")));
        assert!(snapshot::tombstones(&original.vault).unwrap().contains(&format!("pages/{P1}.json")));
    }

    #[test]
    fn a_legacy_state_still_applies_a_deletion_from_another_device() {
        let (mut a, mut b) = pair();
        a.save(P1, "deleted elsewhere", 100);
        a.save(P2, "stays", 100);
        a.sync();
        b.sync();
        a.vault.save_pages(&[], &[P1.to_string()], false).unwrap();
        a.sync();
        b.state = legacy(&b.state);
        let rep = b.sync();
        assert_eq!(rep.uploaded, 0);
        assert!(b.page(P1).is_none());
    }

    fn version(page: &str, ts: i64) -> Value {
        json!({ "pageId": page, "ts": ts, "title": "v", "content": {"type":"doc","content":[]}, "updatedAt": ts })
    }

    /// A vault with enough tracked files that the share-of-deletions heuristic stays quiet.
    fn busy(a: &Device) {
        for i in 0..10 {
            a.save(&format!("{i:08}-3333-4333-8333-333333333333"), "filler", 100);
        }
    }

    #[test]
    fn a_trimmed_history_is_not_a_held_deletion() {
        let (mut a, _) = pair();
        busy(&a);
        a.save(P1, "long history", 100);
        for ts in 1..=40 {
            a.vault.version_add(&version(P1, ts)).unwrap();
        }
        a.sync();
        a.vault.version_add(&version(P1, 41)).unwrap(); // trims the oldest entry without a tombstone
        let rep = a.sync();
        assert_eq!(rep.held, 0);
        assert!(a.remote.0.borrow().trashed.iter().any(|(f, _)| f.path == format!("history/{P1}/1.json")));
    }

    #[test]
    fn a_permanently_deleted_page_goes_with_its_history() {
        let (mut a, _) = pair();
        busy(&a);
        a.save(P1, "doomed", 100);
        a.vault.version_add(&version(P1, 1)).unwrap();
        a.sync();
        a.vault.save_pages(&[], &[P1.to_string()], false).unwrap();
        let rep = a.sync();
        assert_eq!(rep.held, 0);
        let remote = a.remote.0.borrow();
        assert!(!remote.files.iter().any(|(f, _)| f.path.contains(P1)));
        assert!(remote.trashed.iter().any(|(f, _)| f.path == format!("pages/{P1}.json")));
        assert!(remote.trashed.iter().any(|(f, _)| f.path == format!("history/{P1}/1.json")));
    }

    #[test]
    fn only_the_untombstoned_page_is_held_while_other_deletions_go_on() {
        let (mut a, mut b) = pair();
        busy(&a);
        a.save(P1, "missing without a tombstone", 100);
        a.save(P2, "deleted on b", 100);
        a.sync();
        b.sync();
        fs::remove_file(a.vault.root.join(format!("pages/{P1}.json"))).unwrap();
        b.vault.save_pages(&[], &[P2.to_string()], false).unwrap();
        b.sync();
        let rep = a.sync();
        assert_eq!(rep.held, 1);
        assert_eq!(rep.deleted, 1);
        assert!(a.page(P2).is_none());
        assert!(a.remote.0.borrow().files.iter().any(|(f, _)| f.path == format!("pages/{P1}.json")));
    }

    #[test]
    fn a_missing_page_folder_never_empties_the_server() {
        let (mut original, mut other) = pair();
        original.save(P1, "keep my page", 100);
        original.sync();
        other.sync();
        let page = original.vault.root.join(format!("pages/{P1}.json"));
        fs::remove_file(page).unwrap();
        let rep = original.sync();
        assert!(rep.held > 0);
        assert_eq!(rep.deleted, 0);
        assert!(original.remote.0.borrow().trashed.is_empty());
        other.sync();
        assert_eq!(other.page(P1).unwrap()["title"], "keep my page");
    }

    #[test]
    fn downloading_again_at_the_same_path_uses_a_fresh_baseline() {
        let (mut original, mut other) = pair();
        original.save(P1, "download again", 100);
        original.sync();
        other.sync();
        fs::remove_file(original.vault.root.join(format!("pages/{P1}.json"))).unwrap();
        original.state.reset_local_baseline();
        let rep = original.sync();
        assert_eq!(rep.held, 0);
        assert_eq!(rep.deleted, 0);
        assert_eq!(original.page(P1).unwrap()["title"], "download again");
        assert!(original.remote.0.borrow().trashed.is_empty());
    }

    #[test]
    fn a_missing_file_needs_confirmation_even_when_other_pages_remain() {
        let (mut original, _) = pair();
        original.save(P1, "missing", 100);
        original.save(P2, "still here", 100);
        original.sync();
        fs::remove_file(original.vault.root.join(format!("pages/{P1}.json"))).unwrap();
        let rep = original.sync();
        assert!(rep.held > 0 && rep.deleted == 0);
        assert!(original.remote.0.borrow().trashed.is_empty());
        original.state.allow_deletes_once = true;
        let confirmed = original.sync();
        assert!(confirmed.deleted > 0);
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
        assert!(!b.vault.root.join(".trash/pages").join(format!("{P1}.json")).exists()); // permanent deletion has no app restore path
        assert!(snapshot::tombstones(&b.vault).unwrap().contains(&format!("pages/{P1}.json")));
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
        assert!(safe_rel("pages/x.json") && safe_rel(".nevis/vault.json") && safe_rel("pages/a..b.json"));
        for p in ["pages/CON.json", "pages/com1.txt", "pages/a?b.json", "pages/a//b", "pages/a."] { assert!(!safe_rel(p), "{p}"); }
        assert!(!safe_rel("../x") && !safe_rel("pages/../../x") && !safe_rel("C:/x") && !safe_rel("other/x") && !safe_rel("/etc/x"));
    }

    #[test]
    fn incompatible_server_preserves_local_remote_and_baseline() {
        let (mut a, _) = pair();
        a.save(P1, "keep", 100);
        a.sync();
        let baseline = serde_json::to_vec(&a.state).unwrap();
        a.save(P1, "edited", 200);
        a.remote.0.borrow_mut().reject_paths = true;
        assert!(a.try_sync().unwrap_err().contains("server_upgrade_required"));
        assert_eq!(serde_json::to_vec(&a.state).unwrap(), baseline);
        assert_eq!(a.page(P1).unwrap()["title"], "edited");
        assert!(a.remote.0.borrow().trashed.is_empty());
    }

    #[test]
    fn failed_transfer_holds_deletes_even_after_user_confirmation() {
        let (mut a, _) = pair();
        a.save(P1, "keep remotely", 100);
        a.save(P2, "base", 100);
        a.sync();
        fs::remove_file(a.vault.root.join(format!("pages/{P1}.json"))).unwrap();
        a.save(P2, "edited", 200);
        a.state.allow_deletes_once = true;
        a.remote.0.borrow_mut().corrupt_uploads = true;
        let rep = a.try_sync().unwrap();
        assert!(!rep.errors.is_empty());
        assert!(rep.held > 0);
        assert!(a.state.files.contains_key(&format!("pages/{P1}.json")));
        assert!(a.remote.0.borrow().trashed.is_empty());
    }

    fn page_bytes(d: &Device, id: &str) -> Vec<u8> {
        fs::read(d.vault.root.join(format!("pages/{id}.json"))).unwrap()
    }

    fn remote_paths(r: &Shared) -> Vec<String> {
        r.0.borrow().files.iter().map(|(f, _)| f.path.clone()).collect()
    }

    #[test]
    fn a_missing_content_folder_is_not_a_deletion_in_the_cloud() {
        let (mut a, _) = pair();
        for (i, id) in [P1, P2, "33333333-3333-4333-8333-333333333333"].iter().enumerate() {
            a.save(id, "t", 100 + i as i64);
        }
        a.sync();
        let before = remote_paths(&a.remote);
        fs::remove_dir_all(a.vault.root.join("pages")).unwrap();
        a.sync();
        assert_eq!(remote_paths(&a.remote), before);
        assert!(a.remote.0.borrow().trashed.is_empty());
        // all content folders gone
        for r in ROOTS {
            let _ = fs::remove_dir_all(a.vault.root.join(r));
        }
        a.sync();
        assert_eq!(remote_paths(&a.remote), before);
        assert!(a.remote.0.borrow().trashed.is_empty());
    }

    #[test]
    fn a_total_remote_wipe_holds_the_deletions_here() {
        let (mut a, _) = pair();
        a.save(P1, "one", 100);
        a.save(P2, "two", 100);
        a.sync();
        a.remote.0.borrow_mut().hide_all = true;
        let rep = a.sync();
        assert!(rep.held > 0);
        assert_eq!(a.page_count(), 2);
    }

    #[test]
    fn a_page_restored_in_the_cloud_after_a_deletion_is_usable_again() {
        let (mut a, mut b) = pair();
        a.save(P1, "back", 100);
        a.sync();
        b.sync();
        let bytes = page_bytes(&a, P1);
        a.vault.save_pages(&[], &[P1.to_string()], false).unwrap();
        a.sync();
        b.sync();
        assert!(b.page(P1).is_none());
        a.remote.put(&format!("pages/{P1}.json"), &bytes, 9_000_000_000_000);
        b.sync();
        assert_eq!(b.page(P1).unwrap()["title"], "back");
        assert!(!snapshot::tombstones(&b.vault).unwrap().contains(&format!("pages/{P1}.json")));
        b.save(P1, "edited again", 300); // not refused as "permanently deleted"
        assert_eq!(b.page(P1).unwrap()["title"], "edited again");
    }

    /// Page P1 synced as "old", then as "new"; returns the bytes of "old".
    fn synced_old_then_new(a: &mut Device) -> Vec<u8> {
        a.save(P1, "old", 100);
        a.sync();
        let old = page_bytes(a, P1);
        a.save(P1, "new", 200);
        a.sync();
        old
    }

    fn assert_old_copy_did_not_win(a: &mut Device, rep: &Report) {
        assert_eq!(rep.conflicts, 1);
        assert_eq!(a.page(P1).unwrap()["title"], "new");
        a.sync();
        let theirs = a.remote.0.borrow().files.iter().find(|(f, _)| f.path == format!("pages/{P1}.json")).map(|(_, b)| b.clone()).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&theirs).unwrap()["title"], "new");
    }

    #[test]
    fn an_older_copy_of_the_folder_restored_over_a_page_does_not_win() {
        let (mut a, _) = pair();
        let old = synced_old_then_new(&mut a);
        // a plain write: the restored file has a NEW mtime, only its content says it is old
        write_atomic(&a.vault.root.join(format!("pages/{P1}.json")), &old).unwrap();
        let rep = a.sync();
        assert_old_copy_did_not_win(&mut a, &rep);
    }

    #[test]
    fn a_restore_that_keeps_the_old_mtime_is_caught_too() {
        let (mut a, _) = pair();
        let old = synced_old_then_new(&mut a);
        let path = a.vault.root.join(format!("pages/{P1}.json"));
        write_atomic(&path, &old).unwrap();
        fs::File::options().write(true).open(&path).unwrap().set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(86_400)).unwrap();
        let rep = a.sync();
        assert_old_copy_did_not_win(&mut a, &rep);
    }

    #[test]
    fn a_restore_holds_deletions_that_round() {
        let (mut a, _) = pair();
        let old = synced_old_then_new(&mut a);
        a.save(P2, "doomed", 100);
        a.sync();
        fs::remove_file(a.vault.root.join(format!("pages/{P2}.json"))).unwrap();
        write_atomic(&a.vault.root.join(format!("pages/{P1}.json")), &old).unwrap();
        let rep = a.sync();
        assert_eq!(rep.held, 1);
        assert!(remote_paths(&a.remote).contains(&format!("pages/{P2}.json")));
    }

    #[test]
    fn an_ordinary_edit_is_still_an_upload() {
        let (mut a, _) = pair();
        synced_old_then_new(&mut a);
        a.save(P1, "newer", 300);
        let rep = a.sync();
        assert_eq!((rep.uploaded, rep.conflicts), (1, 0));
    }

    #[test]
    fn the_ring_of_synced_contents_is_capped_and_old_state_files_still_load() {
        let mut st = SyncState::default();
        let l = Local { md5: "x".into(), size: 1, mtime: 5 };
        for i in 0..20 {
            track(&mut st, "p", &l, &format!("m{i}"), "id");
        }
        let e = &st.files["p"];
        assert_eq!(e.seen.len(), SEEN_MAX);
        assert_eq!((e.seen.first().unwrap().as_str(), e.seen.last().unwrap().as_str()), ("m12", "m19"));
        assert!(is_revert("m13", Some(e)) && !is_revert("m19", Some(e)) && !is_revert("m0", Some(e)));
        let old: SyncState = serde_json::from_str(r#"{"files":{"p":{"base":"a","remote_id":"i","size":1,"mtime":2,"md5":"a"}}}"#).unwrap();
        assert!(old.files["p"].seen.is_empty());
    }

    #[test]
    fn conflict_results_are_cached_with_the_real_local_file() {
        let (mut a, mut b) = pair();
        a.save(P1, "start", 100);
        a.sync();
        b.sync();
        a.save(P1, "from a", 200);
        b.save(P1, "from b", 300);
        a.sync();
        b.sync();
        let e = &b.state.files[&format!("pages/{P1}.json")];
        let meta = fs::metadata(b.vault.root.join(format!("pages/{P1}.json"))).unwrap();
        assert!(e.mtime != 0 && e.size == meta.len() && e.md5 == md5_hex(&page_bytes(&b, P1)) && e.seen.contains(&e.base), "{e:?}");
    }

    #[test]
    fn a_remote_path_this_client_refuses_is_skipped_not_fatal() {
        let (mut a, _) = pair();
        a.save(P1, "keep", 100);
        a.sync();
        a.remote.put("pages/../escape.json", b"bad", 200);
        a.remote.put("files/Icon\r", b"bad", 200);
        let baseline = serde_json::to_vec(&a.state).unwrap();
        let rep = a.sync();
        assert_eq!(rep.skipped_paths, vec!["files/Icon\r".to_string(), "pages/../escape.json".to_string()].into_iter().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>());
        assert_eq!((rep.downloaded, rep.uploaded, rep.deleted), (0, 0, 0));
        assert!(a.page(P1).is_some());
        assert_eq!(serde_json::to_vec(&a.state).unwrap(), baseline);
        assert!(a.remote.0.borrow().trashed.is_empty());
        assert!(!a.vault.root.join("files/Icon\r").exists());
    }

    #[test]
    fn a_file_the_server_refuses_for_good_does_not_hold_deletions_forever() {
        let (mut a, _) = pair();
        a.save(P1, "doomed", 100);
        a.save(P2, "stays", 100);
        a.sync();
        fs::remove_file(a.vault.root.join(format!("pages/{P1}.json"))).unwrap();
        // the app saw the page being deleted: only then is the absence a deletion
        snapshot::tombstone(&a.vault, &format!("pages/{P1}.json")).unwrap();
        let big ="pages/44444444-4444-4444-8444-444444444444.json";
        write_atomic(&a.vault.root.join(big), b"{}").unwrap();
        a.remote.0.borrow_mut().refuse_upload = Some(big.into());
        let rep = a.try_sync().unwrap();
        assert!(rep.errors.iter().any(|e| e.contains("too_large")));
        assert_eq!(rep.held, 0);
        assert_eq!(a.remote.0.borrow().trashed.len(), 1);
    }

    #[test]
    fn one_odd_local_file_name_does_not_stop_the_sync() {
        let (mut a, _) = pair();
        a.save(P1, "fine", 100);
        // Windows cannot create a carriage-return filename. A replacement character
        // is legal there but is refused by the same sync path filter.
        let odd = if cfg!(windows) { "files/Icon\u{fffd}" } else { "files/Icon\r" };
        write_atomic(&a.vault.root.join(odd), b"x").unwrap();
        let rep = a.sync();
        assert_eq!(rep.skipped_paths, vec![odd.to_string()]);
        assert!(remote_paths(&a.remote).contains(&format!("pages/{P1}.json")));
        assert!(!remote_paths(&a.remote).iter().any(|p| p == odd));
    }

    #[test]
    fn server_and_desktop_share_the_path_contract() {
        let cases: Vec<(String, Option<String>)> = serde_json::from_str(include_str!("sync-paths.json")).unwrap();
        for (path, expected) in cases {
            assert_eq!(path_problem(&path), expected.as_deref(), "{path}");
        }
        assert_eq!(path_problem(&format!("files/{}", "a".repeat(240))), Some("too_long"));
    }

    // ───── database records (handoff §23) ─────

    fn db_write(d: &Device, kind_dir: &str, id: &str, v: Value) {
        write_atomic(&d.vault.root.join("databases").join(kind_dir).join(format!("{id}.json")), v.to_string().as_bytes()).unwrap();
    }
    fn db_read(d: &Device, kind_dir: &str, id: &str) -> Option<Value> {
        fs::read(d.vault.root.join("databases").join(kind_dir).join(format!("{id}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }
    fn view(rev: i64, at: i64, name: &str, op: &str) -> Value {
        json!({ "format": 1, "id": "v1", "vaultId": "v", "revision": rev, "createdAt": 1, "updatedAt": at, "createdBy": "U1", "updatedBy": "U1", "deletedAt": null, "lastOperationId": op, "name": name })
    }

    #[test]
    fn database_records_travel_and_stay_out_of_the_local_runtime_files() {
        let (mut a, mut b) = pair();
        db_write(&a, "views", "v1", view(1, 10, "one", "a1"));
        // device-local state must never be uploaded
        write_atomic(&a.vault.root.join(".nevis/database-journal/x.json"), b"{}").unwrap();
        write_atomic(&a.vault.root.join(".nevis/database-ops/x.json"), b"{}").unwrap();
        a.sync();
        b.sync();
        assert_eq!(db_read(&b, "views", "v1").unwrap()["name"], "one");
        assert!(!b.vault.root.join(".nevis/database-journal/x.json").exists() && !b.vault.root.join(".nevis/database-ops/x.json").exists());
        assert!(!a.sync().changed() && !b.sync().changed());
    }

    #[test]
    fn a_true_database_conflict_keeps_both_complete_versions() {
        let (mut a, mut b) = pair();
        db_write(&a, "views", "v1", view(1, 10, "base", "a1"));
        a.sync();
        b.sync();
        db_write(&a, "views", "v1", view(2, 20, "from A", "a2"));
        db_write(&b, "views", "v1", view(2, 30, "from B", "b2"));
        a.sync(); // uploads A
        b.sync(); // B conflicts: merges, keeps the loser, uploads the merge
        a.sync();
        b.sync();
        let (ma, mb) = (db_read(&a, "views", "v1").unwrap(), db_read(&b, "views", "v1").unwrap());
        assert_eq!(ma, mb, "both devices converge on the same record");
        assert_eq!(ma["revision"], 3);
        // the version that did not win is still available, complete, in the record's history
        let hist = crate::database::history(&b.vault.root, "view", "v1").unwrap();
        assert!(hist.iter().any(|h| h["conflict"] == true && h["body"]["name"] != ma["name"]), "{hist:?}");
    }

    #[test]
    fn database_row_cells_edited_on_two_devices_merge_without_loss() {
        let (mut a, mut b) = pair();
        let cell = |v: i64, counter: i64, dev: &str| json!({ "value": { "kind": "number", "value": v }, "stamp": { "counter": counter, "deviceId": dev, "opId": "o" } });
        let row = |rev: i64, at: i64, cells: Value| json!({ "id": P1, "title": "T1", "content": {"type":"doc","content":[]}, "updatedAt": at, "deletedAt": null,
            "recordMeta": { "format": 1, "revision": rev, "createdAt": 1, "createdBy": "U1", "updatedBy": "U1", "lastOperationId": format!("op{rev}") },
            "database": { "format": 1, "sourceId": "s", "schemaRevision": 1, "revision": rev, "sortKey": "V", "parentItemId": null, "cells": cells, "allocatedIds": {}, "archivedCells": {} } });
        let put = |d: &Device, p: Value| write_atomic(&d.vault.root.join("pages").join(format!("{P1}.json")), p.to_string().as_bytes()).unwrap();
        put(&a, row(1, 100, json!({})));
        a.sync();
        b.sync();
        put(&a, row(2, 200, json!({ "cost": cell(10, 2, "D1") })));
        put(&b, row(2, 210, json!({ "notes": cell(7, 2, "D2") })));
        a.sync();
        b.sync();
        a.sync();
        b.sync();
        for d in [&a, &b] {
            let p = d.page(P1).unwrap();
            assert_eq!(p["database"]["cells"]["cost"]["value"]["value"], 10, "A's edit survives");
            assert_eq!(p["database"]["cells"]["notes"]["value"]["value"], 7, "B's edit survives");
        }
        assert_eq!(a.page(P1).unwrap()["database"], b.page(P1).unwrap()["database"]);
    }

    #[test]
    fn remote_database_paths_are_validated() {
        assert!(safe_rel("databases/views/abc.json") && safe_rel("databases/events/rep~3atpl~7c1.json") && safe_rel("history/records/view/v1/0000000001.json"));
        assert!(!safe_rel("databases/views/../../x.json") && !safe_rel("databases/nope/x.json") && !safe_rel("databases/views/sub/x.json") && !safe_rel("databases/views/x.exe") && !safe_rel("databases/x.json"));
        assert!(!safe_rel(".nevis/database-journal/x.json") && !safe_rel(".nevis/index.db"));
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
        let file = std::env::temp_dir().join(format!("nevis-state-{}.json", now_ms()));
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
            let v = Vault::open(root.clone()).unwrap();
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
        assert_eq!(a.remote.0.borrow().files.iter().filter(|(f, _)| f.path == ".nevis/vault.json").count(), 1);
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
