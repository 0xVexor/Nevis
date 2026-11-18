//! Durable, synced records of page conflicts (the same page edited on two devices), so that the UI can offer an
//! in-page "resolve conflict" view long after the sync has picked a winner.
//!
//! One marker is one file, `history/conflicts/<pageId>/<cid>.json` (not the vault-root `conflicts/` folder of
//! `sync/snapshot.rs`). It lives under `history/`, so the client, the server and `sync-paths.json` already accept it and it
//! syncs like any file. Markers are immutable: recording an existing one does nothing. Resolving = closing = moving the
//! file to the sync trash; the deletion then travels like any other. A new conflict of the same page has other contents
//! and so another `cid` and a new marker.
//!
//! `cid` is the first 32 hex chars of sha256(pageId || a || b), where a and b are the md5s of the two contents, put in
//! sorted order so that the other device, which sees them the other way round, computes the same name.
//!
//! Marker JSON (camelCase; `format` is 1; unknown fields must be ignored by readers):
//! ```json
//! { "format": 1, "id": "<cid>", "pageId": "<uuid>",
//!   "kind": "edit" | "restore" | "editor-race",           // later also "deleted-here" | "deleted-there" | "merged"
//!   "detectedAt": 1700000000000,                           // ms, this device's clock
//!   "detectedBy": { "deviceId": "", "deviceName": "" },
//!   "base": <page JSON> | null,                            // the common ancestor, when it could be fetched
//!   "local":  { "page": <page JSON> | null, "deviceId": "", "deviceName": "", "savedAt": 0 },
//!   "remote": { "page": <page JSON> | null, "deviceId": "", "deviceName": "", "savedAt": 0, "serverTime": 0 },
//!   "kept": "local" | "remote" }                           // which side the sync/editor kept as the page
//! ```
//! `savedAt` is the page's `updatedAt` (ms). `remote.serverTime` is the server's own clock for that revision (0 when
//! unknown). Device ids/names are "" when unknown: the UI says "this device" / "another device". A marker larger than
//! ~4 MB has `page: null` and `"historyTs": <ts>` inside `local`/`remote` instead (a version in `history/<pageId>/<ts>.json`),
//! and `base: null`.
//!
//! Tauri commands (JavaScript passes camelCase argument names; results are the marker JSON above):
//! - `page_conflicts_list(pageId?: string) -> Marker[]`, oldest first; markers of pages that are gone or tombstoned are not listed.
//! - `page_conflict_get(cid: string) -> Marker | null`
//! - `page_conflict_close(cid: string, outcome: "resolved" | "dismissed") -> void`
//! - `page_conflict_record(pageId, base: page | null, local: page, remote: page, kind: "editor-race") -> Marker`
//!   (`kept` is decided here: the side that equals the page now on disk by `updatedAt`, else the newer one)
//! - event `page-conflicts-changed`, payload `{ "pageIds": string[] }`: markers of these pages were recorded, closed,
//!   removed or arrived from another device.

use crate::vault::{check_id, err, now_ms, write_atomic, Res, Vault};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// The folder below `history/`; never the id of a page.
pub const DIR: &str = "conflicts";
/// A marker above this many bytes keeps history references instead of page bodies.
pub const MAX_BYTES: usize = 4 << 20;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Who {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    #[serde(default)]
    pub page: Option<Value>,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub saved_at: i64,
    /// only on the remote side
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_time: Option<i64>,
    /// only in a marker that is too large for page bodies
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_ts: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub format: u32,
    pub id: String,
    pub page_id: String,
    pub kind: String,
    pub detected_at: i64,
    pub detected_by: Who,
    #[serde(default)]
    pub base: Option<Value>,
    pub local: Side,
    pub remote: Side,
    pub kept: String,
}

/// What a detector knows; `Marker::new` turns it into the file.
pub struct Found {
    pub page_id: String,
    pub kind: &'static str,
    pub base: Option<Value>,
    pub local: Value,
    pub remote: Value,
    /// md5 of the two contents, for the name
    pub local_md5: String,
    pub remote_md5: String,
    pub local_who: Who,
    pub remote_who: Who,
    pub server_time: i64,
    pub kept: &'static str,
    pub detected_by: Who,
}

pub fn updated_at(v: &Value) -> i64 {
    v.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64
}

/// The name of the marker of this pair of contents; the same on both devices.
pub fn cid(page_id: &str, a_md5: &str, b_md5: &str) -> String {
    let (lo, hi) = if a_md5 <= b_md5 { (a_md5, b_md5) } else { (b_md5, a_md5) };
    crate::vault::sha256_hex(format!("{page_id}{lo}{hi}").as_bytes())[..32].to_string()
}

fn is_cid(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn rel(page_id: &str, cid: &str) -> String {
    format!("history/{DIR}/{page_id}/{cid}.json")
}

/// A marker path of the vault (`history/conflicts/<pageId>/<cid>.json`); not a page's history.
pub fn is_marker_path(p: &str) -> bool {
    p.strip_prefix("history/conflicts/").is_some()
}

/// The page a marker path belongs to.
pub fn page_of_path(p: &str) -> Option<&str> {
    p.strip_prefix("history/conflicts/")?.split('/').next().filter(|id| !id.is_empty())
}

impl Marker {
    pub fn new(f: Found) -> Marker {
        let saved = |v: &Value| updated_at(v);
        Marker {
            format: 1,
            id: cid(&f.page_id, &f.local_md5, &f.remote_md5),
            kind: f.kind.to_string(),
            detected_at: now_ms(),
            detected_by: f.detected_by,
            base: f.base,
            local: Side { saved_at: saved(&f.local), page: Some(f.local), device_id: f.local_who.device_id, device_name: f.local_who.device_name, ..Default::default() },
            remote: Side { saved_at: saved(&f.remote), page: Some(f.remote), device_id: f.remote_who.device_id, device_name: f.remote_who.device_name, server_time: Some(f.server_time), ..Default::default() },
            kept: f.kept.to_string(),
            page_id: f.page_id,
        }
    }

    fn too_big(&self) -> bool {
        serde_json::to_vec(self).map_or(true, |b| b.len() > MAX_BYTES)
    }

    /// A marker over the size limit keeps the two versions in the page's history and refers to them. `loser_ts` is the
    /// history entry the sync already wrote for the version that lost, if any. The caller holds the commit lock.
    pub fn shrink_locked(&mut self, vault: &Vault, loser_ts: Option<i64>) -> Res<()> {
        if !self.too_big() {
            return Ok(());
        }
        let loser_is_local = self.kept == "remote";
        for (is_local, side) in [(true, &mut self.local), (false, &mut self.remote)] {
            let page = side.page.take().unwrap_or(Value::Null);
            side.history_ts = Some(match loser_ts.filter(|_| is_local == loser_is_local) {
                Some(ts) => ts,
                None => vault.keep_loser_ts(&self.page_id, &page)?,
            });
        }
        self.base = None;
        Ok(())
    }
}

fn dir(root: &Path) -> PathBuf {
    root.join("history").join(DIR)
}

/// Whether this marker is there already (the caller holds the commit lock).
pub fn exists_locked(root: &Path, m: &Marker) -> bool {
    root.join(rel(&m.page_id, &m.id)).exists()
}

/// Writes the marker unless it is there already (markers never change). True when it was written. The caller holds the commit lock.
pub fn record_locked(root: &Path, m: &Marker) -> Res<bool> {
    check_id(&m.page_id)?;
    if !is_cid(&m.id) || m.page_id == DIR {
        return Err("bad conflict id".into());
    }
    let path = root.join(rel(&m.page_id, &m.id));
    if path.exists() {
        return Ok(false);
    }
    write_atomic(&path, &serde_json::to_vec(m).map_err(err)?)?;
    Ok(true)
}

/// Reads a marker file; one that is damaged, of another format or in the wrong place is not a marker.
fn read_marker(path: &Path, page_id: &str, cid: &str) -> Option<Marker> {
    let m: Marker = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (m.format == 1 && m.id == cid && m.page_id == page_id).then_some(m)
}

/// (page id, cid, path) of every marker file, without reading any.
fn files(root: &Path) -> Vec<(String, String, PathBuf)> {
    let mut out = vec![];
    for page in fs::read_dir(dir(root)).into_iter().flatten().flatten() {
        let Some(page_id) = page.file_name().to_str().map(str::to_string) else { continue };
        if check_id(&page_id).is_err() {
            continue;
        }
        for f in fs::read_dir(page.path()).into_iter().flatten().flatten() {
            let Some(cid) = f.file_name().to_str().and_then(|n| n.strip_suffix(".json")).filter(|c| is_cid(c)).map(str::to_string) else { continue };
            out.push((page_id.clone(), cid, f.path()));
        }
    }
    out
}

fn page_exists(root: &Path, id: &str) -> bool {
    root.join("pages").join(format!("{id}.json")).is_file() || crate::page_state::has_state(root, id)
}

/// What `list` found.
pub struct Listed {
    pub markers: Vec<Marker>,
    /// pages whose markers were removed because the page was deleted
    pub cleaned: BTreeSet<String>,
}

/// The open markers (of one page, or all), oldest first. A marker whose page is not there is not listed; when the page
/// was deleted on purpose (tombstoned) its markers are removed. A page that is merely missing (a download still on its
/// way, `history/` arrives before `pages/`) keeps them: removing would propagate to every device.
pub fn list(vault: &Vault, page_id: Option<&str>) -> Res<Listed> {
    if let Some(id) = page_id {
        check_id(id)?;
    }
    let dead = crate::sync::snapshot::tombstones(vault)?;
    let mut markers = vec![];
    let mut orphans = vec![];
    for (pid, cid, path) in files(&vault.root) {
        if dead.contains(&format!("pages/{pid}.json")) {
            orphans.push((pid, cid));
        } else if page_id.is_none_or(|id| id == pid) && page_exists(&vault.root, &pid) {
            markers.extend(read_marker(&path, &pid, &cid));
        }
    }
    let mut cleaned = BTreeSet::new();
    if !orphans.is_empty() {
        let _guard = crate::vault::commit_lock(&vault.root)?;
        for (pid, cid) in orphans {
            if dead.contains(&format!("pages/{pid}.json")) && vault.root.join(rel(&pid, &cid)).is_file() && vault.sync_trash_move(&rel(&pid, &cid)).is_ok() {
                cleaned.insert(pid);
            }
        }
    }
    markers.sort_by(|a, b| a.detected_at.cmp(&b.detected_at).then_with(|| a.id.cmp(&b.id)));
    Ok(Listed { markers, cleaned })
}

pub fn get(vault: &Vault, cid: &str) -> Res<Option<Marker>> {
    if !is_cid(cid) {
        return Err("bad conflict id".into());
    }
    Ok(files(&vault.root).into_iter().find(|(_, c, _)| c == cid).and_then(|(pid, c, path)| read_marker(&path, &pid, &c)))
}

/// Moves the marker to the sync trash; the deletion reaches the other devices with the next sync. Returns the page it
/// belonged to (None: no such marker). The caller holds the commit lock.
pub fn close_locked(vault: &Vault, cid: &str) -> Res<Option<String>> {
    if !is_cid(cid) {
        return Err("bad conflict id".into());
    }
    let Some((pid, c, _)) = files(&vault.root).into_iter().find(|(_, c, _)| c == cid) else { return Ok(None) };
    let rel = rel(&pid, &c);
    vault.sync_trash_move(&rel)?;
    let _ = fs::remove_dir(vault.root.join("history").join(DIR).join(&pid)); // only when empty
    Ok(Some(pid))
}

/// All markers of a page go with the page. The caller holds the commit lock.
pub fn remove_page_locked(root: &Path, page_id: &str) {
    if page_id != DIR {
        let _ = fs::remove_dir_all(dir(root).join(page_id));
    }
}

/// Records a conflict the editor noticed (a save based on a version that another device replaced meanwhile).
/// Returns the marker (the existing one when this conflict was recorded before) and whether it is new.
pub fn record_from_editor(vault: &Vault, page_id: &str, base: Option<Value>, local: Value, remote: Value, kind: &str, me: Who) -> Res<(Marker, bool)> {
    check_id(page_id)?;
    if kind != "editor-race" {
        return Err(format!("unsupported conflict kind {kind}"));
    }
    if !local.is_object() || !remote.is_object() || base.as_ref().is_some_and(|b| !b.is_object()) {
        return Err("a conflict holds pages".into());
    }
    let _guard = crate::vault::commit_lock(&vault.root)?;
    if !page_exists(&vault.root, page_id) {
        return Err("no such page".into());
    }
    let disk = fs::read(vault.page_path(page_id)?).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let (lt, rt) = (updated_at(&local), updated_at(&remote));
    let kept = match disk.as_ref().map(updated_at) {
        Some(d) if d == lt && d != rt => "local",
        Some(d) if d == rt && d != lt => "remote",
        _ if rt > lt => "remote",
        _ => "local",
    };
    let md5 = |v: &Value| crate::sync::md5_hex(v.to_string().as_bytes());
    let mut m = Marker::new(Found {
        page_id: page_id.to_string(),
        kind: "editor-race",
        base,
        local_md5: md5(&local),
        remote_md5: md5(&remote),
        local,
        remote,
        local_who: me.clone(),
        remote_who: Who::default(),
        server_time: 0,
        kept,
        detected_by: me,
    });
    if exists_locked(&vault.root, &m) {
        return Ok((get(vault, &m.id)?.unwrap_or(m), false)); // a retry: nothing is written, not even history
    }
    // an editor conflict has no history entry yet for either version
    m.shrink_locked(vault, None)?;
    let new = record_locked(&vault.root, &m)?;
    Ok((m, new))
}

// ───── commands ─────

use crate::{with, St};
use tauri::{AppHandle, Emitter};

/// Tells the UI that the markers of these pages changed.
pub fn emit_changed(app: &AppHandle, page_ids: impl IntoIterator<Item = String>) {
    let ids: Vec<String> = page_ids.into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    if !ids.is_empty() {
        let _ = app.emit("page-conflicts-changed", serde_json::json!({ "pageIds": ids }));
    }
}

fn this_device(s: &St) -> Who {
    let device_id = crate::sync::account::load(&s.app_data).map(|a| a.device_id).unwrap_or_default();
    Who { device_id, device_name: crate::sync::account::device_name() }
}

#[tauri::command]
pub fn page_conflicts_list(app: AppHandle, s: St, page_id: Option<String>) -> Res<Vec<Marker>> {
    let listed = with(&s, |v| list(v, page_id.as_deref()))?;
    if !listed.cleaned.is_empty() {
        emit_changed(&app, listed.cleaned);
        s.sync.edited();
    }
    Ok(listed.markers)
}

#[tauri::command]
pub fn page_conflict_get(s: St, cid: String) -> Res<Option<Marker>> {
    with(&s, |v| get(v, &cid))
}

/// `outcome` says why: "resolved" (the user picked) or "dismissed" (the user closed it without picking). The marker goes either way.
#[tauri::command]
pub fn page_conflict_close(app: AppHandle, s: St, cid: String, outcome: String) -> Res<()> {
    if outcome != "resolved" && outcome != "dismissed" {
        return Err(format!("unknown outcome {outcome}"));
    }
    let closed = with(&s, |v| {
        let _guard = crate::vault::commit_lock(&v.root)?;
        close_locked(v, &cid)
    })?;
    if let Some(page_id) = closed {
        emit_changed(&app, [page_id]);
        s.sync.edited();
    }
    Ok(())
}

#[tauri::command]
pub fn page_conflict_record(app: AppHandle, s: St, page_id: String, base: Option<Value>, local: Value, remote: Value, kind: String) -> Res<Marker> {
    let me = this_device(&s);
    let (marker, new) = with(&s, |v| record_from_editor(v, &page_id, base, local, remote, &kind, me))?;
    if new {
        emit_changed(&app, [page_id]);
        s.sync.edited();
    }
    Ok(marker)
}
