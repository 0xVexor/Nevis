//! The disposable query index (handoff §12.2): `<vault>/.noviq/index.db` tables `db_*`. Everything here is derived from the
//! canonical files and can be dropped and rebuilt at any time; the index schema version is separate from the Vault format.
//! Numbers, dates, text and booleans are indexed in separate typed columns, so a number is never compared as a string.

use super::{load_all, KINDS};
use crate::vault::{err, Res};
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

pub const INDEX_VERSION: i64 = 1;

const DDL: &str = "
CREATE TABLE IF NOT EXISTS db_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS db_record_state (
  vault_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL, hash TEXT NOT NULL, deleted INTEGER NOT NULL,
  PRIMARY KEY(vault_id,kind,id)
);
CREATE TABLE IF NOT EXISTS db_items (
  vault_id TEXT NOT NULL, source_id TEXT NOT NULL, page_id TEXT NOT NULL,
  row_revision INTEGER NOT NULL, sort_key TEXT NOT NULL, parent_item_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(vault_id,page_id)
);
CREATE INDEX IF NOT EXISTS db_items_source ON db_items(vault_id,source_id,deleted,sort_key,page_id);
CREATE TABLE IF NOT EXISTS db_values_scalar (
  vault_id TEXT NOT NULL, source_id TEXT NOT NULL, property_id TEXT NOT NULL,
  page_id TEXT NOT NULL, value_kind TEXT NOT NULL, is_empty INTEGER NOT NULL,
  number_value REAL, text_key TEXT, date_key TEXT, end_date_key TEXT,
  boolean_value INTEGER, result_state TEXT NOT NULL DEFAULT 'ready',
  PRIMARY KEY(vault_id,property_id,page_id)
);
CREATE INDEX IF NOT EXISTS db_values_num ON db_values_scalar(vault_id,source_id,property_id,number_value,page_id);
CREATE INDEX IF NOT EXISTS db_values_text ON db_values_scalar(vault_id,source_id,property_id,text_key,page_id);
CREATE INDEX IF NOT EXISTS db_values_date ON db_values_scalar(vault_id,source_id,property_id,date_key,page_id);
CREATE TABLE IF NOT EXISTS db_values_members (
  vault_id TEXT NOT NULL, source_id TEXT NOT NULL, property_id TEXT NOT NULL,
  page_id TEXT NOT NULL, member_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(vault_id,property_id,page_id,member_id)
);
CREATE INDEX IF NOT EXISTS db_members_reverse ON db_values_members(vault_id,source_id,property_id,member_id,page_id);
CREATE TABLE IF NOT EXISTS db_relation_edges (
  vault_id TEXT NOT NULL, id TEXT NOT NULL, definition_id TEXT NOT NULL,
  from_page_id TEXT NOT NULL, to_page_id TEXT NOT NULL, sort_key TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(vault_id,id)
);
CREATE INDEX IF NOT EXISTS db_edges_from ON db_relation_edges(vault_id,definition_id,from_page_id,deleted);
CREATE INDEX IF NOT EXISTS db_edges_to ON db_relation_edges(vault_id,definition_id,to_page_id,deleted);
CREATE TABLE IF NOT EXISTS db_sources (vault_id TEXT NOT NULL, id TEXT NOT NULL, title_property_id TEXT NOT NULL, schema_revision INTEGER NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(vault_id,id));
CREATE TABLE IF NOT EXISTS db_properties (vault_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(vault_id,id));
CREATE TABLE IF NOT EXISTS db_views (vault_id TEXT NOT NULL, id TEXT NOT NULL, container_id TEXT NOT NULL, source_id TEXT, type TEXT NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(vault_id,id));
";

pub fn ensure_schema(db: &Connection) -> Res<()> {
    db.execute_batch(DDL).map_err(err)?;
    let have: Option<i64> = db.query_row("SELECT value FROM db_index_meta WHERE key='version'", [], |r| r.get::<_, String>(0)).ok().and_then(|s| s.parse().ok());
    if have != Some(INDEX_VERSION) {
        // an index of another version is dropped and rebuilt by the caller, never migrated
        for t in ["db_record_state", "db_items", "db_values_scalar", "db_values_members", "db_relation_edges", "db_sources", "db_properties", "db_views"] {
            db.execute(&format!("DELETE FROM {t}"), []).map_err(err)?;
        }
        db.execute("INSERT OR REPLACE INTO db_index_meta(key,value) VALUES('version',?1)", [INDEX_VERSION.to_string()]).map_err(err)?;
        db.execute("INSERT OR REPLACE INTO db_index_meta(key,value) VALUES('needs_rebuild','1')", []).map_err(err)?;
    }
    Ok(())
}

pub fn needs_rebuild(db: &Connection) -> bool {
    db.query_row("SELECT value FROM db_index_meta WHERE key='needs_rebuild'", [], |r| r.get::<_, String>(0)).map(|v| v == "1").unwrap_or(true)
}

/// Same normalization the UI uses for search keys (Persian letters, digits, ZWNJ, harakat), so keys compare across adapters.
pub fn norm(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            'ي' | 'ى' => Some('ی'),
            'ك' => Some('ک'),
            '\u{200c}' | '\u{200d}' | '\u{200e}' | '\u{200f}' => Some(' '),
            '٠'..='٩' => Some(char::from(b'0' + (c as u32 - '٠' as u32) as u8)), // Arabic-Indic digits sit inside the harakat range: match them first
            '\u{064b}'..='\u{065f}' | '\u{0670}' | '\u{0640}' => None,
            '۰'..='۹' => Some(char::from(b'0' + (c as u32 - '۰' as u32) as u8)),
            _ => Some(c),
        })
        .collect::<String>()
        .to_lowercase()
}

fn hash16(v: &Value) -> String {
    let mut h = Sha256::new();
    h.update(v.to_string().as_bytes());
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn vault_id(root: &Path) -> String {
    fs::read(root.join(".noviq/vault.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.get("id").and_then(Value::as_str).map(String::from)).unwrap_or_default()
}

fn index_page(tx: &rusqlite::Transaction, vault: &str, page: &Value, title_prop: Option<&str>) -> Res<()> {
    let Some(ext) = page.get("database").filter(|d| d.is_object()) else { return Ok(()) };
    let id = page["id"].as_str().unwrap_or_default();
    let src = ext["sourceId"].as_str().unwrap_or_default();
    let deleted = page.get("deletedAt").map_or(0, |d| i64::from(!d.is_null()));
    tx.execute(
        "INSERT OR REPLACE INTO db_items(vault_id,source_id,page_id,row_revision,sort_key,parent_item_id,deleted) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![vault, src, id, ext.get("revision").and_then(Value::as_i64).unwrap_or(0), ext["sortKey"].as_str().unwrap_or_default(), ext.get("parentItemId").and_then(Value::as_str), deleted],
    )
    .map_err(err)?;
    let scalar = |prop: &str, kind: &str, empty: bool, num: Option<f64>, text: Option<String>, d1: Option<String>, d2: Option<String>, b: Option<bool>| -> Res<()> {
        tx.execute(
            "INSERT OR REPLACE INTO db_values_scalar(vault_id,source_id,property_id,page_id,value_kind,is_empty,number_value,text_key,date_key,end_date_key,boolean_value,result_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'ready')",
            params![vault, src, prop, id, kind, i64::from(empty), num, text, d1, d2, b.map(i64::from)],
        )
        .map_err(err)?;
        Ok(())
    };
    if let Some(tp) = title_prop {
        let t = page.get("title").and_then(Value::as_str).unwrap_or_default();
        scalar(tp, "title", t.is_empty(), None, Some(norm(t)), None, None, None)?;
    }
    let members = |prop: &str, ids: Vec<&str>| -> Res<()> {
        for (i, m) in ids.iter().enumerate() {
            tx.execute("INSERT OR REPLACE INTO db_values_members(vault_id,source_id,property_id,page_id,member_id,position) VALUES(?1,?2,?3,?4,?5,?6)", params![vault, src, prop, id, m, i as i64]).map_err(err)?;
        }
        Ok(())
    };
    for (prop, c) in ext.get("cells").and_then(Value::as_object).into_iter().flatten() {
        let v = &c["value"];
        let strs = |k: &str| v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
        match v["kind"].as_str().unwrap_or_default() {
            "text" => {
                let t: String = v["runs"].as_array().map(|r| r.iter().filter_map(|x| x["text"].as_str()).collect()).unwrap_or_default();
                scalar(prop, "text", t.is_empty(), None, Some(norm(&t)), None, None, None)?;
            }
            "number" => scalar(prop, "number", v["value"].is_null(), v["value"].as_f64(), None, None, None, None)?,
            "checkbox" => scalar(prop, "checkbox", false, None, None, None, None, v["value"].as_bool())?,
            "select" | "status" => {
                let o = v["optionId"].as_str();
                scalar(prop, "select", o.is_none(), None, None, None, None, None)?;
                if let Some(o) = o { members(prop, vec![o])? }
            }
            "multi_select" => { let ids = strs("optionIds"); scalar(prop, "members", ids.is_empty(), None, None, None, None, None)?; members(prop, ids)? }
            "people" => { let ids = strs("principalIds"); scalar(prop, "members", ids.is_empty(), None, None, None, None, None)?; members(prop, ids)? }
            "files" => { let ids = strs("attachmentIds"); scalar(prop, "members", ids.is_empty(), None, None, None, None, None)?; members(prop, ids)? }
            "date" => {
                if let Some(d) = v["value"].as_object() {
                    let key = |s: Option<&str>| s.map(|s| format!("{}{}", if d["kind"] == "date" { "c:" } else { "i:" }, s));
                    scalar(prop, "date", false, None, None, key(d["start"].as_str()), key(d.get("end").and_then(Value::as_str).or(d["start"].as_str())), None)?
                } else { scalar(prop, "date", true, None, None, None, None, None)? }
            }
            "url" | "email" | "phone" => { let t = v["value"].as_str().unwrap_or_default(); scalar(prop, "text", t.is_empty(), None, Some(norm(t)), None, None, None)? }
            "place" => { let t = format!("{} {}", v["value"]["name"].as_str().unwrap_or_default(), v["value"]["address"].as_str().unwrap_or_default()); scalar(prop, "text", v["value"].is_null(), None, Some(norm(t.trim())), None, None, None)? }
            _ => {}
        }
    }
    Ok(())
}

fn clear_page(tx: &rusqlite::Transaction, vault: &str, page_id: &str) -> Res<()> {
    for t in ["db_items", "db_values_scalar", "db_values_members"] {
        tx.execute(&format!("DELETE FROM {t} WHERE vault_id=?1 AND page_id=?2"), params![vault, page_id]).map_err(err)?;
    }
    Ok(())
}

fn index_record(tx: &rusqlite::Transaction, vault: &str, kind: &str, r: &Value) -> Res<()> {
    let id = r["id"].as_str().unwrap_or_default();
    let deleted = i64::from(!r.get("deletedAt").map_or(true, Value::is_null));
    tx.execute("INSERT OR REPLACE INTO db_record_state(vault_id,kind,id,revision,hash,deleted) VALUES(?1,?2,?3,?4,?5,?6)", params![vault, kind, id, r.get("revision").and_then(Value::as_i64).unwrap_or(0), hash16(r), deleted]).map_err(err)?;
    match kind {
        "edge" => { tx.execute("INSERT OR REPLACE INTO db_relation_edges(vault_id,id,definition_id,from_page_id,to_page_id,sort_key,deleted) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![vault, id, r["definitionId"].as_str().unwrap_or_default(), r["fromPageId"].as_str().unwrap_or_default(), r["toPageId"].as_str().unwrap_or_default(), r["sortKey"].as_str().unwrap_or_default(), deleted]).map_err(err)?; }
        "source" => { tx.execute("INSERT OR REPLACE INTO db_sources(vault_id,id,title_property_id,schema_revision,deleted) VALUES(?1,?2,?3,?4,?5)", params![vault, id, r["titlePropertyId"].as_str().unwrap_or_default(), r.get("schemaRevision").and_then(Value::as_i64).unwrap_or(0), deleted]).map_err(err)?; }
        "property" => { tx.execute("INSERT OR REPLACE INTO db_properties(vault_id,id,source_id,kind,name,deleted) VALUES(?1,?2,?3,?4,?5,?6)", params![vault, id, r["sourceId"].as_str().unwrap_or_default(), r["kind"].as_str().unwrap_or_default(), r["name"].as_str().unwrap_or_default(), deleted]).map_err(err)?; }
        "view" => { tx.execute("INSERT OR REPLACE INTO db_views(vault_id,id,container_id,source_id,type,deleted) VALUES(?1,?2,?3,?4,?5,?6)", params![vault, id, r["containerId"].as_str().unwrap_or_default(), r.get("sourceId").and_then(Value::as_str), r["type"].as_str().unwrap_or_default(), deleted]).map_err(err)?; }
        _ => {}
    }
    Ok(())
}

fn title_prop_of(db: &rusqlite::Transaction, vault: &str, source: &str) -> Option<String> {
    db.query_row("SELECT title_property_id FROM db_sources WHERE vault_id=?1 AND id=?2", params![vault, source], |r| r.get(0)).ok()
}

/// Drop everything and read it again from the canonical files.
pub fn rebuild(db: &mut Connection, root: &Path) -> Res<usize> {
    let vault = vault_id(root);
    let tx = db.transaction().map_err(err)?;
    for t in ["db_record_state", "db_items", "db_values_scalar", "db_values_members", "db_relation_edges", "db_sources", "db_properties", "db_views"] {
        tx.execute(&format!("DELETE FROM {t}"), []).map_err(err)?;
    }
    let all = load_all(root)?;
    let mut n = 0;
    for (kind, _) in KINDS {
        for r in all["records"][kind].as_array().into_iter().flatten() {
            index_record(&tx, &vault, kind, r)?;
            n += 1;
        }
    }
    for e in fs::read_dir(root.join("pages")).into_iter().flatten().flatten() {
        if let Some(v) = fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            if let Some(ext) = v.get("database").filter(|d| d.is_object()) {
                let tp = title_prop_of(&tx, &vault, ext["sourceId"].as_str().unwrap_or_default());
                let mut page = v.clone();
                if let Some(stem) = e.path().file_stem().and_then(|s| s.to_str()) { page["id"] = Value::String(stem.to_string()); }
                index_page(&tx, &vault, &page, tp.as_deref())?;
                n += 1;
            }
        }
    }
    tx.execute("INSERT OR REPLACE INTO db_index_meta(key,value) VALUES('needs_rebuild','0')", []).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(n)
}

/// Incremental update for one committed batch (same transaction, so the index is never ahead of or behind a single batch).
pub fn apply_batch(db: &mut Connection, root: &Path, batch: &Value) -> Res<()> {
    let vault = vault_id(root);
    let tx = db.transaction().map_err(err)?;
    for w in batch.get("records").and_then(Value::as_array).into_iter().flatten() {
        let kind = w["kind"].as_str().unwrap_or_default();
        match w.get("after").filter(|a| !a.is_null()) {
            Some(after) => index_record(&tx, &vault, kind, after)?,
            None => { tx.execute("DELETE FROM db_record_state WHERE vault_id=?1 AND kind=?2 AND id=?3", params![vault, kind, w["id"].as_str().unwrap_or_default()]).map_err(err)?; }
        }
    }
    for w in batch.get("pages").and_then(Value::as_array).into_iter().flatten() {
        let id = w["id"].as_str().unwrap_or_default();
        clear_page(&tx, &vault, id)?;
        if let Some(after) = w.get("after").filter(|a| !a.is_null()) {
            let tp = after.get("database").and_then(|d| d["sourceId"].as_str()).and_then(|s| title_prop_of(&tx, &vault, s));
            index_page(&tx, &vault, after, tp.as_deref())?;
        }
    }
    tx.commit().map_err(err)
}

/// Indexed candidate filtering for simple predicates. The caller still applies the full engine to the candidates (residual filter).
pub fn candidates(db: &Connection, root: &Path, source: &str, property: &str, op: &str, operand: &Value) -> Res<Vec<String>> {
    let vault = vault_id(root);
    let live = "i.deleted=0";
    let (sql, p): (String, Vec<rusqlite::types::Value>) = match (op, operand) {
        ("is_empty", _) => (format!("SELECT i.page_id FROM db_items i LEFT JOIN db_values_scalar v ON v.vault_id=i.vault_id AND v.page_id=i.page_id AND v.property_id=?3 WHERE i.vault_id=?1 AND i.source_id=?2 AND {live} AND (v.page_id IS NULL OR v.is_empty=1) ORDER BY i.sort_key,i.page_id"), vec![]),
        ("equals" | "gt" | "gte" | "lt" | "lte", Value::Number(n)) => {
            let cmp = match op { "equals" => "=", "gt" => ">", "gte" => ">=", "lt" => "<", _ => "<=" };
            (format!("SELECT i.page_id FROM db_items i JOIN db_values_scalar v ON v.vault_id=i.vault_id AND v.page_id=i.page_id AND v.property_id=?3 WHERE i.vault_id=?1 AND i.source_id=?2 AND {live} AND v.number_value {cmp} ?4 ORDER BY i.sort_key,i.page_id"), vec![n.as_f64().unwrap_or(0.0).into()])
        }
        ("equals", Value::Bool(b)) => (format!("SELECT i.page_id FROM db_items i JOIN db_values_scalar v ON v.vault_id=i.vault_id AND v.page_id=i.page_id AND v.property_id=?3 WHERE i.vault_id=?1 AND i.source_id=?2 AND {live} AND v.boolean_value=?4 ORDER BY i.sort_key,i.page_id"), vec![i64::from(*b).into()]),
        ("equals", Value::String(s)) => (format!("SELECT i.page_id FROM db_items i JOIN db_values_scalar v ON v.vault_id=i.vault_id AND v.page_id=i.page_id AND v.property_id=?3 WHERE i.vault_id=?1 AND i.source_id=?2 AND {live} AND v.text_key=?4 ORDER BY i.sort_key,i.page_id"), vec![norm(s).into()]),
        ("starts_with", Value::String(s)) => (format!("SELECT i.page_id FROM db_items i JOIN db_values_scalar v ON v.vault_id=i.vault_id AND v.page_id=i.page_id AND v.property_id=?3 WHERE i.vault_id=?1 AND i.source_id=?2 AND {live} AND substr(v.text_key,1,length(?4))=?4 ORDER BY i.sort_key,i.page_id"), vec![norm(s).into()]),
        ("contains", Value::String(m)) => (format!("SELECT DISTINCT i.page_id FROM db_items i JOIN db_values_members m ON m.vault_id=i.vault_id AND m.page_id=i.page_id AND m.property_id=?3 WHERE i.vault_id=?1 AND i.source_id=?2 AND {live} AND m.member_id=?4 ORDER BY i.sort_key,i.page_id"), vec![m.clone().into()]),
        _ => return Err(format!("INVALID_FILTER:operator {op} cannot be answered from the index")),
    };
    let mut st = db.prepare(&sql).map_err(err)?;
    let mut args: Vec<rusqlite::types::Value> = vec![vault.into(), source.to_string().into(), property.to_string().into()];
    args.extend(p);
    let rows = st.query_map(rusqlite::params_from_iter(args.iter()), |r| r.get::<_, String>(0)).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn count_items(db: &Connection, root: &Path, source: &str) -> Res<i64> {
    db.query_row("SELECT COUNT(*) FROM db_items WHERE vault_id=?1 AND source_id=?2 AND deleted=0", params![vault_id(root), source], |r| r.get(0)).map_err(err)
}
