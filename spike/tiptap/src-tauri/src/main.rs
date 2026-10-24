#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Storage for Noviq: Vault folders (pages, attachments, history as plain files; see ADR-0003) that the app can
//! keep in sync with the user's Google Drive by itself. The web UI talks to it through the commands below
//! (spike/tiptap/src/db.ts and attachments.ts); in a plain browser the same UI falls back to IndexedDB.

mod index;
mod legacy;
mod registry;
mod sync;
mod vault;

use registry::{Entry, Registry};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use sync::{auth, drive::Drive, SyncState};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use vault::{err, now_ms, Res, Vault};

#[derive(Clone, Default)]
struct SyncStatus {
    state: &'static str, // "off" | "idle" | "syncing" | "error"
    last_at: i64,
    error: String,
}

struct Store {
    app_data: PathBuf, // per-device data: the list of vaults, sign-in, sync bookkeeping
    reg: Mutex<Registry>,
    vault: Mutex<Option<Vault>>,
    status: Arc<Mutex<SyncStatus>>,
    kick: Mutex<Sender<()>>,
    index: Mutex<Option<(PathBuf, rusqlite::Connection)>>, // search index of the open vault
}

type St<'a> = State<'a, Store>;

fn lock_vault<'a>(s: &'a St) -> Res<MutexGuard<'a, Option<Vault>>> {
    s.vault.lock().map_err(err)
}

/// Runs `f` on the open vault; errors when the picker is showing.
fn with<T>(s: &St, f: impl FnOnce(&Vault) -> Res<T>) -> Res<T> {
    match &*lock_vault(s)? {
        Some(v) => f(v),
        None => Err("no vault open".into()),
    }
}

/// A change was written: let the sync thread know (it waits a moment so bursts become one sync).
fn kick(s: &St) {
    if let Ok(k) = s.kick.lock() {
        let _ = k.send(());
    }
}

// Settings that belong to this device and must not travel through the vault.
const LOCAL_KEYS: [&str; 1] = ["backupCfg"];

// ───── vaults: list, create, open, switch ─────

fn entry_json(e: &Entry) -> Value {
    json!({ "id": e.id, "name": e.name, "path": e.path, "sync": e.sync, "exists": Path::new(&e.path).join(".noviq/vault.json").exists() })
}

#[tauri::command]
fn vault_list(s: St) -> Res<Value> {
    let r = s.reg.lock().map_err(err)?;
    Ok(json!({ "vaults": r.vaults.iter().map(entry_json).collect::<Vec<_>>(), "current": r.current }))
}

#[tauri::command]
fn vault_info(s: St) -> Res<Value> {
    with(&s, |v| Ok(json!({ "id": v.id(), "name": v.name(), "path": v.root.to_string_lossy() })))
}

/// Makes the vault of `e` the open one.
fn activate(s: &St, e: &Entry, import_legacy: bool) -> Res<()> {
    let v = Vault::open(PathBuf::from(&e.path))?;
    if import_legacy {
        match legacy::import(&s.app_data, &v) {
            Ok(n) if n > 0 => eprintln!("imported {n} pages from noviq.db"),
            Ok(_) => {}
            Err(e) => eprintln!("legacy import failed: {e}"),
        }
    }
    v.purge_trash();
    let mut r = s.reg.lock().map_err(err)?;
    r.add(Entry { name: v.name(), ..e.clone() });
    r.current = Some(e.id.clone());
    r.save(&s.app_data)?;
    *lock_vault(s)? = Some(v);
    drop(r);
    kick(s);
    Ok(())
}

/// A vault created while signed in is synced from the start: signing in is all the user has to do.
fn auto_sync(s: &St) -> bool {
    auth::email(&s.app_data).is_some() && auth::creds(&s.app_data).is_some()
}

fn clean_name(name: &str) -> Res<String> {
    let n: String = name.trim().chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control()).collect();
    if n.is_empty() || n == "." || n == ".." {
        return Err("invalid name".into());
    }
    Ok(n)
}

/// New vault `<parent>/<name>`. The user picks the parent folder; there is no hidden default location.
#[tauri::command]
fn vault_create(s: St, parent: String, name: String) -> Res<String> {
    let name = clean_name(&name)?;
    let root = PathBuf::from(&parent).join(&name);
    if !PathBuf::from(&parent).is_absolute() {
        return Err("path must be absolute".into());
    }
    if root.join(".noviq/vault.json").exists() {
        return Err("a vault already exists there".into());
    }
    let first = s.reg.lock().map_err(err)?.vaults.is_empty();
    let v = Vault::create(root.clone(), &name)?;
    let e = Entry { id: v.id(), name, path: root.to_string_lossy().into(), sync: auto_sync(&s) };
    activate(&s, &e, first)?;
    Ok(e.id)
}

/// Opens a folder as a vault (an existing Noviq vault, e.g. one copied from another computer).
#[tauri::command]
fn vault_add(s: St, path: String) -> Res<String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() || !root.is_absolute() {
        return Err("not a folder".into());
    }
    let v = Vault::open(root.clone())?;
    let e = Entry { id: v.id(), name: v.name(), path, sync: auto_sync(&s) };
    activate(&s, &e, false)?;
    Ok(e.id)
}

#[tauri::command]
fn vault_open(s: St, id: String) -> Res<()> {
    let e = s.reg.lock().map_err(err)?.find(&id).cloned().ok_or("unknown vault")?;
    activate(&s, &e, false)
}

/// Back to the picker (switching vaults).
#[tauri::command]
fn vault_close(s: St) -> Res<()> {
    let mut r = s.reg.lock().map_err(err)?;
    r.current = None;
    r.save(&s.app_data)?;
    *lock_vault(&s)? = None;
    Ok(())
}

/// Forgets a vault on this device; its files stay where they are.
#[tauri::command]
fn vault_forget(s: St, id: String) -> Res<()> {
    let mut r = s.reg.lock().map_err(err)?;
    r.vaults.retain(|e| e.id != id);
    if r.current.as_deref() == Some(&id) {
        r.current = None;
        *lock_vault(&s)? = None;
    }
    r.save(&s.app_data)
}

/// Changes whenever a page file is added, removed or rewritten, by us or by the sync.
#[tauri::command]
fn vault_stamp(s: St) -> Res<String> {
    with(&s, |v| Ok(v.stamp()))
}

// ───── pages ─────

#[tauri::command]
fn pages_all(s: St) -> Res<Vec<Value>> {
    with(&s, |v| v.pages_all())
}

/// `clear_first` = the upserts are the whole workspace. Every page is its own atomic file write.
#[tauri::command]
fn pages_save(s: St, upserts: Vec<Value>, removed: Vec<String>, clear_first: bool) -> Res<()> {
    with(&s, |v| v.save_pages(&upserts, &removed, clear_first))?;
    kick(&s);
    Ok(())
}

// ───── key-value settings ─────

fn kv_file(s: &St, v: &Vault, key: &str) -> Res<PathBuf> {
    if LOCAL_KEYS.contains(&key) {
        vault::check_id(key)?;
        Ok(s.app_data.join("kv").join(format!("{key}.json")))
    } else {
        v.kv_path(key)
    }
}

#[tauri::command]
fn kv_get(s: St, key: String) -> Res<Option<Value>> {
    with(&s, |v| Ok(std::fs::read(kv_file(&s, v, &key)?).ok().and_then(|b| serde_json::from_slice(&b).ok())))
}

#[tauri::command]
fn kv_set(s: St, key: String, value: Value) -> Res<()> {
    with(&s, |v| vault::write_atomic(&kv_file(&s, v, &key)?, value.to_string().as_bytes()))?;
    kick(&s);
    Ok(())
}

// ───── page history ─────

#[tauri::command]
fn versions_list(s: St, page_id: String) -> Res<Vec<Value>> {
    with(&s, |v| v.versions_list(&page_id))
}

#[tauri::command]
fn version_add(s: St, version: Value) -> Res<()> {
    with(&s, |v| v.version_add(&version))?;
    kick(&s);
    Ok(())
}

#[tauri::command]
fn versions_delete(s: St, page_id: String) -> Res<()> {
    with(&s, |v| v.versions_delete(&page_id))?;
    kick(&s);
    Ok(())
}

// ───── attachments: <vault>/files/<id[0:2]>/<id> (+ <id>.json metadata); id = sha256 of the bytes ─────

fn header(r: &Request, k: &str) -> String {
    r.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// Raw body = file bytes; metadata in headers (the name is percent-encoded by the caller).
#[tauri::command]
fn file_put(s: St, request: Request) -> Res<()> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
    let added = header(&request, "x-added-at").parse::<i64>().unwrap_or_else(|_| now_ms());
    with(&s, |v| v.file_put(&header(&request, "x-file-id"), bytes, &header(&request, "x-file-type"), &header(&request, "x-file-name"), added))?;
    kick(&s);
    Ok(())
}

#[tauri::command]
fn file_get(s: St, id: String) -> Res<Response> {
    with(&s, |v| v.file_get(&id)).map(Response::new)
}

/// Metadata of every stored file (no bytes).
#[tauri::command]
fn files_list(s: St) -> Res<Vec<Value>> {
    with(&s, |v| Ok(v.files_list()))
}

#[tauri::command]
fn file_delete(s: St, id: String) -> Res<()> {
    with(&s, |v| v.file_delete(&id))?;
    kick(&s);
    Ok(())
}

#[tauri::command]
fn files_clear(s: St) -> Res<()> {
    with(&s, |v| {
        for f in v.files_list() {
            if let Some(id) = f.get("id").and_then(Value::as_str) {
                v.file_delete(id)?;
            }
        }
        Ok(())
    })?;
    kick(&s);
    Ok(())
}


// ───── search index (see index.rs; the UI sends normalized text, see searchIndex.ts) ─────

/// Runs `f` on the index of the open vault, opening (or switching to) it when needed.
fn with_index<T>(s: &St, f: impl FnOnce(&mut rusqlite::Connection) -> Res<T>) -> Res<T> {
    let root = with(s, |v| Ok(v.root.clone()))?;
    let mut g = s.index.lock().map_err(err)?;
    if g.as_ref().map_or(true, |(r, _)| *r != root) {
        *g = Some((root.clone(), index::open(&root)?));
    }
    f(&mut g.as_mut().unwrap().1)
}

#[tauri::command]
fn index_state(s: St) -> Res<std::collections::HashMap<String, i64>> {
    with_index(&s, |db| index::state(db))
}

#[tauri::command]
fn index_update(s: St, docs: Vec<index::Doc>, removed: Vec<String>) -> Res<()> {
    with_index(&s, |db| index::update(db, &docs, &removed))
}

#[tauri::command]
fn index_search(s: St, words: Vec<String>, limit: usize) -> Res<Vec<String>> {
    with_index(&s, |db| index::search(db, &words, limit))
}

// ───── account and sync ─────

fn drive_for(app_data: &Path) -> Res<Drive> {
    let c = auth::creds(app_data).ok_or("NOT_CONFIGURED")?;
    Drive::new(auth::Session::new(c, app_data))
}

#[tauri::command]
fn account_status(s: St) -> Value {
    let configured = auth::creds(&s.app_data).is_some();
    let email = auth::email(&s.app_data);
    let st = s.status.lock().map(|x| x.clone()).unwrap_or_default();
    let sync_on = lock_vault(&s).ok().and_then(|g| g.as_ref().map(|v| v.id())).and_then(|id| s.reg.lock().ok()?.find(&id).map(|e| e.sync)).unwrap_or(false);
    json!({ "configured": configured, "email": email, "syncOn": sync_on, "state": st.state, "lastAt": st.last_at, "error": st.error })
}

/// Opens the browser for Google sign-in and waits until it is done. Returns the e-mail address.
#[tauri::command]
async fn account_login(s: St<'_>) -> Res<String> {
    let app_data = s.app_data.clone();
    let c = auth::creds(&app_data).ok_or("NOT_CONFIGURED")?;
    let email = tauri::async_runtime::spawn_blocking(move || auth::login(&c, &app_data)).await.map_err(err)??;
    kick(&s);
    Ok(email)
}

#[tauri::command]
fn account_logout(s: St) -> Res<()> {
    auth::logout(&s.app_data);
    if let Ok(mut st) = s.status.lock() {
        *st = SyncStatus { state: "off", ..Default::default() };
    }
    Ok(())
}

/// Turns sync of the open vault on or off.
#[tauri::command]
fn sync_set(s: St, on: bool) -> Res<()> {
    let id = with(&s, |v| Ok(v.id()))?;
    let mut r = s.reg.lock().map_err(err)?;
    if let Some(e) = r.vaults.iter_mut().find(|e| e.id == id) {
        e.sync = on;
    }
    r.save(&s.app_data)?;
    drop(r);
    kick(&s);
    Ok(())
}

#[tauri::command]
fn sync_now(s: St) {
    kick(&s);
}

/// Vaults stored in the account that are not on this device yet.
#[tauri::command]
async fn cloud_vaults(s: St<'_>) -> Res<Vec<Value>> {
    let app_data = s.app_data.clone();
    let local: Vec<String> = s.reg.lock().map_err(err)?.vaults.iter().map(|e| e.id.clone()).collect();
    let found = tauri::async_runtime::spawn_blocking(move || drive_for(&app_data)?.cloud_vaults()).await.map_err(err)??;
    Ok(found.into_iter().filter(|v| !local.contains(&v.1)).map(|v| json!({ "folder": v.0, "id": v.1, "name": v.2 })).collect())
}

/// Creates `<parent>/<name>` for a vault that exists in the cloud and downloads it.
#[tauri::command]
async fn cloud_download(s: St<'_>, id: String, name: String, parent: String) -> Res<()> {
    let name = clean_name(&name)?;
    let root = PathBuf::from(&parent).join(&name);
    let v = Vault::create_with_id(root.clone(), &name, &id)?;
    let e = Entry { id: v.id(), name, path: root.to_string_lossy().into(), sync: true };
    drop(v);
    let (app_data, status) = (s.app_data.clone(), s.status.clone());
    let e2 = e.clone();
    tauri::async_runtime::spawn_blocking(move || run_sync(&app_data, &e2, &status)).await.map_err(err)??;
    activate(&s, &e, false)
}

/// One synchronization of one vault.
fn run_sync(app_data: &Path, e: &Entry, status: &Arc<Mutex<SyncStatus>>) -> Res<()> {
    let set = |state: &'static str, error: String, done: bool| {
        if let Ok(mut st) = status.lock() {
            st.state = state;
            st.error = error;
            if done {
                st.last_at = now_ms();
            }
        }
    };
    set("syncing", String::new(), false);
    let result: Res<()> = (|| {
        let vault = Vault { root: PathBuf::from(&e.path) };
        let mut drive = drive_for(app_data)?;
        let state_file = app_data.join("sync").join(format!("{}.json", e.id));
        let mut state = SyncState::load(&state_file);
        if state.remote_folder.is_empty() {
            state.remote_folder = drive.vault_folder(&e.id, &e.name)?;
        }
        let rep = {
            let mut remote = drive.remote_for(&state.remote_folder);
            sync::sync_once(&vault, &mut remote, &mut state)?
        };
        state.save(&state_file)?;
        if rep.errors.is_empty() { Ok(()) } else { Err(rep.errors.join("; ")) }
    })();
    match &result {
        Ok(()) => set("idle", String::new(), true),
        Err(m) => set("error", m.clone(), false),
    }
    result
}

fn sync_thread(app: AppHandle, rx: std::sync::mpsc::Receiver<()>) {
    loop {
        // a change wakes us at once; otherwise sync (and so look for remote changes) every minute
        let _ = rx.recv_timeout(Duration::from_secs(60));
        std::thread::sleep(Duration::from_millis(1500)); // let a burst of saves finish
        while rx.try_recv().is_ok() {}
        let s = app.state::<Store>();
        let entry = {
            let cur = s.reg.lock().ok().and_then(|r| r.current.clone());
            cur.and_then(|id| s.reg.lock().ok()?.find(&id).cloned())
        };
        let ready = entry.as_ref().is_some_and(|e| e.sync) && auth::email(&s.app_data).is_some() && auth::creds(&s.app_data).is_some();
        match entry {
            Some(e) if ready => {
                let _ = run_sync(&s.app_data, &e, &s.status);
            }
            _ => {
                if let Ok(mut st) = s.status.lock() {
                    st.state = "off";
                }
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let (tx, rx) = channel();
            app.manage(Store {
                reg: Mutex::new(Registry::load(&app_data)),
                app_data,
                vault: Mutex::new(None),
                status: Arc::new(Mutex::new(SyncStatus { state: "off", ..Default::default() })),
                kick: Mutex::new(tx),
                index: Mutex::new(None),
            });
            // reopen the vault that was open last time; if it is gone, the picker is shown
            let s = app.state::<Store>();
            let cur = s.reg.lock().ok().and_then(|r| r.current.clone().and_then(|id| r.find(&id).cloned()));
            if let Some(e) = cur {
                if let Err(m) = activate(&s, &e, false) {
                    eprintln!("cannot open vault {}: {m}", e.path);
                    if let Ok(mut r) = s.reg.lock() {
                        r.current = None;
                    }
                }
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || sync_thread(handle, rx));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_list, vault_info, vault_create, vault_add, vault_open, vault_close, vault_forget, vault_stamp, pages_all, pages_save, kv_get, kv_set,
            versions_list, version_add, versions_delete, file_put, file_get, files_list, file_delete, files_clear, account_status, account_login,
            account_logout, sync_set, sync_now, cloud_vaults, cloud_download, index_state, index_update, index_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running Noviq");
}
