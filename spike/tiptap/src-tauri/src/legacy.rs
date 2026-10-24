//! One-time import of the pre-Vault SQLite database (`noviq.db`, ADR-0002) into the Vault.

use crate::vault::{err, now_ms, Res, Vault};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;

fn pages(db: &Connection) -> Res<Vec<Value>> {
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

/// Returns how many pages were imported. The database file is renamed afterwards and kept as a backup.
pub fn import(app_data: &Path, vault: &Vault) -> Res<usize> {
    let path = app_data.join("noviq.db");
    if !path.exists() || vault.has_pages() {
        return Ok(0);
    }
    let all = {
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    let all = pages(&db)?;
    vault.save_pages(&all, &[], true)?;

    let mut st = db.prepare("SELECT page_id, ts, title, content FROM page_versions").map_err(err)?;
    let versions = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
        .map_err(err)?;
    for v in versions.flatten() {
        let content: Value = serde_json::from_str(&v.3).unwrap_or(Value::Null);
        let _ = vault.version_add(&json!({ "pageId": v.0, "ts": v.1, "title": v.2, "content": content }));
    }

    let mut st = db.prepare("SELECT key, value FROM kv").map_err(err)?;
    let kvs = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
    for (k, v) in kvs.flatten() {
        if k != "backupCfg" {
            if let Ok(p) = vault.kv_path(&k) {
                let _ = crate::vault::write_atomic(&p, v.as_bytes());
            }
        }
    }

    let mut st = db.prepare("SELECT id, mime, original_name, created_at FROM attachments").map_err(err)?;
    let files = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, i64>(3)?)))
        .map_err(err)?;
    for (id, mime, name, added) in files.flatten() {
        if id.len() < 8 {
            continue;
        }
        if let Ok(bytes) = std::fs::read(app_data.join("files").join(&id[..2]).join(&id)) {
            let _ = vault.file_put(&id, &bytes, &mime, &name.unwrap_or_default(), if added > 0 { added } else { now_ms() });
        }
    }
    all
    };
    let _ = std::fs::rename(&path, app_data.join("noviq.db.migrated"));
    Ok(all.len())
}
