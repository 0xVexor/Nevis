#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Storage for Noviq: one SQLite file (schema in db/migrations, see ADR-0002) plus content-addressed
//! attachment files, both under the OS app-data folder. The web UI talks to it through the commands below
//! (spike/tiptap/src/db.ts and attachments.ts); in a plain browser the same UI falls back to IndexedDB.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

const MIGRATIONS: [&str; 2] = [
    include_str!("../../../../db/migrations/0001_init.sql"),
    include_str!("../../../../db/migrations/0002_app_fields.sql"),
];
const KEEP_VERSIONS: i64 = 40;
const EMPTY_DOC: &str = r#"{"type":"doc","content":[]}"#;

struct Store {
    db: Mutex<Connection>,
    files: PathBuf,
}

type Res<T> = Result<T, String>;

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

fn open_db(dir: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(dir.join("noviq.db"))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")?;
    let current: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
        tx.commit()?;
    }
    Ok(conn)
}

fn lock<'a>(s: &'a State<Store>) -> Res<MutexGuard<'a, Connection>> {
    s.db.lock().map_err(err)
}

// ───── pages ─────

#[tauri::command]
fn pages_all(s: State<Store>) -> Res<Vec<Value>> {
    let db = lock(&s)?;
    let mut tags: HashMap<String, Vec<Value>> = HashMap::new();
    let mut st = db.prepare("SELECT page_id, tag FROM page_tags ORDER BY rowid").map_err(err)?;
    for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)? {
        let (id, tag) = r.map_err(err)?;
        tags.entry(id).or_default().push(Value::String(tag));
    }
    let mut st = db
        .prepare(
            "SELECT id, parent_id, kind, title, icon, cover, title_dir, status, is_favorite, sort_key, content, updated_at, deleted_at
             FROM pages ORDER BY id",
        )
        .map_err(err)?;
    let rows = st
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let mut p = Map::new();
            p.insert("parentId".into(), r.get::<_, Option<String>>(1)?.map_or(Value::Null, Value::String));
            let kind: String = r.get(2)?;
            if kind != "page" {
                p.insert("kind".into(), kind.into());
            }
            p.insert("title".into(), r.get::<_, String>(3)?.into());
            if let Some(v) = r.get::<_, Option<String>>(4)? {
                p.insert("icon".into(), v.into());
            }
            if let Some(v) = r.get::<_, Option<String>>(5)? {
                p.insert("cover".into(), serde_json::from_str(&v).unwrap_or(Value::Null));
            }
            if let Some(v) = r.get::<_, Option<String>>(6)? {
                p.insert("titleDir".into(), v.into());
            }
            if let Some(v) = r.get::<_, Option<String>>(7)? {
                p.insert("status".into(), v.into());
            }
            p.insert("favorite".into(), (r.get::<_, i64>(8)? != 0).into());
            p.insert("sort".into(), r.get::<_, String>(9)?.parse::<f64>().unwrap_or(0.0).into());
            p.insert("content".into(), serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or(Value::Null));
            p.insert("updatedAt".into(), r.get::<_, i64>(11)?.into());
            p.insert("deletedAt".into(), r.get::<_, Option<i64>>(12)?.map_or(Value::Null, Value::from));
            if let Some(t) = tags.remove(&id) {
                p.insert("tags".into(), Value::Array(t));
            }
            p.insert("id".into(), id.into());
            Ok(Value::Object(p))
        })
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

fn opt_str<'a>(p: &'a Value, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str)
}

fn upsert_page(tx: &Transaction, p: &Value) -> Res<()> {
    let id = opt_str(p, "id").ok_or("page without id")?;
    let kind = if opt_str(p, "kind") == Some("folder") { "folder" } else { "page" };
    let status = opt_str(p, "status").filter(|s| ["todo", "doing", "done"].contains(s));
    let dir = opt_str(p, "titleDir").filter(|s| ["rtl", "ltr"].contains(s));
    let cover = p.get("cover").filter(|c| !c.is_null()).map(Value::to_string);
    let content = p.get("content").filter(|c| !c.is_null()).map_or(EMPTY_DOC.to_string(), Value::to_string);
    let sort = p.get("sort").and_then(Value::as_f64).unwrap_or(0.0).to_string();
    let updated = p.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let deleted = p.get("deletedAt").and_then(Value::as_f64).map(|d| d as i64);
    let fav = p.get("favorite").and_then(Value::as_bool).unwrap_or(false) as i64;
    tx.execute(
        "INSERT INTO pages(id, parent_id, kind, title, icon, cover, title_dir, status, is_favorite, sort_key, content, created_at, updated_at, deleted_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13)
         ON CONFLICT(id) DO UPDATE SET parent_id=?2, kind=?3, title=?4, icon=?5, cover=?6, title_dir=?7, status=?8,
           is_favorite=?9, sort_key=?10, content=?11, updated_at=?12, deleted_at=?13",
        params![id, opt_str(p, "parentId"), kind, opt_str(p, "title").unwrap_or(""), opt_str(p, "icon"), cover, dir, status, fav, sort, content, updated, deleted],
    )
    .map_err(err)?;
    tx.execute("DELETE FROM page_tags WHERE page_id = ?", [id]).map_err(err)?;
    for t in p.get("tags").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        tx.execute("INSERT OR IGNORE INTO page_tags(page_id, tag) VALUES (?1, ?2)", params![id, t]).map_err(err)?;
    }
    Ok(())
}

/// Deletes pages without cascading into their children: a child of a deleted page moves to the top level instead of vanishing.
fn delete_pages(tx: &Transaction, ids: &[String]) -> Res<()> {
    for id in ids {
        tx.execute("UPDATE pages SET parent_id = NULL WHERE parent_id = ?", [id]).map_err(err)?;
    }
    for id in ids {
        tx.execute("DELETE FROM pages WHERE id = ?", [id]).map_err(err)?;
    }
    Ok(())
}

/// One transaction: everything is written or nothing. `clear_first` = the upserts are the whole workspace.
#[tauri::command]
fn pages_save(s: State<Store>, upserts: Vec<Value>, removed: Vec<String>, clear_first: bool) -> Res<()> {
    let mut db = lock(&s)?;
    let tx = db.transaction().map_err(err)?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON").map_err(err)?;
    for p in &upserts {
        upsert_page(&tx, p)?;
    }
    let mut gone = removed;
    if clear_first {
        let keep: HashSet<&str> = upserts.iter().filter_map(|p| opt_str(p, "id")).collect();
        let mut st = tx.prepare("SELECT id FROM pages").map_err(err)?;
        let all: Vec<String> = st.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
        drop(st);
        gone.extend(all.into_iter().filter(|id| !keep.contains(id.as_str())));
    }
    delete_pages(&tx, &gone)?;
    // a parent that no longer exists must not make the whole save fail
    tx.execute("UPDATE pages SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM pages)", [])
        .map_err(err)?;
    tx.commit().map_err(err)
}

// ───── key-value settings ─────

#[tauri::command]
fn kv_get(s: State<Store>, key: String) -> Res<Option<Value>> {
    let v: Option<String> = lock(&s)?.query_row("SELECT value FROM kv WHERE key = ?", [key], |r| r.get(0)).optional().map_err(err)?;
    Ok(v.and_then(|v| serde_json::from_str(&v).ok()))
}

#[tauri::command]
fn kv_set(s: State<Store>, key: String, value: Value) -> Res<()> {
    lock(&s)?.execute("INSERT OR REPLACE INTO kv(key, value) VALUES (?1, ?2)", params![key, value.to_string()]).map_err(err)?;
    Ok(())
}

// ───── page history ─────

#[tauri::command]
fn versions_list(s: State<Store>, page_id: String) -> Res<Vec<Value>> {
    let db = lock(&s)?;
    let mut st = db.prepare("SELECT ts, title, content FROM page_versions WHERE page_id = ? ORDER BY ts DESC").map_err(err)?;
    let rows = st
        .query_map([&page_id], |r| {
            let content: String = r.get(2)?;
            Ok(json!({ "pageId": page_id, "ts": r.get::<_, i64>(0)?, "title": r.get::<_, String>(1)?, "content": serde_json::from_str::<Value>(&content).unwrap_or(Value::Null) }))
        })
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[tauri::command]
fn version_add(s: State<Store>, version: Value) -> Res<()> {
    let page_id = opt_str(&version, "pageId").ok_or("version without pageId")?;
    let ts = version.get("ts").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let db = lock(&s)?;
    let exists = db.query_row("SELECT 1 FROM pages WHERE id = ?", [page_id], |_| Ok(true)).optional().map_err(err)?.unwrap_or(false);
    if !exists {
        return Ok(()); // the page itself is not saved yet; its first snapshot is not worth failing for
    }
    db.execute(
        "INSERT OR REPLACE INTO page_versions(page_id, ts, title, content) VALUES (?1,?2,?3,?4)",
        params![page_id, ts, opt_str(&version, "title").unwrap_or(""), version.get("content").unwrap_or(&Value::Null).to_string()],
    )
    .map_err(err)?;
    db.execute(
        "DELETE FROM page_versions WHERE page_id = ?1 AND ts NOT IN (SELECT ts FROM page_versions WHERE page_id = ?1 ORDER BY ts DESC LIMIT ?2)",
        params![page_id, KEEP_VERSIONS],
    )
    .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn versions_delete(s: State<Store>, page_id: String) -> Res<()> {
    lock(&s)?.execute("DELETE FROM page_versions WHERE page_id = ?", [page_id]).map_err(err)?;
    Ok(())
}

// ───── attachments: <data>/files/<id[0:2]>/<id>, metadata in `attachments` (id = sha256 of the bytes) ─────

fn file_path(s: &Store, id: &str) -> Res<PathBuf> {
    if id.len() < 8 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("bad file id".into());
    }
    Ok(s.files.join(&id[..2]).join(id))
}

fn header(r: &Request, k: &str) -> String {
    r.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// Raw body = file bytes; metadata in headers (the name is percent-encoded by the caller).
#[tauri::command]
fn file_put(s: State<Store>, request: Request) -> Res<()> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
    let id = header(&request, "x-file-id");
    let path = file_path(&s, &id)?;
    std::fs::create_dir_all(path.parent().ok_or("bad path")?).map_err(err)?;
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, bytes).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)?;
    let added = header(&request, "x-added-at").parse::<i64>().unwrap_or(0);
    lock(&s)?
        .execute(
            "INSERT INTO attachments(id, sha256, mime, size, original_name, created_at) VALUES (?1,?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET created_at = ?5",
            params![id, header(&request, "x-file-type"), bytes.len() as i64, header(&request, "x-file-name"), added],
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn file_get(s: State<Store>, id: String) -> Res<Response> {
    std::fs::read(file_path(&s, &id)?).map(Response::new).map_err(|_| "missing".to_string())
}

/// Metadata of every stored file (no bytes).
#[tauri::command]
fn files_list(s: State<Store>) -> Res<Vec<Value>> {
    let db = lock(&s)?;
    let mut st = db.prepare("SELECT id, mime, size, original_name, created_at FROM attachments").map_err(err)?;
    let rows = st
        .query_map([], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "type": r.get::<_, String>(1)?, "size": r.get::<_, i64>(2)?, "name": r.get::<_, Option<String>>(3)?.unwrap_or_default(), "addedAt": r.get::<_, i64>(4)? }))
        })
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[tauri::command]
fn file_delete(s: State<Store>, id: String) -> Res<()> {
    let path = file_path(&s, &id)?;
    lock(&s)?.execute("DELETE FROM attachments WHERE id = ?", [&id]).map_err(err)?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[tauri::command]
fn files_clear(s: State<Store>) -> Res<()> {
    lock(&s)?.execute("DELETE FROM attachments", []).map_err(err)?;
    let _ = std::fs::remove_dir_all(&s.files);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let files = dir.join("files");
            std::fs::create_dir_all(&files)?;
            app.manage(Store { db: Mutex::new(open_db(&dir)?), files });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pages_all, pages_save, kv_get, kv_set, versions_list, version_add, versions_delete, file_put, file_get, files_list, file_delete, files_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running Noviq");
}
