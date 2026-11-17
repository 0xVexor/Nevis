//! The sync of the open workspace with the person's own Nevis server, as the app runs it: one thread syncs when something
//! changed (or the server says so), one thread listens to the server, and the commands below are what the settings page calls.
//! The engine itself (what moves, what waits, what is never deleted) is in `sync/`; nothing here decides about files.
use crate::registry::Entry;
use crate::sync::{self, account, hub, hub::Hub, SyncState};
use crate::vault::{err, now_ms, write_atomic, Res, Vault, VAULT_MISMATCH, VAULT_MISSING};
use crate::{activate, clean_name, with, St, Store};
use serde_json::{json, Value};
use std::collections::BTreeSet;
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
    /// why a sync is paused: VAULT_MISSING | VAULT_MISMATCH | CLOUD_GONE | SIGNED_OUT | NEEDS_CONFIRM (then `error` holds the number of held deletions)
    reason: String,
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
    /// vaults whose held-back deletions the person confirmed; used up by the next sync of that vault
    confirm: Arc<Mutex<BTreeSet<String>>>,
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
            confirm: Arc::new(Mutex::new(BTreeSet::new())),
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

fn set_off(ctx: &SyncCtx) {
    if let Ok(mut st) = ctx.status.lock() {
        *st = SyncStatus { state: "off", ..Default::default() };
    }
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

/// Signed in or not, and what the sync of the open vault is doing.
#[tauri::command]
pub fn account_status(s: St) -> Value {
    let acct = account::load(&s.app_data);
    let st = s.sync.ctx.status.lock().map(|x| x.clone()).unwrap_or_default();
    let sync_on = current_entry(&s).is_some_and(|e| e.sync);
    json!({
        "signedIn": acct.is_some(),
        "username": acct.as_ref().map(|a| a.username.clone()),
        "server": acct.as_ref().map_or_else(|| account::DEFAULT_SERVER.to_string(), |a| a.server.clone()),
        "defaultServer": account::DEFAULT_SERVER,
        "syncOn": sync_on,
        "state": st.state,
        "lastAt": st.last_at,
        "error": st.error,
        "reason": st.reason,
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

/// Turns sync of the open vault on or off.
#[tauri::command]
pub fn sync_set(s: St, on: bool) -> Res<()> {
    let id = with(&s, |v| Ok(v.id()))?;
    let mut r = s.reg.lock().map_err(err)?;
    if let Some(e) = r.vaults.iter_mut().find(|e| e.id == id) {
        e.sync = on;
    }
    r.save(&s.app_data)?;
    drop(r);
    if !on {
        set_off(&s.sync.ctx);
    }
    s.sync.wake(Kick::User);
    Ok(())
}

#[tauri::command]
pub fn sync_now(s: St) {
    s.sync.wake(Kick::User);
}

/// The person confirmed the deletions a sync held back (many files, or a side that looked empty): the next sync runs them.
#[tauri::command]
pub fn sync_confirm(s: St) -> Res<()> {
    let id = with(&s, |v| Ok(v.id()))?;
    s.sync.ctx.confirm.lock().map_err(err)?.insert(id);
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
    blocking(move || run_sync(&ctx, &e2, true)).await?;
    activate(&s, &e)
}

/// One synchronization of one vault: bring the mirror of the server up to date, then let the engine compare and move files.
/// `patient`: retry a lost request a few times. While the network is known to be down it is false: one try, then the back-off
/// decides when to look again, so that a sync does not sit for ten seconds in retries when the connection has just come back.
fn run_sync(ctx: &SyncCtx, e: &Entry, patient: bool) -> Res<()> {
    let set = |state: &'static str, reason: &str, error: String, done: bool| {
        if let Ok(mut st) = ctx.status.lock() {
            st.state = state;
            st.reason = reason.to_string();
            st.error = error;
            if done {
                st.last_at = now_ms();
            }
        }
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
        let who = format!("{}@{}", acct.username.to_lowercase(), acct.server);
        if state.account != who {
            // another account or server is another cloud: start over, with no `base` there is nothing to delete
            state.files.clear();
            state.hub = Default::default();
            state.account = who;
        }
        let mut hub = Hub::new(api, &e.id, state.hub.clone());
        let pre = hub.preflight(&vault.name())?;
        if pre.baseline {
            // a new server copy or a server that lost data (a device that was away longer than the server remembers keeps its bases):
            // what the engine believes about "the last sync" says nothing now, so it only adds, and deletes nothing
            state.files.clear();
        }
        state.allow_deletes_once = ctx.confirm.lock().map(|mut c| c.remove(&e.id)).unwrap_or(false);
        let rep = sync::sync_once(&vault, &mut hub, &mut state, &mut |st| {
            let _ = st.save(&state_file); // after every batch of work: a crash costs only what came after
        })?;
        state.hub = hub.cache.clone();
        state.save(&state_file)?;
        if let Ok(mut s) = ctx.synced.lock() {
            *s = (e.id.clone(), state.hub.seq);
        }
        Ok(rep)
    })();
    match result {
        Ok(rep) => {
            // pages changed by another device: the open page and the lists are refreshed now, not at the next poll
            if rep.downloaded + rep.deleted + rep.conflicts > 0 {
                if let Some(app) = &ctx.app {
                    let _ = app.emit("vault-changed", e.id.clone());
                }
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
            Some(e) if ready => match run_sync(&ctx, &e, fails == 0) {
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

