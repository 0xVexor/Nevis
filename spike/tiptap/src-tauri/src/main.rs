#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Storage for Nevis: Vault folders (pages, attachments, history as plain files; see ADR-0003). The web UI talks to it
//! through the commands below (spike/tiptap/src/db.ts and attachments.ts); in a plain browser the same UI falls back to IndexedDB.

mod database;
mod deck_print;
mod release_features;
mod document_operations;
mod mcp;
mod mcp_relay;
mod index;
mod portable;
mod registry;
mod vault;
mod vault_lock;
mod updates;

use registry::{Entry, Registry};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager, State};
use vault::{err, now_ms, Res, Vault, VAULT_MISMATCH, VAULT_MISSING};

struct Store {
    mcp: Arc<mcp::Host>,
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
            if !v.root.join(".nevis/vault.json").is_file() {
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

fn migrate_app_directory(current: &Path) -> std::io::Result<()> {
    let legacy = current.with_file_name("com.vexor.noviq");
    if current.exists() || !legacy.is_dir() {
        return Ok(());
    }
    match std::fs::rename(legacy, current) {
        Err(_) if current.is_dir() => Ok(()),
        result => result,
    }
}

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
    s.mcp.stop();
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
    if vault::marker_path(&root).exists() {
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
        s.mcp.stop();
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
    s.mcp.stop();
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
        s.mcp.stop();
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

// MCP commands are local main-window controls, never protocol methods.
fn mcp_window(window: &tauri::WebviewWindow) -> Res<()> {
    if window.label() != "main" { return Err("Connection access denied".into()); }
    Ok(())
}
#[tauri::command]
fn mcp_ready(s: St, window: tauri::WebviewWindow, expected_vault_id: String, owner: String) -> Res<()> {
    mcp_window(&window)?;
    with(&s, |v| { if v.id() != expected_vault_id { return Err("Connection vault changed".into()); } s.mcp.ready(&expected_vault_id, &owner) })
}
#[tauri::command]
fn mcp_status(s: St, window: tauri::WebviewWindow) -> Res<Value> { mcp_window(&window)?; s.mcp.status() }
#[tauri::command]
fn mcp_enable(s: St, window: tauri::WebviewWindow, expected_vault_id: String, policy: mcp::Policy) -> Res<Value> {
    mcp_window(&window)?;
    with(&s, |v| {
        if v.id() != expected_vault_id { return Err("Connection vault changed".into()); }
        let config_dir = s.app_data.join("mcp");
        std::fs::create_dir_all(&config_dir).map_err(err)?;
        if std::fs::canonicalize(&config_dir).map_err(err)?.starts_with(std::fs::canonicalize(&v.root).map_err(err)?) { return Err("Connection settings must be outside the vault".into()); }
        let status = s.mcp.enable(&s.app_data, &expected_vault_id, policy.clone())?;
        // the choice survives a restart: the connection comes back by itself when this vault opens
        mcp_relay::autostart_set(&s.app_data, &expected_vault_id, &policy)?;
        Ok(status)
    })
}
#[tauri::command]
fn mcp_disable(s: St, window: tauri::WebviewWindow) -> Res<()> {
    mcp_window(&window)?;
    s.mcp.stop();
    let id = with(&s, |v| Ok(v.id()))?;
    mcp_relay::autostart_remove(&s.app_data, &id)
}
/// The scope to switch back on for this vault, if the user left the connection on last time.
#[tauri::command]
fn mcp_autostart(s: St, window: tauri::WebviewWindow, expected_vault_id: String) -> Res<Option<mcp::Policy>> {
    mcp_window(&window)?;
    Ok(mcp_relay::autostart_get(&s.app_data, &expected_vault_id))
}
/// How an AI client starts the relay, for the copy-for-any-AI text.
#[tauri::command]
fn mcp_setup_info(window: tauri::WebviewWindow) -> Res<Value> {
    mcp_window(&window)?;
    let exe = std::env::current_exe().map_err(err)?;
    Ok(json!({"command": exe.to_string_lossy(), "args": [mcp_relay::RELAY_FLAG]}))
}
/// Writes the Nevis entry into Claude Desktop, Codex or Gemini CLI settings (other entries are kept, a backup is made).
#[tauri::command]
fn mcp_install_client(window: tauri::WebviewWindow, client: String) -> Res<String> {
    mcp_window(&window)?;
    let exe = std::env::current_exe().map_err(err)?;
    Ok(mcp_relay::install_client(&client, &exe)?.to_string_lossy().to_string())
}
#[tauri::command]
fn mcp_credential(s: St, window: tauri::WebviewWindow, expected_vault_id: String) -> Res<String> {
    mcp_window(&window)?;
    with(&s, |v| { if v.id() != expected_vault_id { return Err("Connection vault changed".into()); } s.mcp.credential() })
}
#[tauri::command]
fn mcp_reply(s: St, window: tauri::WebviewWindow, request_id: String, revision: String, result: Value) -> Res<()> {
    mcp_window(&window)?; s.mcp.reply(&request_id, &revision, result)
}

// ───── pages ─────

#[tauri::command]
fn pages_search_stamp(s: St) -> Res<Option<String>> {
    with(&s, |v| v.pages_search_stamp())
}

#[tauri::command]
fn pages_all(s: St) -> Res<Vec<Value>> {
    with(&s, |v| v.pages_all())
}

/// `clear_first` = the upserts are the whole workspace. Every page is its own atomic file write.
#[tauri::command]
fn pages_save(s: St, upserts: Vec<Value>, removed: Vec<String>, clear_first: bool, expected_vault_id: Option<String>, expected_pages: Option<serde_json::Map<String, Value>>, expected_all: Option<Vec<Value>>) -> Res<Vec<String>> {
    // ids of pages whose newer version on disk (changed by another program) went to the page history before ours replaced it
    let kept = with(&s, |v| {
        if let Some(id) = &expected_vault_id {
            if v.id() != *id { return Err("Document vault changed".into()); }
            v.save_pages_checked(&upserts, &removed, clear_first, expected_pages.as_ref(), expected_all.as_deref())
        } else { Err("Missing document vault precondition".into()) }
    })?;
    Ok(kept)
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
/// Brings the backup folder of the open workspace up to date inside `dir` (see `portable::export_folder`).
#[tauri::command]
fn vault_backup_folder_save(s: St, dir: String, force: Option<bool>) -> Res<portable::FolderReport> {
    let parent = PathBuf::from(dir);
    if !parent.is_absolute() { return Err("BACKUP:invalid_destination".into()); }
    with(&s, |v| {
        let parent = parent.canonicalize().map_err(err)?;
        if parent.starts_with(v.root.canonicalize().map_err(err)?) || parent.starts_with(s.app_data.canonicalize().map_err(err)?) { return Err("BACKUP:destination_inside_live_data".into()); }
        database::recover(&v.root)?;
        portable::export_folder(v, &parent, force.unwrap_or(false))
    })
}
/// A backup folder as the same data a backup file holds. Nothing is written.
#[tauri::command]
fn vault_backup_folder_read(dir: String) -> Res<Value> {
    let dir = PathBuf::from(dir);
    if !dir.is_absolute() { return Err("BACKUP:invalid_destination".into()); }
    portable::read_folder(&dir)
}
#[tauri::command]
fn vault_backup_restore(s: St, data: Value, target: Option<String>, name: Option<String>) -> Res<Value> {
    // "here": into the open workspace; anything else: a new workspace, named `name` or as the backup itself
    // "merge": the same, but a page that is newer here stays and nothing is replaced by an older version
    let merge=target.as_deref()==Some("merge");
    if merge || target.as_deref()==Some("here") {
        // a copy of the workspace as it is now goes next to it first, so a restore into it can always be undone
        let (pages,files,copy,merged)=with(&s,|v|{
            let parent=v.root.parent().ok_or("no parent directory")?;
            let safe:String=v.name().chars().filter(|c|!"<>:\"/\\|?*".contains(*c)&&!c.is_control()).collect();
            let copy=format!("{} before restore {}.json",safe.trim(),vault::now_ms());
            database::recover(&v.root)?;
            let bytes=serde_json::to_vec(&portable::export(v)?).map_err(err)?;
            vault::write_atomic(&parent.join(&copy),&bytes)?;
            let merged=if merge { Some(portable::restore_merge(v,data)?) } else { portable::restore_into(v,data)?; None };
            Ok((v.pages_all()?.len(),v.files_list().len(),copy,merged))
        })?;
        return Ok(json!({"pages":pages,"files":files,"copy":copy,"merged":merged}));
    }
    let v=with(&s,|v|portable::restore(v.root.parent().ok_or("no parent directory")?,data,name.as_deref()))?;
    let entry=Entry{id:v.id(),name:v.name(),path:v.root.to_string_lossy().into()};
    activate(&s,&entry)?;
    Ok(json!({"pages":v.pages_all()?.len(),"files":v.files_list().len()}))
}

#[tauri::command]
fn document_operation_list(s: St, scope_id: String, document_id: String, expected_vault_id: String) -> Res<Value> {
    with(&s, |v| {
        if v.id() != expected_vault_id { return Err("Document vault changed".into()); }
        document_operations::list(v, &scope_id, &document_id)
    })
}
#[tauri::command]
fn document_operation_find(s: St, scope_id: String, operation_id: String, expected_vault_id: String) -> Res<Option<Value>> {
    with(&s, |v| {
        if v.id() != expected_vault_id { return Err("Document vault changed".into()); }
        document_operations::find(v, &scope_id, &operation_id)
    })
}
#[tauri::command]
fn document_operation_commit(s: St, record: Value, expected_vault_id: String, include_status: Option<bool>, admission: Option<mcp::WriteAdmission>) -> Res<Value> {
    let receipt = with(&s, |v| {
        if v.id() != expected_vault_id { return Err("Document vault changed".into()); }
        if let Some(admission) = admission {
            let result = document_operations::commit_result_authorized(v, &record, |root, record| s.mcp.write_guard(&expected_vault_id, &admission, root, record))?;
            if include_status.unwrap_or(false) { Ok(result) } else { Ok(result["receipt"].clone()) }
        } else if include_status.unwrap_or(false) { document_operations::commit_result(v, &record) }
        else { document_operations::commit(v, &record) }
    })?;
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

/// Writes a file the person just chose in the Save As dialog. Raw body = the bytes; the percent-encoded absolute path is in `x-path`.
#[tauri::command]
fn file_save_as(request: Request) -> Res<()> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
    let path = PathBuf::from(percent_decode(&header(&request, "x-path")));
    if !path.is_absolute() || path.file_name().is_none() || path.is_dir() { return Err("not a file path".into()); }
    std::fs::write(&path, bytes).map_err(err)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn file_get(s: St, id: String) -> Res<Response> {
    with(&s, |v| v.file_get(&id)).map(Response::new)
}

/// Absolute path of the file that holds a page.
#[tauri::command]
fn page_path(s: St, id: String) -> Res<String> {
    with(&s, |v| v.page_path(&id)).map(|p| p.to_string_lossy().into_owned())
}

/// Shows a page's file in Explorer, Finder or the system file manager.
#[tauri::command]
fn page_reveal(s: St, id: String) -> Res<()> {
    let path = with(&s, |v| v.page_path(&id))?;
    // a page that has not been written yet has no file: show the folder it will live in
    let shown = if path.is_file() { path.clone() } else { path.parent().map(Path::to_path_buf).unwrap_or(path) };
    let mut command;
    #[cfg(target_os = "windows")]
    {
        command = std::process::Command::new("explorer");
        if shown.is_file() { command.arg(format!("/select,{}", shown.display())); } else { command.arg(&shown); }
    }
    #[cfg(target_os = "macos")]
    {
        command = std::process::Command::new("open");
        if shown.is_file() { command.arg("-R"); }
        command.arg(&shown);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        command = std::process::Command::new("xdg-open");
        command.arg(if shown.is_file() { shown.parent().unwrap_or(&shown) } else { &shown });
    }
    command.spawn().map(|_| ()).map_err(err)
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
    with(&s, |v| {
        if batch.get("vaultId").and_then(Value::as_str) != Some(v.id().as_str()) { return Err("Document vault changed".into()); }
        database::commit(&v.root, &batch)
    })?;
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
    // an AI client launches this same program as its MCP server: no window, just the relay
    if std::env::args().any(|a| a == mcp_relay::RELAY_FLAG) {
        std::process::exit(mcp_relay::run_stdio());
    }
    // WebView2 opens its profile when Tauri creates the first window.
    #[cfg(windows)]
    if let Some(local_data) = std::env::var_os("LOCALAPPDATA") {
        let profile = PathBuf::from(local_data).join("com.vexor.nevis");
        if let Err(error) = migrate_app_directory(&profile) {
            eprintln!("Cannot migrate the previous Nevis WebView profile: {error}");
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default())
        .setup(|app| {
            // NEVIS_APP_DATA (shared with the MCP relay) runs a separate copy with its own workspace list, e.g. to try first launch
            let app_data = match std::env::var_os("NEVIS_APP_DATA") {
                Some(dir) => PathBuf::from(dir),
                None => {
                    let current = app.path().app_data_dir()?;
                    migrate_app_directory(&current)?;
                    current
                },
            };
            std::fs::create_dir_all(&app_data)?;
            document_operations::configure(&app_data).map_err(std::io::Error::other)?;
            app.manage(Store { mcp: Arc::new(mcp::Host::default()), reg: Mutex::new(Registry::load(&app_data)), app_data, vault: Mutex::new(None), index: Mutex::new(None) });
            // reopen the vault that was open last time; if it is gone, the picker is shown
            let s = app.state::<Store>();
            let emit_handle = app.handle().clone();
            let vault_handle = app.handle().clone();
            s.mcp.set_bridge(Arc::new(move |event, payload| {
                emit_handle.get_webview_window("main").ok_or("App unavailable")?.emit(event, payload).map_err(|_| "App unavailable".into())
            }), Arc::new(move || with(&vault_handle.state::<Store>(), |v| Ok(v.id())).ok()));
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
            deck_print::print_deck, deck_print::deck_pdf_available,
            mcp_ready, mcp_status, mcp_enable, mcp_disable, mcp_autostart, mcp_setup_info, mcp_install_client, mcp_credential, mcp_reply,
            updates::updates_check, updates::updates_download, updates::updates_install,
            vault_backup_save, vault_backup_folder_save, vault_backup_folder_read, vault_backup_export, vault_backup_restore, vault_list, vault_info, vault_create, vault_add, vault_open, vault_close, vault_forget, vault_locate, vault_trash_local, vault_rename,
            db_recover, db_load_all, db_commit, db_get_operation, db_history, db_undo_load, db_undo_save, db_runtime_get, db_runtime_set, db_runtime_delete,
            db_runtime_keys, db_index_rebuild, db_index_candidates, db_index_count,
            vault_stamp, pages_search_stamp, pages_all, pages_save, document_operation_list, document_operation_find, document_operation_commit, kv_get, kv_set, versions_list, version_add, versions_delete, file_put, file_save_as, file_get, files_list, page_path, page_reveal,
            index_state, index_update, index_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nevis");
}

#[cfg(test)]
mod save_as_tests {
    use super::percent_decode;

    #[test]
    fn decodes_a_path_the_page_encoded() {
        assert_eq!(percent_decode("C%3A%5CUsers%5Cme%5Cnotes.md"), r"C:\Users\me\notes.md");
        assert_eq!(percent_decode("%D8%A7%D9%84"), "ال");
        assert_eq!(percent_decode("100%"), "100%", "a stray percent sign is kept as it is");
        assert_eq!(percent_decode("a%2"), "a%2");
    }
}
