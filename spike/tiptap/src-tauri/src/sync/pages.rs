//! Page states in the sync engine: what `sync_once` does with `pages-state/<id>.bin` (see page_state.rs).
//! Nothing here talks to the server while holding the commit lock.

use super::*;
use crate::page_state as ps;
use crate::vault::commit_lock;
use serde_json::Value;

thread_local! {
    /// Tests (and the fuzz) switch page states on or off per device; `None` = the release flag decides.
    static FORCE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

pub fn force_enabled(v: Option<bool>) {
    FORCE.with(|f| f.set(v));
}

/// Migration of pages to states is on: release flag `pageState` (or a test override).
pub fn enabled() -> bool {
    FORCE.with(|f| f.get()).unwrap_or_else(crate::release_features::page_state_enabled)
}

/// The uuid in `pages/<uuid>.json` (and in a conflict copy `pages/<uuid> (cloud).json`).
pub fn page_of_json(p: &str) -> Option<&str> {
    let name = p.strip_prefix("pages/")?;
    let id = name.get(..36)?;
    (ps::uuid_bytes(id).is_some() && (name.len() == 41 || name[36..].starts_with(' ')) && name.ends_with(".json")).then_some(id)
}

pub fn page_of_bin(p: &str) -> Option<&str> {
    let id = p.strip_prefix("pages-state/")?.strip_suffix(".bin")?;
    ps::uuid_bytes(id).is_some().then_some(id)
}

/// Deleting a page removes its file, its state and its history files: that is one deletion for the user.
pub fn delete_key(p: &str) -> String {
    if let Some(id) = page_of_json(p).or_else(|| page_of_bin(p)) {
        return format!("page:{id}");
    }
    if let Some(id) = p.strip_prefix("history/").and_then(|r| r.split('/').next()).filter(|id| ps::uuid_bytes(id).is_some()) {
        return format!("page:{id}");
    }
    p.to_string()
}

/// What the engine knew about the legacy `pages/<id>.json` of a page that has a state.
#[derive(Default, Clone)]
pub struct Legacy {
    pub local_md5: Option<String>,
    pub base: Option<String>,
    /// the frozen JSON the migrating device left on the server
    pub remote: Option<RemoteFile>,
}

/// `pages/<id>.json` of a page with a state (here or on the server) is derived from it and leaves the sync.
pub fn drop_derived(local: &mut BTreeMap<String, Local>, rmap: &mut BTreeMap<String, RemoteFile>, files: &mut BTreeMap<String, Entry>) -> BTreeMap<String, Legacy> {
    let with_state: BTreeSet<String> = local.keys().chain(rmap.keys()).filter_map(|p| page_of_bin(p).map(str::to_string)).collect();
    let mut out = BTreeMap::new();
    for id in &with_state {
        let main = format!("pages/{id}.json");
        out.insert(id.clone(), Legacy { local_md5: local.get(&main).map(|l| l.md5.clone()), base: files.get(&main).map(|e| e.base.clone()), remote: rmap.get(&main).cloned() });
    }
    let derived = |p: &String| page_of_json(p).is_some_and(|id| with_state.contains(id));
    local.retain(|p, _| !derived(p));
    rmap.retain(|p, _| !derived(p));
    files.retain(|p, _| !derived(p));
    out
}

/// A half-done migration (crash, lost race) is nothing to resume: the server decides, the next sync adopts.
pub fn clear_pending(root: &Path) {
    let _ = fs::remove_dir_all(root.join(".nevis/page-state/pending"));
}

fn entry(state: &mut SyncState, p: &str, bytes: &[u8], id: &str, root: &Path) {
    let m = fs::metadata(root.join(p)).ok();
    let (size, mtime) = m.map_or((0, 0), |m| (m.len(), mtime_of(&m)));
    state.files.insert(p.to_string(), Entry { base: md5_hex(bytes), remote_id: id.to_string(), size, mtime, md5: md5_hex(bytes), cached_at: now_ns() });
}

/// The remote state is newer or new here: install it (adopting a legacy local page when there is one).
pub fn download(vault: &Vault, remote: &mut dyn Remote, state: &mut SyncState, local: &BTreeMap<String, Local>, legacy: &BTreeMap<String, Legacy>, p: &str, r: &RemoteFile, rep: &mut Report) -> Res<()> {
    let root = &vault.root;
    let id = page_of_bin(p).ok_or_else(|| format!("refusing remote path {p}"))?;
    let bytes = remote.download(r)?;
    if md5_hex(&bytes) != r.md5 && !r.md5.is_empty() {
        return Err(format!("download of {p} is corrupt"));
    }
    ps::check_blob(id, &bytes)?;
    let lg = legacy.get(id).cloned().unwrap_or_default();
    let has_local_state = ps::has_state(root, id);
    // the frozen legacy JSON is the common ancestor of a local edit made before this device knew about states
    let ancestor = match (&lg.remote, &lg.base) {
        (Some(fr), Some(base)) if !has_local_state && lg.local_md5.as_ref().is_some_and(|l| l != base) && &fr.md5 == base => Some(remote.download(fr)?),
        _ => None,
    };
    let _g = commit_lock(root)?;
    if has_local_state {
        ingest_tolerant(root, id)?; // an edit made after the scan: then this is a conflict for the next round
        if changed_since(&root.join(p), local.get(p).map(|l| l.md5.as_str())) {
            rep.skipped += 1;
            return Ok(());
        }
        ps::install_locked(root, id, &bytes)?;
    } else {
        let json = root.join(format!("pages/{id}.json"));
        let mine = fs::read(&json).ok();
        if mine.as_ref().map(|b| md5_hex(b)) != lg.local_md5 {
            rep.skipped += 1; // edited or created while we were busy
            return Ok(());
        }
        match (&mine, &lg.base) {
            (Some(mine), base) if base.as_deref() != Some(md5_hex(mine).as_str()) => {
                // edited here before it was a state: three-way against the frozen legacy copy, else keep it in history
                let mine_json: Option<Value> = serde_json::from_slice(mine).ok();
                let anc_json: Option<Value> = ancestor.as_ref().and_then(|a| serde_json::from_slice(a).ok());
                match (mine_json, anc_json) {
                    (Some(m), Some(a)) if ps::migratable(&m) => {
                        ps::install_locked(root, id, &bytes)?;
                        let (st, _) = ps::read_state(root, id)?.ok_or("PAGE_STATE:missing")?;
                        if st.ingest(&a, &m).is_ok() {
                            let nb = st.to_blob();
                            ps::install_locked(root, id, &nb)?;
                        }
                    }
                    (Some(m), _) => {
                        vault.keep_loser(id, &m)?;
                        ps::install_locked(root, id, &bytes)?;
                    }
                    _ => {
                        vault.sync_trash_put(&format!("pages/{id}.json"), mine)?;
                        ps::install_locked(root, id, &bytes)?;
                    }
                }
            }
            _ => ps::install_locked(root, id, &bytes)?,
        }
    }
    snapshot::forget_tombstone(root, &format!("pages/{id}.json"))?;
    entry(state, p, &bytes, &r.id, root);
    rep.downloaded += 1;
    Ok(())
}

/// Both sides changed the state: merge (same genesis) and send the union, or adopt the server's (different genesis).
pub fn conflict(vault: &Vault, remote: &mut dyn Remote, state: &mut SyncState, p: &str, r: &RemoteFile, rep: &mut Report) -> Res<()> {
    let root = &vault.root;
    let id = page_of_bin(p).ok_or_else(|| format!("refusing remote path {p}"))?;
    let theirs = remote.download(r)?;
    if md5_hex(&theirs) != r.md5 && !r.md5.is_empty() {
        return Err(format!("download of {p} is corrupt"));
    }
    ps::check_blob(id, &theirs)?;
    let (merged, equals) = {
        let _g = commit_lock(root)?;
        ingest_tolerant(root, id)?;
        let mine = fs::read(ps::bin_path(root, id)).map_err(err)?;
        if !ps::same_genesis(&mine, &theirs) {
            // two unrelated documents: the server's wins, ours stays in the history
            if let Some((st, _)) = ps::read_state(root, id)? {
                vault.keep_loser(id, &st.project())?;
            }
            ps::install_locked(root, id, &theirs)?;
            entry(state, p, &theirs, &r.id, root);
            rep.downloaded += 1;
            return Ok(());
        }
        let (m, eq) = ps::merge(&mine, &theirs)?;
        ps::install_locked(root, id, &m)?;
        (m, eq)
    };
    rep.state_merges += 1;
    if equals {
        entry(state, p, &theirs, &r.id, root);
        rep.downloaded += 1;
    } else {
        if merged.len() > ps::WARN_BYTES {
            rep.warnings.push(format!("PAGE_STATE:large:{id}"));
        }
        let up = verified_upload(remote, p, Some(&r.id), &merged)?;
        entry(state, p, &merged, &up.id, root);
        rep.uploaded += 1;
    }
    Ok(())
}

/// A state was deleted elsewhere and not touched here: the page goes (its files to the sync trash, a tombstone is made).
pub fn delete_local(vault: &Vault, p: &str) -> Res<()> {
    let root = &vault.root;
    let id = page_of_bin(p).ok_or_else(|| format!("refusing remote path {p}"))?;
    let _g = commit_lock(root)?;
    snapshot::tombstone(vault, &format!("pages/{id}.json"))?;
    vault.sync_trash_move(p)?;
    if root.join(format!("pages/{id}.json")).is_file() {
        vault.sync_trash_move(&format!("pages/{id}.json"))?;
    }
    ps::remove_locked(root, id);
    Ok(())
}

/// Moves fully synced, ordinary pages over to states. Returns nothing: every failure is either a lost race
/// (the next sync adopts what won) or an error in `rep`.
pub fn migrate(vault: &Vault, remote: &mut dyn Remote, state: &mut SyncState, rmap: &BTreeMap<String, RemoteFile>, rep: &mut Report) {
    let root = &vault.root;
    let ids: Vec<String> = fs::read_dir(root.join("pages")).into_iter().flatten().flatten().filter_map(|e| page_of_json(&format!("pages/{}", e.file_name().to_str()?)).filter(|_| e.file_name().len() == 41).map(str::to_string)).collect();
    let dead = snapshot::tombstones_at(root).unwrap_or_default();
    for id in ids {
        let path = format!("pages/{id}.json");
        let bin = ps::bin_rel(&id);
        let (Some(e), Some(rf)) = (state.files.get(&path), rmap.get(&path)) else { continue };
        if rmap.contains_key(&bin) || ps::has_state(root, &id) || dead.contains(&path) || e.base != rf.md5 {
            continue;
        }
        let base = e.base.clone();
        let res: Res<()> = (|| {
            let bytes = fs::read(root.join(&path)).map_err(err)?;
            if md5_hex(&bytes) != base {
                return Ok(()); // edited since the last sync: not fully synced
            }
            let Ok(mut page) = serde_json::from_slice::<Value>(&bytes) else { return Ok(()) };
            if !ps::migratable(&page) {
                return Ok(());
            }
            ps::assign_uuid_block_ids(&mut page["content"]);
            let blob = ps::State::from_page(&id, &page)?.to_blob();
            if blob.len() > ps::WARN_BYTES {
                rep.warnings.push(format!("PAGE_STATE:large:{id}"));
            }
            write_atomic(&ps::pending_path(root, &id), &blob)?;
            let up = match verified_upload(remote, &bin, None, &blob) {
                Ok(up) => up,
                Err(e) if e.starts_with("HUB:conflict") => {
                    let _ = fs::remove_file(ps::pending_path(root, &id)); // another device migrated first: adopt its state next round
                    return Ok(());
                }
                Err(e) => return Err(e),
            };
            let _g = commit_lock(root)?;
            let now = fs::read(root.join(&path)).ok();
            if now.as_ref().map(|b| md5_hex(b)).as_deref() == Some(base.as_str()) {
                ps::install_locked(root, &id, &blob)?; // writes the projection (block ids are UUIDs now)
            } else {
                // edited while the state was on its way: keep the edit, it is ingested like any local edit
                write_atomic(&ps::bin_path(root, &id), &blob)?;
                ps::mark_projection_locked(root, &id, &base, &blob)?;
                ps::ingest_local_locked(root, &id)?;
            }
            let _ = fs::remove_file(ps::pending_path(root, &id));
            state.files.remove(&path);
            entry(state, &bin, &blob, &up.id, root);
            rep.uploaded += 1;
            Ok(())
        })();
        if let Err(e) = res {
            rep.errors.push(format!("migrate {id}: {e}"));
        }
    }
}

/// A local edit that the state cannot take in (a state of a newer client) must not stop the byte-level merge.
fn ingest_tolerant(root: &Path, id: &str) -> Res<()> {
    match ps::ingest_local_locked(root, id) {
        Err(e) if e.starts_with("PAGE_STATE:") => Ok(()),
        r => r.map(|_| ()),
    }
}
