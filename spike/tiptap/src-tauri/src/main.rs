#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Storage for Nevis: Vault folders (pages, attachments, history as plain files; see ADR-0003). The web UI talks to it
//! through the commands below (spike/tiptap/src/db.ts and attachments.ts); in a plain browser the same UI falls back to IndexedDB.

mod database;
mod index;
mod portable;
mod registry;
mod vault;
mod vault_lock;
mod updates;

use registry::{Entry, Registry};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};
use vault::{err, now_ms, Res, Vault, VAULT_MISMATCH, VAULT_MISSING};

struct Store {
    app_data: PathBuf, // per-device data: the list of vaults
    reg: Mutex<Registry>,
    vault: Mutex<Option<Vault>>,
    index: Mutex<Option<(PathBuf, rusqlite::Connection)>>, // search index of the open vault
}

type St<'a> = State<'a, Store>;

fn lock_vault<'a>(s: &'a St) -> Res<MutexGuard<'a, Option<Vault>>> {
    s.vault.lock().map_err(err)
}

/// Runs `f` on the open vault; errors when the picker is showing.
fn with<T>(s: &St, f: impl FnOnce(&Vault) -> Res<T>) -> Res<T> {
    let expected=s.reg.lock().map_err(err)?.current.clone();
    match &*lock_vault(s)? {
        Some(v) => {
            v.ensure_exclusive()?;
            // a vault whose folder vanished while it was open is not written to: that would re-create half of it
            if !v.root.join(".noviq/vault.json").is_file() {
                return Err(VAULT_MISSING.into());
            }
            if expected.as_deref()!=Some(v.id().as_str()){return Err(VAULT_MISMATCH.into());}
            f(v)
        }
        None => Err("no vault open".into()),
    }
}

// Settings that belong to this device and must not travel through the vault.
const LOCAL_KEYS: [&str; 2] = ["backupCfg", "graphLayouts"];

// ───── vaults: list, create, open, switch ─────

fn entry_json(e: &Entry) -> Value {
    let status = vault::probe(Path::new(&e.path), &e.id); // "ok" | "missing" | "mismatch"
    json!({ "id": e.id, "name": e.name, "path": e.path, "exists": status == "ok", "status": status })
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
fn activate(s: &St, e: &Entry) -> Res<()> {
    // never creates anything: a folder that vanished, or holds another vault, is reported instead of replaced by an empty one
    let v = Vault::open_as(PathBuf::from(&e.path), &e.id)?;
    v.purge_trash();
    let mut r = s.reg.lock().map_err(err)?;
    r.add(Entry { name: v.name(), ..e.clone() });
    r.current = Some(e.id.clone());
    r.save(&s.app_data)?;
    *lock_vault(s)? = Some(v);
    Ok(())
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
    let v = Vault::create(root.clone(), &name)?;
    let e = Entry { id: v.id(), name, path: root.to_string_lossy().into() };
    activate(&s, &e)?;
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
    let e = Entry { id: v.id(), name: v.name(), path };
    activate(&s, &e)?;
    Ok(e.id)
}

fn entry_of(s: &St, id: &str) -> Res<Entry> {
    s.reg.lock().map_err(err)?.find(id).cloned().ok_or_else(|| "unknown vault".to_string())
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
    r.save(&s.app_data)
}

/// Moves the folder of a vault to the Recycle Bin / Trash and forgets the vault on this device.
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
                let _ = activate(&s, &e);
            }
            return Err(err(m));
        }
    }
    let mut r = s.reg.lock().map_err(err)?;
    r.vaults.retain(|x| x.id != id);
    if r.current.as_deref() == Some(&id) {
        r.current = None;
    }
    r.save(&s.app_data)
}

/// The display name of a vault (it is kept in the vault folder).
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
    r.save(&s.app_data)
}

#[tauri::command]
fn vault_open(s: St, id: String) -> Res<()> {
    let e = s.reg.lock().map_err(err)?.find(&id).cloned().ok_or("unknown vault")?;
    activate(&s, &e)
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

/// Changes whenever a page file is added, removed or rewritten, by us or by another program.
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
fn pages_save(s: St, upserts: Vec<Value>, removed: Vec<String>, clear_first: bool) -> Res<Vec<String>> {
    // ids of pages whose newer version on disk (changed by another program) went to the page history before ours replaced it
    with(&s, |v| v.save_pages(&upserts, &removed, clear_first))
}

#[tauri::command]
fn vault_backup_export(s: St) -> Res<Value> { with(&s,|v| { database::recover(&v.root)?; serde_json::to_value(portable::export(v)?).map_err(err) }) }
#[tauri::command]
fn vault_backup_save(s: St, path: String) -> Res<()> {
    let p=PathBuf::from(path);
    if !p.is_absolute() || p.extension().and_then(|e|e.to_str()).map(str::to_ascii_lowercase).as_deref()!=Some("json"){return Err("BACKUP:invalid_destination".into());}
    with(&s,|v| {
        let parent=p.parent().ok_or("BACKUP:invalid_destination")?.canonicalize().map_err(err)?;
        if parent.starts_with(v.root.canonicalize().map_err(err)?) || parent.starts_with(s.app_data.canonicalize().map_err(err)?) {return Err("BACKUP:destination_inside_live_data".into());}
        database::recover(&v.root)?;
        let backup=portable::export(v)?;
        let bytes=serde_json::to_vec(&backup).map_err(err)?;
        vault::write_atomic(&p,&bytes)?;
        if vault::sha256_hex(&std::fs::read(&p).map_err(err)?)!=vault::sha256_hex(&bytes){return Err("BACKUP:verification_failed".into());}
        Ok(())
    })
}
#[tauri::command]
fn vault_backup_restore(s: St, data: Value) -> Res<Value> {
    let v=with(&s,|v|portable::restore(v.root.parent().ok_or("no parent directory")?,data))?;
    let entry=Entry{id:v.id(),name:v.name(),path:v.root.to_string_lossy().into()};
    activate(&s,&entry)?;
    Ok(json!({"pages":v.pages_all()?.len(),"files":v.files_list().len()}))
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
    with(&s, |v| match std::fs::read(kv_file(&s,v,&key)?) {
        Ok(bytes)=>serde_json::from_slice(&bytes).map(Some).map_err(|_|format!("STORAGE:unreadable_setting:{key}")),
        Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Ok(None),
        Err(e)=>Err(err(e))
    })
}

#[tauri::command]
fn kv_set(s: St, key: String, value: Value) -> Res<()> {
    with(&s, |v| vault::write_atomic(&kv_file(&s, v, &key)?, value.to_string().as_bytes()))
}

// ───── page history ─────

#[tauri::command]
fn versions_list(s: St, page_id: String) -> Res<Vec<Value>> {
    with(&s, |v| v.versions_list(&page_id))
}

#[tauri::command]
fn version_add(s: St, version: Value) -> Res<()> {
    with(&s, |v| v.version_add(&version))
}

#[tauri::command]
fn versions_delete(s: St, page_id: String) -> Res<()> {
    with(&s, |v| v.versions_delete(&page_id))
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
    with(&s, |v| v.file_put(&header(&request, "x-file-id"), bytes, &header(&request, "x-file-type"), &header(&request, "x-file-name"), added))
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
    // files may have been changed by another program: whatever the index says is no longer trustworthy
    let _ = db_index(&s, |c, _| c.execute("INSERT OR REPLACE INTO db_index_meta(key,value) VALUES('needs_rebuild','1')", []).map(|_| ()).map_err(err));
    with(&s, |v| database::load_all(&v.root))
}

#[tauri::command]
fn db_commit(s: St, batch: Value) -> Res<()> {
    with(&s, |v| database::commit(&v.root, &batch))?;
    // the index is derived: a failure here never fails a durable commit, it only marks the index for a rebuild
    let r = db_index(&s, |c, root| if database::index::needs_rebuild(c) { database::index::rebuild(c, root).map(|_| ()) } else { database::index::apply_batch(c, root, &batch) });
    if r.is_err() {
        let _ = db_index(&s, |c, _| c.execute("INSERT OR REPLACE INTO db_index_meta(key,value) VALUES('needs_rebuild','1')", []).map(|_| ()).map_err(err));
    }
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            app.manage(Store { reg: Mutex::new(Registry::load(&app_data)), app_data, vault: Mutex::new(None), index: Mutex::new(None) });
            // reopen the vault that was open last time; if it is gone, the picker is shown
            let s = app.state::<Store>();
            let cur = s.reg.lock().ok().and_then(|r| r.current.clone().and_then(|id| r.find(&id).cloned()));
            if let Some(e) = cur {
                if let Err(m) = activate(&s, &e) {
                    eprintln!("cannot open vault {}: {m}", e.path);
                    if let Ok(mut r) = s.reg.lock() {
                        r.current = None;
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::updates_check, updates::updates_download, updates::updates_install,
            vault_backup_save, vault_backup_export, vault_backup_restore, vault_list, vault_info, vault_create, vault_add, vault_open, vault_close, vault_forget, vault_locate, vault_trash_local, vault_rename,
            db_recover, db_load_all, db_commit, db_get_operation, db_history, db_undo_load, db_undo_save, db_runtime_get, db_runtime_set, db_runtime_delete,
            db_runtime_keys, db_index_rebuild, db_index_candidates, db_index_count,
            vault_stamp, pages_all, pages_save, kv_get, kv_set, versions_list, version_add, versions_delete, file_put, file_get, files_list,
            index_state, index_update, index_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nevis");
}
