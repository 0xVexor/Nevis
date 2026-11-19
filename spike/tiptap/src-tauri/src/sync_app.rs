//! The sync of the open workspace with the person's own Nevis server, as the app runs it: one thread syncs when something
//! changed (or the server says so), one thread listens to the server, and the commands below are what the settings page calls.
//! The engine itself (what moves, what waits, what is never deleted) is in `sync/`; nothing here decides about files.
use crate::registry::Entry;
use crate::sync::{self, account, hub, hub::Hub, HeldDelete, SyncState};
use crate::vault::{err, now_ms, write_atomic, Res, Vault, VAULT_MISMATCH, VAULT_MISSING};
use crate::{activate, clean_name, with, St, Store};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Default)]
pub struct SyncStatus {
    /// "off" | "idle" | "pending" | "syncing" | "paused" | "error" | "offline"
    state: &'static str,
    last_at: i64,
    error: String,
    /// why a sync is paused: VAULT_MISSING | VAULT_MISMATCH | CLOUD_GONE | SIGNED_OUT | ACCOUNT_CHANGED (then `error` holds the `user@server` the workspace syncs with) | NEEDS_CONFIRM (then `error` holds the number of held deletions)
    reason: String,
    /// paths the last sync left alone because their names cannot be synced (capped; the UI explains)
    skipped: Vec<String>,
}

/// What the person confirmed for one vault: exactly the deletions they were shown, or (old callers) everything planned.
#[derive(Default)]
struct Confirmation {
    all: bool,
    /// (path, base md5) of the held deletions
    items: BTreeSet<(String, String)>,
}

const SKIPPED_SHOWN: usize = 200;

/// Paused: the workspace's bookkeeping belongs to another account or server than the one signed in.
const ACCOUNT_CHANGED: &str = "ACCOUNT_CHANGED";
const ACCOUNT_CHANGED_PREFIX: &str = "ACCOUNT_CHANGED:";

/// How the signed-in account relates to the one a workspace's bookkeeping belongs to.
#[derive(Debug, PartialEq, Eq)]
enum AccountDecision {
    /// the same account on the same server: everything stays as it is
    Same,
    /// the bookkeeping names no account yet: it is taken over as it is
    Adopt,
    /// another account or server: ask before anything is sent there
    Changed,
}

/// `user@server` as the bookkeeping records it (the server is already normalized at sign-in).
fn account_label(a: &account::Account) -> String {
    format!("{}@{}", a.username.to_lowercase(), a.server)
}

fn account_decision(state_account: &str, who: &str) -> AccountDecision {
    if state_account.is_empty() {
        AccountDecision::Adopt
    } else if state_account == who {
        AccountDecision::Same
    } else {
        AccountDecision::Changed
    }
}

/// What wakes the sync thread.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kick {
    /// the person changed something
    Edit,
    /// the server says another device saved
    Remote,
    /// the person asked (sign-in, "sync now", turning it on)
    User,
}

/// What the sync needs besides the vault. Cheap to clone, so that the sync thread, the listener and the commands share one.
#[derive(Clone)]
pub struct SyncCtx {
    app_data: PathBuf,
    status: Arc<Mutex<SyncStatus>>,
    /// per vault id: the held-back deletions the person confirmed; used up by the next sync of that vault
    confirm: Arc<Mutex<BTreeMap<String, Confirmation>>>,
    /// (vault id, server `seq` this device has applied): what the listener compares the server with
    synced: Arc<Mutex<(String, i64)>>,
    app: Option<AppHandle>,
}

/// Lives in the app's `Store`.
pub struct Runtime {
    ctx: SyncCtx,
    kick: Mutex<Sender<Kick>>,
}

impl Runtime {
    /// Starts the two background threads. Call once the `Store` is managed.
    pub fn start(app_data: &Path, app: &AppHandle) -> (Runtime, Receiver<Kick>) {
        let (tx, rx) = channel();
        let ctx = SyncCtx {
            app_data: app_data.to_path_buf(),
            status: Arc::new(Mutex::new(SyncStatus { state: "off", ..Default::default() })),
            confirm: Arc::new(Mutex::new(BTreeMap::new())),
            synced: Arc::new(Mutex::new((String::new(), -1))),
            app: Some(app.clone()),
        };
        (Runtime { ctx, kick: Mutex::new(tx) }, rx)
    }

    /// Something in the workspace changed on this device: the sync will look at it soon.
    pub fn edited(&self) {
        self.wake(Kick::Edit);
    }

    fn wake(&self, k: Kick) {
        if k == Kick::Edit {
            if let Ok(mut st) = self.ctx.status.lock() {
                if st.state == "idle" {
                    st.state = "pending";
                }
            }
        }
        if let Ok(tx) = self.kick.lock() {
            let _ = tx.send(k);
        }
    }
}

pub fn spawn(app: &AppHandle, rx: Receiver<Kick>) {
    let handle = app.clone();
    std::thread::spawn(move || sync_thread(handle, rx));
    let handle = app.clone();
    std::thread::spawn(move || listener(handle));
}

/// Tells the settings page that the status changed, so that it need not poll often.
fn emit_status(ctx: &SyncCtx) {
    if let Some(app) = &ctx.app {
        let _ = app.emit("sync-status", ());
    }
}

fn set_off(ctx: &SyncCtx) {
    if let Ok(mut st) = ctx.status.lock() {
        *st = SyncStatus { state: "off", ..Default::default() };
    }
    emit_status(ctx);
}

/// Runs a blocking job (network, proof of work) off the thread that serves the UI.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

fn current_entry(s: &Store) -> Option<Entry> {
    let r = s.reg.lock().ok()?;
    let id = r.current.clone()?;
    r.find(&id).cloned()
}

fn state_file(app_data: &Path, id: &str) -> PathBuf {
    app_data.join("sync").join(format!("{id}.json"))
}

// ───── the account ─────

/// The server to offer when nobody is signed in: the one used last, else the build's own (which may be empty).
fn last_or_default_server(app_data: &Path) -> String {
    Some(account::last_server(app_data)).filter(|x| !x.is_empty()).unwrap_or_else(|| account::DEFAULT_SERVER.to_string())
}

/// Signed in or not, and what the sync of the open vault is doing.
#[tauri::command]
pub fn account_status(s: St) -> Value {
    let acct = account::load(&s.app_data);
    let st = s.sync.ctx.status.lock().map(|x| x.clone()).unwrap_or_default();
    let sync_on = current_entry(&s).is_some_and(|e| e.sync);
    json!({
        "signedIn": acct.is_some(),
        "username": acct.as_ref().map(|a| a.username.clone()),
        "server": acct.as_ref().map_or_else(|| last_or_default_server(&s.app_data), |a| a.server.clone()),
        "defaultServer": account::DEFAULT_SERVER,
        "syncOn": sync_on,
        "vaultId": current_entry(&s).map(|e| e.id),
        "state": st.state,
        "lastAt": st.last_at,
        "error": st.error,
        "reason": st.reason,
        "skippedPaths": st.skipped,
    })
}

/// What a server says about itself (does it take new accounts, does it want an invite code); for the sign-up form.
#[tauri::command]
pub async fn server_health(server: String) -> Res<Value> {
    blocking(move || account::health(&server)).await
}

/// Creates an account and signs in. Returns the recovery key (shown once).
#[tauri::command]
pub async fn account_register(s: St<'_>, server: String, username: String, password: String, invite: String) -> Res<String> {
    let app_data = s.app_data.clone();
    let key = blocking(move || account::register(&app_data, &server, username.trim(), &password, invite.trim())).await?;
    s.sync.wake(Kick::User);
    Ok(key)
}

#[tauri::command]
pub async fn account_login(s: St<'_>, server: String, username: String, password: String) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || account::login(&app_data, &server, username.trim(), &password)).await?;
    s.sync.wake(Kick::User);
    Ok(())
}

/// A forgotten password: the recovery key sets a new one. Returns the new recovery key.
#[tauri::command]
pub async fn account_recover(s: St<'_>, server: String, username: String, recovery_key: String, new_password: String) -> Res<String> {
    let app_data = s.app_data.clone();
    let key = blocking(move || account::recover(&app_data, &server, username.trim(), &recovery_key, &new_password)).await?;
    s.sync.wake(Kick::User);
    Ok(key)
}

#[tauri::command]
pub async fn account_logout(s: St<'_>) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || {
        account::logout(&app_data);
        Ok(())
    })
    .await?;
    set_off(&s.sync.ctx);
    Ok(())
}

/// The account page: devices, storage used.
#[tauri::command]
pub async fn account_info(s: St<'_>) -> Res<Value> {
    let app_data = s.app_data.clone();
    blocking(move || account::info(&app_data)).await
}

#[tauri::command]
pub async fn account_revoke_device(s: St<'_>, id: String) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || account::revoke_device(&app_data, &id)).await
}

#[tauri::command]
pub async fn account_change_password(s: St<'_>, old_password: String, new_password: String) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || account::change_password(&app_data, &old_password, &new_password)).await
}

#[tauri::command]
pub async fn account_new_recovery_key(s: St<'_>, password: String) -> Res<String> {
    let app_data = s.app_data.clone();
    blocking(move || account::new_recovery_key(&app_data, &password)).await
}

/// Schedules the deletion of the account on the server (30 days of grace) and signs out here.
#[tauri::command]
pub async fn account_delete(s: St<'_>, password: String) -> Res<i64> {
    let app_data = s.app_data.clone();
    let after = blocking(move || account::delete_account(&app_data, &password)).await?;
    set_off(&s.sync.ctx);
    Ok(after)
}

/// Writes a small text file at a place the person chose in the save dialog (the recovery key). The webview of the desktop app
/// cannot download a file by itself. Only an absolute `.txt` path and a short text are accepted.
#[tauri::command]
pub fn save_text_file(path: String, text: String) -> Res<()> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || text.len() > 4096 || p.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() != Some("txt") {
        return Err("this file cannot be saved here".into());
    }
    write_atomic(&p, text.as_bytes())
}

// ───── the sync of the open vault ─────

/// Makes this device forget everything it knew about the server's copy of a vault (which server copy, what the last sync
/// recorded, what was held back), as on a fresh start: the next sync creates the vault on the server and only adds files,
/// because a new server copy has no tombstones and the engine has no baseline to plan deletions from.
pub(crate) fn forget_server_copy(state: &mut SyncState) {
    state.reset_local_baseline();
    state.hub = Default::default();
}

/// `forget_server_copy` for the state file of `id`, and drops a confirmation that was meant for the old server copy.
fn forget_server_copy_of(ctx: &SyncCtx, id: &str) -> Res<()> {
    let file = state_file(&ctx.app_data, id);
    let mut state = SyncState::load(&file);
    forget_server_copy(&mut state);
    state.save(&file)?;
    if let Ok(mut c) = ctx.confirm.lock() {
        c.remove(id);
    }
    if let Ok(mut synced) = ctx.synced.lock() {
        *synced = (String::new(), -1);
    }
    Ok(())
}

fn set_sync_flag(s: &Store, id: &str, on: bool) -> Res<()> {
    let mut r = s.reg.lock().map_err(err)?;
    if let Some(e) = r.vaults.iter_mut().find(|e| e.id == id) {
        e.sync = on;
    }
    r.save(&s.app_data)
}

/// Whether the sync of the open vault is paused because another account is signed in than the one it syncs with.
fn account_changed(ctx: &SyncCtx) -> bool {
    ctx.status.lock().is_ok_and(|st| st.reason == ACCOUNT_CHANGED)
}

/// Whether the sync of the open vault is paused because its copy on the server is gone.
fn cloud_is_gone(ctx: &SyncCtx) -> bool {
    ctx.status.lock().is_ok_and(|st| st.reason == sync::CLOUD_GONE)
}

/// Turns sync of the open vault on or off. Turning it off while the server copy is gone also forgets that copy, so that
/// turning it on later uploads the files again instead of stopping with "gone" once more.
#[tauri::command]
pub fn sync_set(s: St, on: bool) -> Res<()> {
    let id = with(&s, |v| Ok(v.id()))?;
    let gone = !on && cloud_is_gone(&s.sync.ctx);
    set_sync_flag(&s, &id, on)?;
    if !on {
        if gone {
            forget_server_copy_of(&s.sync.ctx, &id)?;
        }
        set_off(&s.sync.ctx);
    }
    s.sync.wake(Kick::User);
    Ok(())
}

/// The server copy of the open vault is gone (deleted there): sends the local files to the server again. The vault is created
/// on the server anew and every file goes up; nothing is deleted anywhere. Only valid while the sync is paused as CLOUD_GONE.
#[tauri::command]
pub fn sync_reupload(s: St) -> Res<()> {
    let id = with(&s, |v| Ok(v.id()))?;
    if !cloud_is_gone(&s.sync.ctx) {
        return Err("the workspace is still on the server".into());
    }
    forget_server_copy_of(&s.sync.ctx, &id)?;
    set_sync_flag(&s, &id, true)?;
    s.sync.wake(Kick::User);
    Ok(())
}

/// The workspace was syncing with another account or server and the person chose to send it to the signed-in one: forgets the
/// old server identity (as `sync_reupload` does), so that every file goes up and nothing is deleted. Only valid while paused as ACCOUNT_CHANGED.
#[tauri::command]
pub fn sync_accept_account(s: St) -> Res<()> {
    let id = with(&s, |v| Ok(v.id()))?;
    if !account_changed(&s.sync.ctx) {
        return Err("the workspace syncs with the signed-in account".into());
    }
    let acct = account::load(&s.app_data).ok_or("AUTH:signed_out")?;
    let file = state_file(&s.app_data, &id);
    let mut state = SyncState::load(&file);
    forget_server_copy(&mut state);
    state.account = account_label(&acct);
    state.save(&file)?;
    forget_server_copy_of(&s.sync.ctx, &id)?;
    set_sync_flag(&s, &id, true)?;
    s.sync.wake(Kick::User);
    Ok(())
}

#[tauri::command]
pub fn sync_now(s: St) {
    s.sync.wake(Kick::User);
}

/// The deletions the last sync of the open vault held back, as the person is to see them.
#[tauri::command]
pub fn sync_held(s: St) -> Res<Vec<HeldDelete>> {
    let id = with(&s, |v| Ok(v.id()))?;
    Ok(SyncState::load(&state_file(&s.sync.ctx.app_data, &id)).held)
}

/// The person confirmed the deletions a sync held back (many files, or a side that looked empty): `items` is the list they
/// were shown, and the next sync runs exactly those (a path that changed since is held again). Without `items` (an old
/// caller) everything that sync plans is confirmed.
#[tauri::command]
pub fn sync_confirm(s: St, items: Option<Vec<HeldDelete>>) -> Res<()> {
    let id = with(&s, |v| Ok(v.id()))?;
    let mut all = s.sync.ctx.confirm.lock().map_err(err)?;
    let c = all.entry(id).or_default();
    match items {
        Some(list) => c.items.extend(list.into_iter().map(|d| (d.path, d.base_md5))),
        None => c.all = true,
    }
    drop(all);
    s.sync.wake(Kick::User);
    Ok(())
}

/// Every vault stored in the account. The UI hides the ones that are on this device with their folder in place; those whose
/// folder is gone stay in the list, so that they can be downloaded again.
#[tauri::command]
pub async fn cloud_vaults(s: St<'_>) -> Res<Vec<Value>> {
    let app_data = s.app_data.clone();
    let r = blocking(move || account::api(&app_data)?.get("/v1/vaults")).await?;
    Ok(r["vaults"].as_array().cloned().unwrap_or_default().into_iter().map(|v| json!({ "id": v["id"], "name": v["name"], "files": v["files"], "bytes": v["bytes"] })).collect())
}

/// The vaults in the trash of the server (they are removed for good after a retention period).
#[tauri::command]
pub async fn cloud_trashed(s: St<'_>) -> Res<Vec<Value>> {
    let app_data = s.app_data.clone();
    let r = blocking(move || account::api(&app_data)?.get("/v1/vaults?trashed=1")).await?;
    Ok(r["vaults"].as_array().cloned().unwrap_or_default().into_iter().map(|v| json!({ "id": v["id"], "name": v["name"], "files": v["files"], "bytes": v["bytes"], "deletedAt": v["deleted_at"] })).collect())
}

/// Takes a vault out of the server's trash.
#[tauri::command]
pub async fn cloud_restore(s: St<'_>, id: String) -> Res<()> {
    crate::vault::check_id(&id)?;
    let app_data = s.app_data.clone();
    blocking(move || account::api(&app_data)?.post(&format!("/v1/vaults/{id}/undelete"), &json!({})).map(|_| ())).await
}

/// Whether `id` is the vault that is open on this device, which is the one whose sync has to stop when it leaves the server.
fn is_open_vault(current: Option<&str>, id: &str) -> bool {
    current == Some(id)
}

/// Moves a vault to the server's trash (restorable for the retention period). When it is the open vault of this device its sync
/// is turned off, so that this device neither recreates it nor fights with the server; local files are never touched.
/// Returns whether the sync of this device was turned off.
#[tauri::command]
pub async fn cloud_delete(s: St<'_>, id: String) -> Res<bool> {
    crate::vault::check_id(&id)?;
    let app_data = s.app_data.clone();
    let vid = id.clone();
    blocking(move || account::delete_vault(&app_data, &vid)).await?;
    let mut r = s.reg.lock().map_err(err)?;
    let open = is_open_vault(r.current.as_deref(), &id);
    let mut was_on = false;
    if let Some(e) = r.vaults.iter_mut().find(|e| e.id == id) {
        was_on = e.sync;
        e.sync = false;
    }
    if was_on || open {
        r.save(&s.app_data)?;
    }
    drop(r);
    if open {
        set_off(&s.sync.ctx);
    }
    Ok(open && was_on)
}

/// Removes a vault in the server's trash for good. The device token is enough; `password` is only for an older server that
/// still asks for it. Files on devices stay. When it is the open vault, its sync is turned off and its server identity forgotten
/// (as for a delete); with no vault open (first launch) there is nothing to turn off.
/// Returns whether the sync of this device was turned off.
#[tauri::command]
pub async fn cloud_purge(s: St<'_>, id: String, password: Option<String>) -> Res<bool> {
    crate::vault::check_id(&id)?;
    let app_data = s.app_data.clone();
    let vid = id.clone();
    blocking(move || account::purge_vault(&app_data, &vid, password.as_deref())).await?;
    let open = s.reg.lock().map_err(err)?.current.as_deref().is_some_and(|c| is_open_vault(Some(c), &id));
    if !open {
        return Ok(false);
    }
    let was_on = current_entry(&s).is_some_and(|e| e.sync);
    set_sync_flag(&s, &id, false)?;
    forget_server_copy_of(&s.sync.ctx, &id)?;
    set_off(&s.sync.ctx);
    Ok(was_on)
}

/// Creates `<parent>/<name>` for a vault that exists on the server, downloads it and opens it.
#[tauri::command]
pub async fn cloud_download(s: St<'_>, id: String, name: String, parent: String) -> Res<()> {
    let name = clean_name(&name)?;
    if !PathBuf::from(&parent).is_absolute() {
        return Err("path must be absolute".into());
    }
    let root = PathBuf::from(&parent).join(&name);
    let v = Vault::create_with_id(root.clone(), &name, &id)?;
    if v.id() != id {
        return Err(VAULT_MISMATCH.into()); // the folder already holds another vault
    }
    let e = Entry { id: v.id(), name, path: root.to_string_lossy().into(), sync: true };
    drop(v);
    let ctx = s.sync.ctx.clone();
    let e2 = e.clone();
    blocking(move || run_sync(&ctx, &e2, true, true)).await?;
    activate(&s, &e)
}

/// One synchronization of one vault: bring the mirror of the server up to date, then let the engine compare and move files.
/// `patient`: retry a lost request a few times. While the network is known to be down it is false: one try, then the back-off
/// decides when to look again, so that a sync does not sit for ten seconds in retries when the connection has just come back.
fn run_sync(ctx: &SyncCtx, e: &Entry, patient: bool, downloading: bool) -> Res<()> {
    let set = |state: &'static str, reason: &str, error: String, done: bool| {
        if let Ok(mut st) = ctx.status.lock() {
            st.state = state;
            st.reason = reason.to_string();
            st.error = error;
            if done {
                st.last_at = now_ms();
            }
        }
        emit_status(ctx);
    };
    set("syncing", "", String::new(), false);
    let result: Res<sync::Report> = (|| {
        // The vault must be there and be the one we think it is. A folder that vanished is never a reason to
        // delete the server's copy, and nothing is created here.
        let vault = Vault::open_as(PathBuf::from(&e.path), &e.id)?;
        let acct = account::load(&ctx.app_data).ok_or("AUTH:signed_out")?;
        let api = account::api(&ctx.app_data)?;
        let api = if patient { api } else { api.quick() };
        let state_file = state_file(&ctx.app_data, &e.id);
        let mut state = SyncState::load(&state_file);
        let who = account_label(&acct);
        match account_decision(&state.account, &who) {
            AccountDecision::Same => {}
            AccountDecision::Adopt => state.account = who, // a state from before the field existed, or never synced
            // another account or server is another cloud: nothing is reset and nothing goes up until the person says so
            AccountDecision::Changed => return Err(format!("{ACCOUNT_CHANGED}:{}", state.account)),
        }
        if downloading {
            state.reset_local_baseline();
            state.hub = Default::default();
        }
        state.me = (acct.device_id.clone(), account::device_name());
        let mut hub = Hub::new(api, &e.id, state.hub.clone());
        let pre = hub.preflight(&vault.name(), downloading)?;
        if pre.baseline {
            // a new server copy or a server that lost data (a device that was away longer than the server remembers keeps its bases):
            // what the engine believes about "the last sync" says nothing now, so it only adds, and deletes nothing
            state.files.clear();
        }
        let confirmed = ctx.confirm.lock().ok().and_then(|mut c| c.remove(&e.id)).unwrap_or_default();
        state.allow_deletes_once = confirmed.all;
        state.confirmed = confirmed.items;
        let rep = match sync::sync_once(&vault, &mut hub, &mut state, &mut |st| {
            let _ = st.save(&state_file); // after every batch of work: a crash costs only what came after
        }) {
            Ok(rep) => rep,
            Err(m) => {
                // sync_once uses the confirmation up when it decides about deletions: if it failed before that
                // (network, listing...), the person's confirmation is still unused and must survive for the retry
                if state.allow_deletes_once || !state.confirmed.is_empty() {
                    if let Ok(mut c) = ctx.confirm.lock() {
                        let back = c.entry(e.id.clone()).or_default();
                        back.all |= state.allow_deletes_once;
                        back.items.extend(std::mem::take(&mut state.confirmed));
                    }
                }
                return Err(m);
            }
        };
        state.hub = hub.cache.clone();
        state.save(&state_file)?;
        if let Ok(mut s) = ctx.synced.lock() {
            *s = (e.id.clone(), state.hub.seq);
        }
        Ok(rep)
    })();
    match result {
        Ok(rep) => {
            if let Ok(mut st) = ctx.status.lock() {
                st.skipped = rep.skipped_paths.iter().take(SKIPPED_SHOWN).cloned().collect();
            }
            // pages changed by another device: the open page and the lists are refreshed now, not at the next poll
            if rep.downloaded + rep.deleted + rep.conflicts + rep.state_merges + rep.auto_merged.len() > 0 {
                if let Some(app) = &ctx.app {
                    let _ = app.emit("vault-changed", e.id.clone());
                }
            }
            // pages whose edits from two devices were merged: the app says so
            if !rep.auto_merged.is_empty() {
                if let Some(app) = &ctx.app {
                    let _ = app.emit("page-auto-merged", serde_json::json!({ "pageIds": rep.auto_merged }));
                }
            }
            // conflict markers recorded here, closed elsewhere, or brought by another device
            if let Some(app) = &ctx.app {
                crate::page_conflicts::emit_changed(app, rep.marker_pages.iter().cloned());
            }
            if !rep.errors.is_empty() {
                let mut m = rep.errors.join("; ");
                if rep.held > 0 {
                    m = format!("{m}; {} deletions held back", rep.held);
                }
                let (state, reason) = if hub::is_network(&m) { ("offline", "NETWORK") } else if hub::is_auth(&m) { ("paused", "SIGNED_OUT") } else { ("error", "ERROR") };
                set(state, reason, m.clone(), false);
                Err(m)
            } else if rep.held > 0 {
                set("paused", "NEEDS_CONFIRM", rep.held.to_string(), false);
                Ok(())
            } else {
                set("idle", "", String::new(), true);
                Ok(())
            }
        }
        Err(m) if [VAULT_MISSING, VAULT_MISMATCH, sync::CLOUD_GONE].contains(&m.as_str()) => {
            set("paused", &m, String::new(), false);
            Err(m)
        }
        Err(m) if m.starts_with(ACCOUNT_CHANGED_PREFIX) => {
            set("paused", ACCOUNT_CHANGED, m[ACCOUNT_CHANGED_PREFIX.len()..].to_string(), false);
            Err(ACCOUNT_CHANGED.into())
        }
        Err(m) if hub::is_network(&m) => {
            set("offline", "NETWORK", m.clone(), false);
            Err(m)
        }
        Err(m) if hub::is_auth(&m) => {
            set("paused", "SIGNED_OUT", m.clone(), false);
            Err(m)
        }
        Err(m) => {
            set("error", "ERROR", m.clone(), false);
            Err(m)
        }
    }
}

/// How long to wait before trying again after the n-th failure in a row: 3, 6, 12, then 20 seconds. Short on purpose: the
/// network of a person who is offline comes and goes, and the first moment it is back is when their notes should move.
fn backoff(fails: u32) -> Duration {
    Duration::from_secs((3u64 << fails.saturating_sub(1).min(5)).min(20))
}

fn sync_thread(app: AppHandle, rx: Receiver<Kick>) {
    let mut fails = 0u32;
    let mut retry_at = Instant::now();
    loop {
        // an edit, the server, or the person wakes us at once; the long wait is only a safety net (it also catches changes
        // made by another program, such as an AI tool writing to the vault)
        let first = match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(k) => Some(k),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut urgent = matches!(first, Some(Kick::User | Kick::Remote));
        if first == Some(Kick::Edit) {
            // let a burst of edits settle: 1.5 s without another one (15 s at most); anything urgent ends the wait
            let started = Instant::now();
            let mut last = Instant::now();
            loop {
                let wait = Duration::from_millis(1500).saturating_sub(last.elapsed()).min(Duration::from_secs(15).saturating_sub(started.elapsed()));
                if wait.is_zero() {
                    break;
                }
                match rx.recv_timeout(wait) {
                    Ok(Kick::Edit) => last = Instant::now(),
                    Ok(_) => {
                        urgent = true;
                        break;
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        }
        // while the network is down an edit does not try again before the back-off is over; the server speaking to us, or the person, does
        if fails > 0 && !urgent && Instant::now() < retry_at {
            continue;
        }
        let s = app.state::<Store>();
        let ctx = s.sync.ctx.clone();
        let entry = current_entry(&s);
        let ready = entry.as_ref().is_some_and(|e| e.sync) && account::load(&ctx.app_data).is_some();
        match entry {
            Some(e) if ready => match run_sync(&ctx, &e, fails == 0, false) {
                Ok(()) => fails = 0,
                Err(_) => {
                    fails += 1;
                    retry_at = Instant::now() + backoff(fails);
                }
            },
            _ => {
                fails = 0;
                set_off(&ctx);
            }
        }
    }
}

/// Holds one request open to the server ("long poll"): it is answered the moment another device saves, so a change
/// arrives within a second without anyone asking over and over. When the network is down it retries with a growing
/// pause (at most 8 seconds), and the first answer after that wakes the sync at once.
fn listener(app: AppHandle) {
    let mut failures = 0u32;
    let mut hold = Duration::from_secs(4);
    loop {
        let s = app.state::<Store>();
        let ctx = s.sync.ctx.clone();
        let tx = s.sync.kick.lock().ok().map(|k| k.clone());
        let (Some(e), Some(tx)) = (current_entry(&s).filter(|e| e.sync), tx) else {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        drop(s);
        let Ok(api) = account::api(&ctx.app_data) else {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        let since = ctx.synced.lock().map(|g| if g.0 == e.id { g.1 } else { -1 }).unwrap_or(-1);
        if since < 0 {
            std::thread::sleep(Duration::from_secs(1)); // the first sync of this vault is still on its way
            continue;
        }
        let api = api.quick();
        // after a failure the first question is "are you there?", answered at once: waiting 25 seconds for news would hide that the network is back
        let wait = if failures > 0 { 0 } else { 25 };
        let url = api.url(&format!("/v1/vaults/{}/state?since={since}&wait={wait}", e.id));
        let answer = api.send(|c| c.get(&url).timeout(Duration::from_secs(40))).and_then(|r| r.json::<Value>().map_err(err));
        match answer {
            Ok(v) => {
                if failures > 0 {
                    failures = 0;
                    let _ = tx.send(Kick::Remote); // the network is back
                }
                if v["seq"].as_i64().unwrap_or(0) > since {
                    let _ = tx.send(Kick::Remote);
                    // wait until that sync has moved us forward; if it cannot (the server is failing), ask less and less often
                    let start = Instant::now();
                    let mut moved = false;
                    while start.elapsed() < hold {
                        std::thread::sleep(Duration::from_millis(200));
                        if ctx.synced.lock().map(|g| g.0 != e.id || g.1 > since).unwrap_or(true) {
                            moved = true;
                            break;
                        }
                    }
                    hold = if moved { Duration::from_secs(4) } else { (hold * 2).min(Duration::from_secs(60)) };
                }
            }
            Err(m) => {
                failures += 1;
                // two failures in a row: say so now, without waiting for the sync thread's own (slower) attempt to give up
                if failures >= 2 && hub::is_network(&m) {
                    if let Ok(mut st) = ctx.status.lock() {
                        if st.state == "idle" || st.state == "error" {
                            st.state = "offline";
                            st.reason = "NETWORK".into();
                        }
                    }
                }
                let pause = if hub::is_auth(&m) { 10 } else { (1u64 << failures.min(5)).min(8) };
                std::thread::sleep(Duration::from_secs(pause));
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forgetting_the_server_copy_leaves_nothing_to_delete_or_hold() {
        let mut state = SyncState::default();
        state.hub.epoch = "old".into();
        state.hub.seq = 7;
        state.files.insert("pages/a.json".into(), Default::default());
        state.held.push(HeldDelete { path: "pages/b.json".into(), side: "remote".into(), base_md5: "x".into() });
        state.resurrect_held.insert("pages/c.json".into(), "y".into());
        state.allow_deletes_once = true;
        state.confirmed.insert(("pages/d.json".into(), "z".into()));
        state.account = "me@server".into();
        forget_server_copy(&mut state);
        assert!(state.hub.epoch.is_empty() && state.hub.seq == 0 && state.hub.files.is_empty());
        assert!(state.files.is_empty() && state.held.is_empty() && state.resurrect_held.is_empty());
        assert!(!state.allow_deletes_once && state.confirmed.is_empty());
        assert_eq!(state.account, "me@server"); // the account is still the same one
    }

    #[test]
    fn forgetting_is_saved_for_the_vault_and_drops_its_confirmation() {
        let dir = std::env::temp_dir().join(format!("nevis-forget-{}-{}", now_ms(), std::process::id()));
        let ctx = SyncCtx {
            app_data: dir.clone(),
            status: Arc::new(Mutex::new(SyncStatus { state: "paused", reason: sync::CLOUD_GONE.into(), ..Default::default() })),
            confirm: Arc::new(Mutex::new(BTreeMap::new())),
            synced: Arc::new(Mutex::new(("v".into(), 5))),
            app: None,
        };
        std::fs::create_dir_all(dir.join("sync")).unwrap();
        let mut state = SyncState::default();
        state.hub.epoch = "old".into();
        state.files.insert("pages/a.json".into(), Default::default());
        state.save(&state_file(&dir, "v")).unwrap();
        ctx.confirm.lock().unwrap().insert("v".into(), Confirmation { all: true, ..Default::default() });
        assert!(cloud_is_gone(&ctx));
        forget_server_copy_of(&ctx, "v").unwrap();
        let after = SyncState::load(&state_file(&dir, "v"));
        assert!(after.hub.epoch.is_empty() && after.files.is_empty());
        assert!(ctx.confirm.lock().unwrap().is_empty());
        assert_eq!(*ctx.synced.lock().unwrap(), (String::new(), -1));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_account_decides_whether_a_workspace_may_sync() {
        use AccountDecision::*;
        assert_eq!(account_decision("", "me@https://s.example"), Adopt);
        assert_eq!(account_decision("me@https://s.example", "me@https://s.example"), Same);
        assert_eq!(account_decision("me@https://s.example", "you@https://s.example"), Changed);
        assert_eq!(account_decision("me@https://s.example", "me@https://other.example"), Changed);
        assert_eq!(account_decision("me@https://s.example", "me@http://localhost:3000"), Changed);
        // the same server typed in any form is one label (sign-in normalizes it); the user name is compared lowercase
        let label = |u: &str, srv: &str| account_label(&account::Account { server: account::normalize_server(srv).unwrap(), username: u.into(), ..Default::default() });
        let first = label("Me", "sync.example.com");
        for same in [label("me", "https://sync.example.com/"), label("ME", " sync.example.com "), label("mE", "https://sync.example.com")] {
            assert_eq!(account_decision(&first, &same), Same);
        }
        assert_eq!(account_decision(&first, &label("me", "sync.example.org")), Changed);
        assert_eq!(account_decision(&label("me", "http://localhost:3000"), &label("me", "localhost:3000")), Changed); // https vs http is another address
    }

    #[test]
    fn signing_out_and_in_again_keeps_the_bookkeeping() {
        let dir = std::env::temp_dir().join(format!("nevis-relogin-{}-{}", now_ms(), std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let acct = account::Account { server: "https://s.example".into(), username: "Me".into(), ..Default::default() };
        let mut state = SyncState::default();
        state.account = account_label(&acct);
        state.hub.epoch = "e".into();
        state.hub.seq = 3;
        state.files.insert("pages/a.json".into(), Default::default());
        let file = state_file(&dir, "v");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        state.save(&file).unwrap();
        // signing out (`account::clear`) only removes the credential and account.json, never the sync state; it is not called here
        // because it also deletes the real credential-store entry of the developer's own app
        let again = account::Account { username: "me".into(), ..acct }; // sign in again, user name typed in lowercase
        let loaded = SyncState::load(&file);
        assert_eq!(account_decision(&loaded.account, &account_label(&again)), AccountDecision::Same);
        assert_eq!(loaded.hub.epoch, "e");
        assert_eq!(loaded.hub.seq, 3);
        assert!(loaded.files.contains_key("pages/a.json"));
        assert_eq!(loaded.account, state.account);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn accepting_another_account_forgets_the_old_copy_but_turning_sync_off_keeps_it() {
        let mut state = SyncState::default();
        state.account = "old@https://s.example".into();
        state.hub.epoch = "e".into();
        state.files.insert("pages/a.json".into(), Default::default());
        // what sync_accept_account does to the state
        let mut accepted = state.clone();
        forget_server_copy(&mut accepted);
        accepted.account = "new@https://s.example".into();
        assert!(accepted.files.is_empty() && accepted.hub.epoch.is_empty());
        assert_eq!(account_decision(&accepted.account, "new@https://s.example"), AccountDecision::Same);
        // sync_set(false) only forgets when the copy is gone, never for ACCOUNT_CHANGED
        let ctx = SyncCtx {
            app_data: std::env::temp_dir(),
            status: Arc::new(Mutex::new(SyncStatus { state: "paused", reason: ACCOUNT_CHANGED.into(), ..Default::default() })),
            confirm: Default::default(),
            synced: Arc::new(Mutex::new((String::new(), -1))),
            app: None,
        };
        assert!(account_changed(&ctx) && !cloud_is_gone(&ctx));
    }

    #[test]
    fn only_the_open_vault_has_its_sync_stopped_when_it_leaves_the_server() {
        assert!(is_open_vault(Some("abc"), "abc"));
        assert!(!is_open_vault(Some("abc"), "abd"));
        assert!(!is_open_vault(None, "abc"));
    }
}
