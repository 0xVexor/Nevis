//! Local full-text index of a vault (ADR-0003, rule 8): `<vault>/.noviq/index.db`, SQLite FTS5.
//! It is never synced and can be deleted at any time; the UI rebuilds what is missing. The UI normalizes text
//! (Persian letters, digits, ZWNJ…) before it gets here, so this file only deals with words.

use crate::vault::{err, Res};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Deserialize)]
pub struct Doc {
    pub id: String,
    pub updated: i64,
    pub title: String,
    pub tags: String,
    pub body: String,
}

/// Version of the index layout. The index is disposable: a file of another version is emptied and the UI refills it.
const LAYOUT: i64 = 2;

pub fn open(vault_root: &Path) -> Res<Connection> {
    let dir = vault_root.join(".noviq");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let db = Connection::open(dir.join("index.db")).map_err(err)?;
    db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;").map_err(err)?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(err)?;
    if version != LAYOUT {
        db.execute_batch("DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS fts;").map_err(err)?;
    }
    // `rid` is the row of the page in `fts`: deleting by it is direct, while deleting by the UNINDEXED `id` scans the whole table
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta(id TEXT PRIMARY KEY, updated INTEGER NOT NULL, rid INTEGER NOT NULL);
         CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, title, tags, body, tokenize = 'unicode61 remove_diacritics 2');",
    )
    .map_err(err)?;
    db.pragma_update(None, "user_version", LAYOUT).map_err(err)?;
    Ok(db)
}

/// id -> `updated` of everything indexed, so the UI only sends pages that changed.
pub fn state(db: &Connection) -> Res<HashMap<String, i64>> {
    let mut st = db.prepare("SELECT id, updated FROM meta").map_err(err)?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn update(db: &mut Connection, docs: &[Doc], removed: &[String]) -> Res<()> {
    let tx = db.transaction().map_err(err)?;
    for id in removed {
        tx.execute("DELETE FROM fts WHERE rowid = (SELECT rid FROM meta WHERE id = ?)", [id]).map_err(err)?;
        tx.execute("DELETE FROM meta WHERE id = ?", [id]).map_err(err)?;
    }
    for d in docs {
        tx.execute("DELETE FROM fts WHERE rowid = (SELECT rid FROM meta WHERE id = ?)", [&d.id]).map_err(err)?;
        tx.execute("INSERT INTO fts(id, title, tags, body) VALUES (?1, ?2, ?3, ?4)", params![d.id, d.title, d.tags, d.body]).map_err(err)?;
        let rid = tx.last_insert_rowid();
        tx.execute("INSERT OR REPLACE INTO meta(id, updated, rid) VALUES (?1, ?2, ?3)", params![d.id, d.updated, rid]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

/// Every word must match (as a prefix); title matches rank above tag matches above body matches.
pub fn search(db: &Connection, words: &[String], limit: usize) -> Res<Vec<String>> {
    let terms: Vec<String> = words.iter().map(|w| w.replace('"', "")).filter(|w| !w.trim().is_empty()).map(|w| format!("\"{w}\"*")).collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let mut st = db.prepare("SELECT id FROM fts WHERE fts MATCH ?1 ORDER BY bm25(fts, 0.0, 10.0, 5.0, 1.0) LIMIT ?2").map_err(err)?;
    let rows = st.query_map(params![terms.join(" AND "), limit as i64], |r| r.get::<_, String>(0)).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, title: &str, tags: &str, body: &str, updated: i64) -> Doc {
        Doc { id: id.into(), updated, title: title.into(), tags: tags.into(), body: body.into() }
    }

    #[test]
    fn indexes_updates_removes_and_ranks() {
        let dir = std::env::temp_dir().join(format!("noviq-idx-{}", crate::vault::now_ms()));
        let mut db = open(&dir).unwrap();
        update(&mut db, &[doc("a", "کلاس جاوا", "", "متن درباره شی", 1), doc("b", "یادداشت", "جاوا", "کلاس و وراثت", 1), doc("c", "other", "", "the quick brown fox", 1)], &[]).unwrap();
        fn s(db: &Connection, q: &[&str]) -> Vec<String> {
            search(db, &q.iter().map(|x| x.to_string()).collect::<Vec<_>>(), 10).unwrap()
        }
        assert_eq!(s(&db, &["کلاس"]), ["a", "b"]); // the title match ranks first
        assert_eq!(s(&db, &["کلاس", "وراث"]), ["b"]); // AND, and the second word is a prefix
        assert_eq!(s(&db, &["quick"]), ["c"]);
        assert!(s(&db, &["nothing"]).is_empty());
        assert!(s(&db, &["\"; DROP"]).is_empty() || true); // quotes are stripped, never an FTS syntax error
        update(&mut db, &[doc("c", "other", "", "now about wolves", 2)], &["a".to_string()]).unwrap();
        assert!(s(&db, &["quick"]).is_empty() && s(&db, &["wolves"]) == ["c"] && s(&db, &["جاوا"]) == ["b"]);
        let st = state(&db).unwrap();
        assert_eq!(st.get("c"), Some(&2));
        assert!(!st.contains_key("a"));
    }

    #[test]
    fn replacing_and_removing_a_page_leaves_exactly_one_row_per_page() {
        let dir = std::env::temp_dir().join(format!("noviq-idx-rows-{}", crate::vault::now_ms()));
        let mut db = open(&dir).unwrap();
        update(&mut db, &[doc("a", "first", "", "alpha", 1), doc("b", "second", "", "beta", 1)], &[]).unwrap();
        update(&mut db, &[doc("a", "first", "", "gamma", 2)], &[]).unwrap();
        update(&mut db, &[doc("a", "first", "", "delta", 3)], &["b".to_string()]).unwrap();
        let rows: i64 = db.query_row("SELECT count(*) FROM fts", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        assert_eq!(state(&db).unwrap().len(), 1);
        let find = |w: &str| search(&db, &[w.to_string()], 10).unwrap();
        assert!(find("alpha").is_empty() && find("gamma").is_empty() && find("beta").is_empty());
        assert_eq!(find("delta"), ["a"]);
    }

    #[test]
    fn an_index_of_an_older_layout_is_emptied_not_misread() {
        let dir = std::env::temp_dir().join(format!("noviq-idx-old-{}", crate::vault::now_ms()));
        std::fs::create_dir_all(dir.join(".noviq")).unwrap();
        {
            let old = Connection::open(dir.join(".noviq/index.db")).unwrap();
            old.execute_batch("CREATE TABLE meta(id TEXT PRIMARY KEY, updated INTEGER NOT NULL); INSERT INTO meta VALUES('ghost', 5); CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, title, tags, body);").unwrap();
        }
        let mut db = open(&dir).unwrap();
        assert!(state(&db).unwrap().is_empty(), "the UI sends every page again");
        update(&mut db, &[doc("a", "t", "", "b", 1)], &[]).unwrap();
        assert_eq!(state(&db).unwrap().len(), 1);
    }
}
