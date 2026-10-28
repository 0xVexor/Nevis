#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Storage for Nevis: Vault folders (pages, attachments, history as plain files; see ADR-0003) that the app can
//! keep in sync, by itself, through the Nevis sync server (server/ in this repository). The web UI talks to it through the commands below
//! (spike/tiptap/src/db.ts and attachments.ts); in a plain browser the same UI falls back to IndexedDB.

mod database;
mod document_operations;
mod index;
mod legacy;
mod registry;
mod sync;
mod vault;
mod updates;

use registry::{Entry, Registry};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use sync::hub::{self, Hub};
use sync::{account, SyncState};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use vault::{err, now_ms, Res, Vault, VAULT_MISMATCH, VAULT_MISSING};

#[derive(Clone, Default)]
struct SyncStatus {
    state: &'static str, // "off" | "idle" | "syncing" | "paused" | "error" | "offline"
    last_at: i64,
    error: String,
    /// why a sync is paused: VAULT_MISSING | VAULT_MISMATCH | CLOUD_GONE | SIGNED_OUT | NEEDS_CONFIRM (then `error` holds the number of held deletions)
    reason: String,
}

struct Store {
    app_data: PathBuf, // per-device data: the list of vaults, sign-in, sync bookkeeping
    reg: Mutex<Registry>,
    vault: Mutex<Option<Vault>>,
    ctx: SyncCtx,
    kick: Mutex<Sender<Kick>>,
    index: Mutex<Option<(PathBuf, rusqlite::Connection)>>, // search index of the open vault
}

type St<'a> = State<'a, Store>;

fn lock_vault<'a>(s: &'a St) -> Res<MutexGuard<'a, Option<Vault>>> {
    s.vault.lock().map_err(err)
}

/// Runs `f` on the open vault; errors when the picker is showing.
fn with<T>(s: &St, f: impl FnOnce(&Vault) -> Res<T>) -> Res<T> {
    match &*lock_vault(s)? {
        Some(v) => {
            // a vault whose folder vanished while it was open is not written to: that would re-create half of it
            if !v.root.join(".noviq/vault.json").is_file() {
                return Err(VAULT_MISSING.into());
            }
            f(v)
        }
        None => Err("no vault open".into()),
    }
}

/// A change was written: let the sync thread know (it waits a moment so bursts become one sync).
fn kick(s: &St) {
    kick_as(s, Kick::Edit);
}

// Settings that belong to this device and must not travel through the vault.
const LOCAL_KEYS: [&str; 1] = ["backupCfg"];

// ───── vaults: list, create, open, switch ─────

fn entry_json(e: &Entry) -> Value {
    let status = vault::probe(Path::new(&e.path), &e.id); // "ok" | "missing" | "mismatch"
    json!({ "id": e.id, "name": e.name, "path": e.path, "sync": e.sync, "exists": status == "ok", "status": status })
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
    // never creates anything: a folder that vanished, or holds another vault, is reported instead of replaced by an empty one
    let v = Vault::open_as(PathBuf::from(&e.path), &e.id)?;
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
    account::load(&s.app_data).is_some()
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

/// Opens a folder as a vault (an existing Nevis vault, e.g. one copied from another computer).
#[tauri::command]
fn vault_add(s: St, path: String) -> Res<String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() || !root.is_absolute() {
        return Err("not a folder".into());
    }
    let v = Vault::adopt(root.clone())?;
    let e = Entry { id: v.id(), name: v.name(), path, sync: auto_sync(&s) };
    activate(&s, &e, false)?;
    Ok(e.id)
}

fn entry_of(s: &St, id: &str) -> Res<Entry> {
    s.reg.lock().map_err(err)?.find(id).cloned().ok_or_else(|| "unknown vault".to_string())
}

fn state_file(app_data: &Path, id: &str) -> PathBuf {
    app_data.join("sync").join(format!("{id}.json"))
}

/// The user points at the folder of a vault that was moved or renamed.
#[tauri::command]
fn vault_locate(s: St, id: String, path: String) -> Res<()> {
    let root = PathBuf::from(&path);
    if !root.is_absolute() {
        return Err("path must be absolute".into());
    }
    let v = Vault::open_as(root, &id)?; // VAULT_MISSING / VAULT_MISMATCH
    let mut r = s.reg.lock().map_err(err)?;
    let e = r.vaults.iter_mut().find(|e| e.id == id).ok_or("unknown vault")?;
    e.path = path;
    e.name = v.name();
    r.save(&s.app_data)?;
    drop(r);
    kick(&s);
    Ok(())
}

/// Moves the folder of a vault to the Recycle Bin / Trash and forgets the vault on this device. The cloud copy stays.
#[tauri::command]
fn vault_trash_local(s: St, id: String) -> Res<()> {
    let e = entry_of(&s, &id)?;
    let was_open = lock_vault(&s)?.as_ref().is_some_and(|v| v.id() == id);
    if was_open {
        *lock_vault(&s)? = None;
        *s.index.lock().map_err(err)? = None; // the search index keeps a file of the vault open
    }
    if Path::new(&e.path).exists() {
        if let Err(m) = trash::delete(&e.path) {
            // nothing was removed: the vault stays as it was, open again if it was open
            if was_open {
                let _ = activate(&s, &e, false);
            }
            return Err(err(m));
        }
    }
    let mut r = s.reg.lock().map_err(err)?;
    r.vaults.retain(|x| x.id != id);
    if r.current.as_deref() == Some(&id) {
        r.current = None;
    }
    r.save(&s.app_data)?;
    let _ = std::fs::remove_file(state_file(&s.app_data, &id));
    Ok(())
}

/// The display name of a vault (it is kept in the vault folder and travels with the sync).
#[tauri::command]
fn vault_rename(s: St, id: String, name: String) -> Res<()> {
    let name = clean_name(&name)?;
    let e = entry_of(&s, &id)?;
    let open_one = lock_vault(&s)?.as_ref().is_some_and(|v| v.id() == id);
    if open_one {
        with(&s, |v| v.rename(&name))?;
    } else {
        Vault::open_as(PathBuf::from(&e.path), &id)?.rename(&name)?;
    }
    let mut r = s.reg.lock().map_err(err)?;
    if let Some(x) = r.vaults.iter_mut().find(|x| x.id == id) {
        x.name = name;
    }
    r.save(&s.app_data)?;
    drop(r);
    kick(&s);
    Ok(())
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
fn pages_save(s: St, upserts: Vec<Value>, removed: Vec<String>, clear_first: bool, expected_vault_id: Option<String>, expected_pages: Option<serde_json::Map<String, Value>>, expected_all: Option<Vec<Value>>) -> Res<Vec<String>> {
    // ids of pages whose newer version on disk (another device's edit) went to the page history before ours replaced it
    let kept = with(&s, |v| {
        if let Some(id) = &expected_vault_id {
            if v.id() != *id { return Err("Document vault changed".into()); }
            v.save_pages_checked(&upserts, &removed, clear_first, expected_pages.as_ref(), expected_all.as_deref())
        } else { Err("Missing document vault precondition".into()) }
    })?;
    kick(&s);
    Ok(kept)
}

#[tauri::command]
fn document_operation_find(s: St, scope_id: String, operation_id: String, expected_vault_id: String) -> Res<Option<Value>> {
    with(&s, |v| {
        if v.id() != expected_vault_id { return Err("Document vault changed".into()); }
        document_operations::find(v, &scope_id, &operation_id)
    })
}
#[tauri::command]
fn document_operation_commit(s: St, record: Value, expected_vault_id: String) -> Res<Value> {
    let receipt = with(&s, |v| {
        if v.id() != expected_vault_id { return Err("Document vault changed".into()); }
        document_operations::commit(v, &record)
    })?;
    kick(&s);
    Ok(receipt)
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


// ───── database records (see database/mod.rs; the query engine itself runs in the UI) ─────

/// Runs `f` on the derived database index of the open vault (created / versioned on first use).
fn db_index<T>(s: &St, f: impl FnOnce(&mut rusqlite::Connection, &Path) -> Res<T>) -> Res<T> {
    let root = with(s, |v| Ok(v.root.clone()))?;
    with_index(s, |c| {
        database::index::ensure_schema(c)?;
        f(c, &root)
    })
}

#[tauri::command]
fn db_recover(s: St) -> Res<Value> {
    with(&s, |v| database::recover(&v.root))
}

#[tauri::command]
fn db_load_all(s: St) -> Res<Value> {
    // files may have been changed by the sync tool: whatever the index says is no longer trustworthy
    let _ = db_index(&s, |c, _| c.execute("INSERT OR REPLACE INTO db_index_meta(key,value) VALUES('needs_rebuild','1')", []).map(|_| ()).map_err(err));
    with(&s, |v| database::load_all(&v.root))
}

#[tauri::command]
fn db_commit(s: St, batch: Value) -> Res<()> {
    with(&s, |v| {
        if batch.get("vaultId").and_then(Value::as_str) != Some(v.id().as_str()) { return Err("Document vault changed".into()); }
        database::commit(&v.root, &batch)
    })?;
    // the index is derived: a failure here never fails a durable commit, it only marks the index for a rebuild
    let r = db_index(&s, |c, root| if database::index::needs_rebuild(c) { database::index::rebuild(c, root).map(|_| ()) } else { database::index::apply_batch(c, root, &batch) });
    if r.is_err() {
        let _ = db_index(&s, |c, _| c.execute("INSERT OR REPLACE INTO db_index_meta(key,value) VALUES('needs_rebuild','1')", []).map(|_| ()).map_err(err));
    }
    kick(&s);
    Ok(())
}

#[tauri::command]
fn db_get_operation(s: St, id: String) -> Res<Option<Value>> {
    with(&s, |v| database::get_operation(&v.root, &id))
}

#[tauri::command]
fn db_history(s: St, kind: String, id: String) -> Res<Vec<Value>> {
    with(&s, |v| database::history(&v.root, &kind, &id))
}

#[tauri::command]
fn db_undo_load(s: St) -> Res<Value> {
    with(&s, |v| Ok(database::undo_load(&v.root)))
}

#[tauri::command]
fn db_undo_save(s: St, groups: Value) -> Res<()> {
    with(&s, |v| database::undo_save(&v.root, &groups))
}

#[tauri::command]
fn db_runtime_get(s: St, key: String) -> Res<Option<Value>> {
    with(&s, |v| database::runtime_get(&v.root, &key))
}

#[tauri::command]
fn db_runtime_set(s: St, key: String, value: Value) -> Res<()> {
    with(&s, |v| database::runtime_set(&v.root, &key, &value))
}

#[tauri::command]
fn db_runtime_delete(s: St, key: String) -> Res<()> {
    with(&s, |v| database::runtime_delete(&v.root, &key))
}

#[tauri::command]
fn db_runtime_keys(s: St, prefix: String) -> Res<Vec<String>> {
    with(&s, |v| Ok(database::runtime_keys(&v.root, &prefix)))
}

#[tauri::command]
fn db_index_rebuild(s: St) -> Res<usize> {
    db_index(&s, |c, root| database::index::rebuild(c, root))
}

#[tauri::command]
fn db_index_candidates(s: St, source: String, property: String, op: String, operand: Value) -> Res<Vec<String>> {
    db_index(&s, |c, root| {
        if database::index::needs_rebuild(c) {
            database::index::rebuild(c, root)?;
        }
        database::index::candidates(c, root, &source, &property, &op, &operand)
    })
}

#[tauri::command]
fn db_index_count(s: St, source: String) -> Res<i64> {
    db_index(&s, |c, root| {
        if database::index::needs_rebuild(c) {
            database::index::rebuild(c, root)?;
        }
        database::index::count_items(c, root, &source)
    })
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

/// Why the sync thread was woken. A saved edit syncs at once; a change reported by the server (or the user pressing
/// "Sync now") may also try while the network was known to be down, an edit may not (it would only wait for a timeout again).
#[derive(Clone, Copy, PartialEq)]
enum Kick {
    Edit,
    Remote,
    User,
}

/// What the sync needs besides the vault. Cheap to clone, so that the sync thread, the watcher and the commands share one.
#[derive(Clone)]
struct SyncCtx {
    app_data: PathBuf,
    status: Arc<Mutex<SyncStatus>>,
    /// vaults whose held-back deletions the user confirmed; used up by the next sync of that vault
    confirm: Arc<Mutex<BTreeSet<String>>>,
    /// (vault id, server `seq` this device has applied): what the watcher compares the server with
    synced: Arc<Mutex<(String, i64)>>,
    app: Option<AppHandle>,
}

fn kick_as(s: &St, k: Kick) {
    if let Ok(tx) = s.kick.lock() {
        let _ = tx.send(k);
    }
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

/// Signed in or not, and what the sync of the open vault is doing.
#[tauri::command]
fn account_status(s: St) -> Value {
    let acct = account::load(&s.app_data);
    let st = s.ctx.status.lock().map(|x| x.clone()).unwrap_or_default();
    let sync_on = lock_vault(&s).ok().and_then(|g| g.as_ref().map(|v| v.id())).and_then(|id| s.reg.lock().ok()?.find(&id).map(|e| e.sync)).unwrap_or(false);
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
async fn server_health(server: String) -> Res<Value> {
    blocking(move || account::health(&server)).await
}

/// Creates an account and signs in. Returns the recovery key (shown once).
#[tauri::command]
async fn account_register(s: St<'_>, server: String, username: String, password: String, invite: String) -> Res<String> {
    let app_data = s.app_data.clone();
    let key = blocking(move || account::register(&app_data, &server, username.trim(), &password, invite.trim())).await?;
    kick_as(&s, Kick::User);
    Ok(key)
}

#[tauri::command]
async fn account_login(s: St<'_>, server: String, username: String, password: String) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || account::login(&app_data, &server, username.trim(), &password)).await?;
    kick_as(&s, Kick::User);
    Ok(())
}

/// A forgotten password: the recovery key sets a new one. Returns the new recovery key.
#[tauri::command]
async fn account_recover(s: St<'_>, server: String, username: String, recovery_key: String, new_password: String) -> Res<String> {
    let app_data = s.app_data.clone();
    let key = blocking(move || account::recover(&app_data, &server, username.trim(), &recovery_key, &new_password)).await?;
    kick_as(&s, Kick::User);
    Ok(key)
}

#[tauri::command]
async fn account_logout(s: St<'_>) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || {
        account::logout(&app_data);
        Ok(())
    })
    .await?;
    set_off(&s.ctx);
    Ok(())
}

/// The account page: devices, storage used.
#[tauri::command]
async fn account_info(s: St<'_>) -> Res<Value> {
    let app_data = s.app_data.clone();
    blocking(move || account::info(&app_data)).await
}

#[tauri::command]
async fn account_revoke_device(s: St<'_>, id: String) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || account::revoke_device(&app_data, &id)).await
}

#[tauri::command]
async fn account_change_password(s: St<'_>, old_password: String, new_password: String) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || account::change_password(&app_data, &old_password, &new_password)).await
}

#[tauri::command]
async fn account_new_recovery_key(s: St<'_>, password: String) -> Res<String> {
    let app_data = s.app_data.clone();
    blocking(move || account::new_recovery_key(&app_data, &password)).await
}

/// Schedules the deletion of the account on the server (30 days of grace) and signs out here.
#[tauri::command]
async fn account_delete(s: St<'_>, password: String) -> Res<i64> {
    let app_data = s.app_data.clone();
    let after = blocking(move || account::delete_account(&app_data, &password)).await?;
    set_off(&s.ctx);
    Ok(after)
}

/// Writes a small text file at a place the user chose in the save dialog (the recovery key). The webview of the desktop app
/// cannot download a file by itself. Only an absolute `.txt` path and a short text are accepted.
#[tauri::command]
fn save_text_file(path: String, text: String) -> Res<()> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || text.len() > 4096 || p.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() != Some("txt") {
        return Err("this file cannot be saved here".into());
    }
    vault::write_atomic(&p, text.as_bytes())
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
    kick_as(&s, Kick::User);
    Ok(())
}

#[tauri::command]
fn sync_now(s: St) {
    kick_as(&s, Kick::User);
}

/// The user confirmed the deletions a sync held back (many files, or a side that looked empty): the next sync runs them.
#[tauri::command]
fn sync_confirm(s: St) -> Res<()> {
    let id = with(&s, |v| Ok(v.id()))?;
    s.ctx.confirm.lock().map_err(err)?.insert(id);
    kick_as(&s, Kick::User);
    Ok(())
}

/// The cloud copy of a vault goes to the server's trash (30 days); the vault on this device stays and its sync is turned off here.
#[tauri::command]
async fn cloud_delete(s: St<'_>, id: String) -> Res<()> {
    {
        let mut r = s.reg.lock().map_err(err)?;
        if let Some(e) = r.vaults.iter_mut().find(|e| e.id == id) {
            e.sync = false;
        }
        r.save(&s.app_data)?;
    }
    let app_data = s.app_data.clone();
    let vault_id = id.clone();
    blocking(move || {
        let api = account::api(&app_data)?;
        let url = api.url(&format!("/v1/vaults/{vault_id}"));
        api.send(|c| c.delete(&url)).map(|_| ())
    })
    .await?;
    // a later upload starts from a clean slate: a missing cloud must never be read as "deleted there"
    let _ = std::fs::remove_file(state_file(&s.app_data, &id));
    set_off(&s.ctx);
    Ok(())
}

/// The cloud copy is gone but the vault here is kept: sync it again as a new cloud copy (everything is uploaded, nothing is deleted).
#[tauri::command]
fn cloud_reupload(s: St, id: String) -> Res<()> {
    let _ = std::fs::remove_file(state_file(&s.app_data, &id));
    let mut r = s.reg.lock().map_err(err)?;
    if let Some(e) = r.vaults.iter_mut().find(|e| e.id == id) {
        e.sync = true;
    }
    r.save(&s.app_data)?;
    drop(r);
    kick_as(&s, Kick::User);
    Ok(())
}

/// Every vault stored in the account. The UI hides the ones that are on this device with their folder in place; those whose
/// folder is gone stay in the list, so that they can be downloaded again.
#[tauri::command]
async fn cloud_vaults(s: St<'_>) -> Res<Vec<Value>> {
    let app_data = s.app_data.clone();
    let r = blocking(move || account::api(&app_data)?.get("/v1/vaults")).await?;
    Ok(r["vaults"].as_array().cloned().unwrap_or_default().into_iter().map(|v| json!({ "id": v["id"], "name": v["name"], "files": v["files"], "bytes": v["bytes"] })).collect())
}

/// Vaults deleted from the account in the last 30 days, which can still be brought back.
#[tauri::command]
async fn cloud_trashed(s: St<'_>) -> Res<Vec<Value>> {
    let app_data = s.app_data.clone();
    let r = blocking(move || account::api(&app_data)?.get("/v1/vaults?trashed=1")).await?;
    Ok(r["vaults"].as_array().cloned().unwrap_or_default().into_iter().map(|v| json!({ "id": v["id"], "name": v["name"], "deletedAt": v["deleted_at"] })).collect())
}

/// Deletes a vault that is in the server's trash for good. The server refuses a vault that is not in the trash.
#[tauri::command]
async fn cloud_purge(s: St<'_>, id: String) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || {
        let api = account::api(&app_data)?;
        let url = api.url(&format!("/v1/vaults/{id}/permanent"));
        api.send(|c| c.delete(&url)).map(|_| ()).map_err(|e| {
            if matches!(e.lines().next(), Some("HUB:not_found" | "HUB:http_404")) {
                format!("HUB:permanent_delete_unavailable\noperation=permanent_delete\n{e}")
            } else { e }
        })
    })
    .await
}

#[tauri::command]
async fn cloud_restore(s: St<'_>, id: String) -> Res<()> {
    let app_data = s.app_data.clone();
    blocking(move || account::api(&app_data)?.post(&format!("/v1/vaults/{id}/undelete"), &json!({})).map(|_| ())).await
}

/// Creates `<parent>/<name>` for a vault that exists in the cloud and downloads it.
#[tauri::command]
async fn cloud_download(s: St<'_>, id: String, name: String, parent: String) -> Res<()> {
    let name = clean_name(&name)?;
    let root = PathBuf::from(&parent).join(&name);
    let v = Vault::create_with_id(root.clone(), &name, &id)?;
    if v.id() != id {
        return Err(VAULT_MISMATCH.into()); // the folder already holds another vault
    }
    let e = Entry { id: v.id(), name, path: root.to_string_lossy().into(), sync: true };
    drop(v);
    let ctx = s.ctx.clone();
    let e2 = e.clone();
    blocking(move || run_sync(&ctx, &e2, true)).await?;
    activate(&s, &e, false)
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
        // delete the cloud copy, and nothing is created here.
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
            // a new cloud copy, a server that lost data, or a device that was away longer than the server remembers:
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
                let m = rep.errors.join("; ");
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

fn current_entry(s: &Store) -> Option<Entry> {
    let cur = s.reg.lock().ok().and_then(|r| r.current.clone());
    cur.and_then(|id| s.reg.lock().ok()?.find(&id).cloned())
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
        // an edit, the server, or the user wakes us at once; the long wait is only a safety net
        let first = match rx.recv_timeout(Duration::from_secs(300)) {
            Ok(k) => Some(k),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut urgent = matches!(first, Some(Kick::User | Kick::Remote));
        if first == Some(Kick::Edit) {
            std::thread::sleep(Duration::from_millis(250)); // let a burst of saves finish; a change from the server is not a burst and goes at once
            while let Ok(k) = rx.try_recv() {
                urgent |= matches!(k, Kick::User | Kick::Remote);
            }
        }
        // while the network is down an edit does not try again before the back-off is over; the server speaking to us, or the user, does
        if fails > 0 && !urgent && Instant::now() < retry_at {
            continue;
        }
        let s = app.state::<Store>();
        let ctx = s.ctx.clone();
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
fn watcher(app: AppHandle) {
    let mut failures = 0u32;
    let mut hold = Duration::from_secs(4);
    loop {
        let s = app.state::<Store>();
        let ctx = s.ctx.clone();
        let tx = s.kick.lock().ok().map(|k| k.clone());
        let (Some(e), Some(tx)) = (current_entry(&s).filter(|e| e.sync), tx) else {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            document_operations::configure(&app_data).map_err(std::io::Error::other)?;
            account::forget_google(&app_data); // the sign-in of earlier versions is gone
            let (tx, rx) = channel();
            let ctx = SyncCtx {
                app_data: app_data.clone(),
                status: Arc::new(Mutex::new(SyncStatus { state: "off", ..Default::default() })),
                confirm: Arc::new(Mutex::new(BTreeSet::new())),
                synced: Arc::new(Mutex::new((String::new(), -1))),
                app: Some(app.handle().clone()),
            };
            app.manage(Store { reg: Mutex::new(Registry::load(&app_data)), app_data, vault: Mutex::new(None), ctx, kick: Mutex::new(tx), index: Mutex::new(None) });
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
            let handle = app.handle().clone();
            std::thread::spawn(move || watcher(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::updates_check, updates::updates_download, updates::updates_install,
            vault_list, vault_info, vault_create, vault_add, vault_open, vault_close, vault_forget, vault_locate, vault_trash_local, vault_rename,
            db_recover, db_load_all, db_commit, db_get_operation, db_history, db_undo_load, db_undo_save, db_runtime_get, db_runtime_set, db_runtime_delete,
            db_runtime_keys, db_index_rebuild, db_index_candidates, db_index_count,
            vault_stamp, pages_all, pages_save, document_operation_find, document_operation_commit, kv_get, kv_set, versions_list, version_add, versions_delete, file_put, file_get, files_list,
            file_delete, files_clear, account_status, server_health, account_register, account_login, account_recover, account_logout, account_info,
            account_revoke_device, account_change_password, account_new_recovery_key, account_delete, save_text_file, sync_set, sync_now, sync_confirm, cloud_vaults,
            cloud_trashed, cloud_restore, cloud_purge, cloud_download, cloud_delete, cloud_reupload, index_state, index_update, index_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nevis");
}
