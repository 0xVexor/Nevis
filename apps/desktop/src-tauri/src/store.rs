//! The SQLite store of one workspace (ADR-0001 §3, §7).
//!
//! The TypeScript core runs an interactive transaction (reads and conditional writes interleaved). Over IPC that becomes ONE
//! `commit(batch)`: the adapter on the JS side reads committed state (`read`), keeps its own writes in an overlay, and sends the
//! list of writes at the end. Each conditional write carries the result JS ASSUMED (`wrote`, `inserted`, `k`, `ok`); this side
//! recomputes it against the real rows and rolls the whole transaction back on any difference. JS must be the only writer.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const STORE_VERSION: &str = "1";

#[derive(Debug)]
pub enum StoreError {
    Sql(rusqlite::Error),
    /// JS assumed a result the real rows do not give: the overlay and the database drifted apart.
    Drift(String),
    Bad(String),
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sql(e) => write!(f, "sql: {e}"),
            StoreError::Drift(m) => write!(f, "drift: {m}"),
            StoreError::Bad(m) => write!(f, "bad request: {m}"),
        }
    }
}
impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self { StoreError::Sql(e) }
}
type Res<T> = Result<T, StoreError>;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct EventRow { pub id: String, pub ent: String, pub kind: String, pub hlc: String, pub body: String }

/// One write of a transaction. Bytes are base64 (the IPC body is JSON).
#[derive(Deserialize, Debug)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    SetMeta { k: String, v: String },
    PutField { ent: String, f: String, val: String, hlc: String, wrote: bool },
    RekeyField { ent: String, f: String, from: String, to: String, ok: bool },
    PutEvent { ev: EventRow, inserted: bool },
    RekeyEvent { id: String, to: String, ok: bool },
    PutDocState { doc: String, state: String, max_sv: i64 },
    BumpMaxSv { doc: String, sv: i64 },
    AppendDocUpdate { doc: String, upd: String, k: i64 },
    DeleteDocUpdates { doc: String, through: i64 },
    AddOutbox { op: String, env: String, created: i64, #[serde(default)] blobs: Option<Vec<String>> },
    DeleteOutbox { ops: Vec<String> },
    PutInbox { seq: i64, env: String, inserted: bool },
    DeleteInbox { seqs: Vec<i64> },
    AddQuarantine { seq: i64, env: String, reason: String },
    /// M13: forget everything about one entity (registers, events, document, updates)
    PurgeEntity { ent: String },
}

/// A read of COMMITTED state. Typed: there is no way to send SQL.
#[derive(Deserialize, Debug)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Read {
    GetMeta { k: String },
    GetField { ent: String, f: String },
    EntityFields { ent: String },
    AllFields,
    Entities,
    GetEvent { id: String },
    AllEvents,
    GetDocState { doc: String },
    DocSeq { doc: String },
    ListDocUpdates { doc: String },
    Docs,
    ListOutbox { limit: i64 },
    HasInbox { seq: i64 },
    ListInbox { after: i64, limit: i64 },
    ListQuarantine,
}

pub struct Store { conn: Connection }

impl Store {
    pub fn open(path: &std::path::Path) -> Res<Store> {
        let conn = Connection::open(path)?;
        // WAL + synchronous=NORMAL: a committed transaction survives a process kill (the -wal file is on disk); only a power cut
        // may lose the last few commits, which the server log can restore (ADR-0001 §8). FULL would fsync every 300 ms write.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }
    pub fn open_memory() -> Res<Store> { Self::init(Connection::open_in_memory()?) }

    fn init(conn: Connection) -> Res<Store> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS field (ent TEXT NOT NULL, f TEXT NOT NULL, val TEXT NOT NULL, hlc TEXT NOT NULL, PRIMARY KEY (ent, f)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS event (id TEXT PRIMARY KEY, ent TEXT NOT NULL, kind TEXT NOT NULL, hlc TEXT NOT NULL, body TEXT NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS doc_state (doc TEXT PRIMARY KEY, state BLOB, max_sv INTEGER NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS doc_seq (doc TEXT PRIMARY KEY, k INTEGER NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS doc_update (doc TEXT NOT NULL, k INTEGER NOT NULL, upd BLOB NOT NULL, PRIMARY KEY (doc, k)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL UNIQUE, env TEXT NOT NULL, created INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY, env TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS blob (hash TEXT PRIMARY KEY, n INTEGER NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, remote INTEGER NOT NULL, failed TEXT NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS quarantine (seq INTEGER PRIMARY KEY, env TEXT NOT NULL, reason TEXT NOT NULL);",
        )?;
        let s = Store { conn };
        // M9: the attachments an outbox row waits for (the gate). A database made before M9 has no such column.
        let has_blobs: bool = s.conn.prepare("PRAGMA table_info(outbox)")?.query_map([], |r| r.get::<_, String>(1))?.filter_map(|r| r.ok()).any(|c| c == "blobs");
        if !has_blobs { s.conn.execute("ALTER TABLE outbox ADD COLUMN blobs TEXT", [])?; }
        if s.meta("storeVersion")?.is_none() {
            s.conn.execute("INSERT INTO meta (k, v) VALUES ('storeVersion', ?1)", [STORE_VERSION])?;
        }
        Ok(s)
    }

    fn meta(&self, k: &str) -> Res<Option<String>> {
        Ok(self.conn.query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0)).optional()?)
    }

    // ---- attachments: the rows (the bytes are files, see blobs.rs) ----
    fn blob_json(r: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
        Ok(serde_json::json!({ "hash": r.get::<_, String>(0)?, "size": r.get::<_, i64>(1)?, "mime": r.get::<_, String>(2)?, "remote": r.get::<_, i64>(3)? != 0, "failed": r.get::<_, String>(4)? }))
    }
    pub fn blob_meta(&self, hash: &str) -> Res<Option<serde_json::Value>> {
        Ok(self.conn.query_row("SELECT hash, size, mime, remote, failed FROM blob WHERE hash = ?1", [hash], Self::blob_json).optional()?)
    }
    /// Inserts the row of a stored file, or (when there is one) only raises `remote`. Returns the row.
    pub fn blob_insert(&mut self, hash: &str, size: i64, mime: &str, remote: bool) -> Res<serde_json::Value> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let have: Option<i64> = tx.query_row("SELECT remote FROM blob WHERE hash = ?1", [hash], |r| r.get(0)).optional()?;
        match have {
            Some(r) => { if remote && r == 0 { tx.execute("UPDATE blob SET remote = 1 WHERE hash = ?1", [hash])?; } }
            None => { tx.execute("INSERT INTO blob (hash, n, size, mime, remote, failed) VALUES (?1, (SELECT COALESCE(MAX(n), 0) + 1 FROM blob), ?2, ?3, ?4, '')", params![hash, size, mime, remote as i64])?; }
        }
        let row = tx.query_row("SELECT hash, size, mime, remote, failed FROM blob WHERE hash = ?1", [hash], Self::blob_json)?;
        tx.commit()?;
        Ok(row)
    }
    pub fn blob_set(&self, hash: &str, remote: Option<bool>, failed: Option<&str>) -> Res<()> {
        if let Some(r) = remote { self.conn.execute("UPDATE blob SET remote = ?2 WHERE hash = ?1", params![hash, r as i64])?; }
        if let Some(f) = failed { self.conn.execute("UPDATE blob SET failed = ?2 WHERE hash = ?1", params![hash, f])?; }
        Ok(())
    }
    pub fn blob_list(&self, pending_only: bool) -> Res<Vec<serde_json::Value>> {
        let sql = if pending_only { "SELECT hash, size, mime, remote, failed FROM blob WHERE remote = 0 AND failed = '' ORDER BY n" } else { "SELECT hash, size, mime, remote, failed FROM blob ORDER BY n" };
        let mut st = self.conn.prepare(sql)?;
        let rows = st.query_map([], Self::blob_json)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn blob_remove(&self, hash: &str) -> Res<()> { self.conn.execute("DELETE FROM blob WHERE hash = ?1", [hash])?; Ok(()) }

    fn blob(s: &str) -> Res<Vec<u8>> { B64.decode(s).map_err(|e| StoreError::Bad(format!("base64: {e}"))) }

    /// Applies the whole batch in ONE SQLite transaction, or none of it.
    pub fn commit(&mut self, ops: &[Op]) -> Res<()> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for op in ops { apply(&tx, op)?; }
        tx.commit()?;
        Ok(())
    }

    pub fn read(&self, r: &Read) -> Res<serde_json::Value> {
        use serde_json::{json, Value};
        let c = &self.conn;
        Ok(match r {
            Read::GetMeta { k } => json!(self.meta(k)?),
            Read::GetField { ent, f } => match c.query_row("SELECT val, hlc FROM field WHERE ent = ?1 AND f = ?2", [ent, f], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()? {
                Some((val, hlc)) => json!({ "val": val, "hlc": hlc }),
                None => Value::Null,
            },
            Read::EntityFields { ent } => {
                arr(c, "SELECT f, val, hlc FROM field WHERE ent = ?1", [ent], |r| Ok(json!({ "f": r.get::<_, String>(0)?, "val": r.get::<_, String>(1)?, "hlc": r.get::<_, String>(2)? })))?
            }
            Read::AllFields => {
                arr(c, "SELECT ent, f, val, hlc FROM field", [], |r| Ok(json!([r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?])))?
            }
            Read::Entities => {
                arr(c, "SELECT DISTINCT ent FROM field ORDER BY ent", [], |r| Ok(json!(r.get::<_, String>(0)?)))?
            }
            Read::GetEvent { id } => match c.query_row("SELECT id, ent, kind, hlc, body FROM event WHERE id = ?1", [id], event_row).optional()? {
                Some(e) => json!(e),
                None => Value::Null,
            },
            Read::AllEvents => {
                arr(c, "SELECT id, ent, kind, hlc, body FROM event ORDER BY id", [], |r| Ok(json!(event_row(r)?)))?
            }
            Read::GetDocState { doc } => match c.query_row("SELECT state, max_sv FROM doc_state WHERE doc = ?1", [doc], |r| Ok((r.get::<_, Option<Vec<u8>>>(0)?, r.get::<_, i64>(1)?))).optional()? {
                Some((state, max_sv)) => json!({ "state": state.map(|b| B64.encode(b)), "maxSv": max_sv }),
                None => Value::Null,
            },
            Read::DocSeq { doc } => json!(c.query_row("SELECT k FROM doc_seq WHERE doc = ?1", [doc], |r| r.get::<_, i64>(0)).optional()?.unwrap_or(0)),
            Read::ListDocUpdates { doc } => {
                arr(c, "SELECT k, upd FROM doc_update WHERE doc = ?1 ORDER BY k", [doc], |r| Ok(json!({ "k": r.get::<_, i64>(0)?, "upd": B64.encode(r.get::<_, Vec<u8>>(1)?) })))?
            }
            Read::Docs => {
                arr(c, "SELECT doc FROM doc_state UNION SELECT doc FROM doc_seq", [], |r| Ok(json!(r.get::<_, String>(0)?)))?
            }
            Read::ListOutbox { limit } => {
                arr(c, "SELECT op, env, created, blobs FROM outbox ORDER BY id LIMIT ?1", [limit], |r| {
                    let mut row = json!({ "op": r.get::<_, String>(0)?, "env": r.get::<_, String>(1)?, "created": r.get::<_, i64>(2)? });
                    if let Some(b) = r.get::<_, Option<String>>(3)? { if let Ok(v) = serde_json::from_str::<Value>(&b) { row["blobs"] = v; } }
                    Ok(row)
                })?
            }
            Read::HasInbox { seq } => json!(c.query_row("SELECT 1 FROM inbox WHERE seq = ?1", [seq], |_| Ok(())).optional()?.is_some()),
            Read::ListInbox { after, limit } => {
                arr(c, "SELECT seq, env FROM inbox WHERE seq > ?1 ORDER BY seq LIMIT ?2", params![after, limit], |r| Ok(json!({ "seq": r.get::<_, i64>(0)?, "env": r.get::<_, String>(1)? })))?
            }
            Read::ListQuarantine => {
                arr(c, "SELECT seq, env, reason FROM quarantine ORDER BY seq", [], |r| Ok(json!({ "seq": r.get::<_, i64>(0)?, "env": r.get::<_, String>(1)?, "reason": r.get::<_, String>(2)? })))?
            }
        })
    }
}

fn arr<P: rusqlite::Params>(c: &Connection, sql: &str, p: P, f: impl FnMut(&rusqlite::Row) -> rusqlite::Result<serde_json::Value>) -> Res<serde_json::Value> {
    let mut st = c.prepare(sql)?;
    let v: Vec<serde_json::Value> = st.query_map(p, f)?.collect::<Result<_, _>>()?;
    Ok(serde_json::Value::Array(v))
}

fn event_row(r: &rusqlite::Row) -> rusqlite::Result<EventRow> {
    Ok(EventRow { id: r.get(0)?, ent: r.get(1)?, kind: r.get(2)?, hlc: r.get(3)?, body: r.get(4)? })
}

fn drift<T: std::fmt::Debug>(what: &str, assumed: T, actual: T) -> StoreError {
    StoreError::Drift(format!("{what}: the adapter assumed {assumed:?}, the database gives {actual:?}"))
}

fn apply(tx: &rusqlite::Transaction, op: &Op) -> Res<()> {
    match op {
        Op::SetMeta { k, v } => { tx.execute("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v])?; }
        Op::PutField { ent, f, val, hlc, wrote } => {
            let cur: Option<String> = tx.query_row("SELECT hlc FROM field WHERE ent = ?1 AND f = ?2", [ent, f], |r| r.get(0)).optional()?;
            let would = cur.as_deref().map_or(true, |c| c < hlc.as_str()); // string order, as the TS side compares HLCs
            if would != *wrote { return Err(drift("putFieldIfNewer", wrote, &would)); }
            if would { tx.execute("INSERT INTO field (ent, f, val, hlc) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(ent, f) DO UPDATE SET val = excluded.val, hlc = excluded.hlc", [ent, f, val, hlc])?; }
        }
        Op::RekeyField { ent, f, from, to, ok } => {
            let cur: Option<String> = tx.query_row("SELECT hlc FROM field WHERE ent = ?1 AND f = ?2", [ent, f], |r| r.get(0)).optional()?;
            let would = cur.as_deref() == Some(from.as_str());
            if would != *ok { return Err(drift("rekeyField", ok, &would)); }
            if would { tx.execute("UPDATE field SET hlc = ?3 WHERE ent = ?1 AND f = ?2", [ent, f, to])?; }
        }
        Op::PutEvent { ev, inserted } => {
            let n = tx.execute("INSERT OR IGNORE INTO event (id, ent, kind, hlc, body) VALUES (?1, ?2, ?3, ?4, ?5)", [&ev.id, &ev.ent, &ev.kind, &ev.hlc, &ev.body])? == 1;
            if n != *inserted { return Err(drift("putEvent", inserted, &n)); }
        }
        Op::RekeyEvent { id, to, ok } => {
            let n = tx.execute("UPDATE event SET hlc = ?2 WHERE id = ?1", [id, to])? == 1;
            if n != *ok { return Err(drift("rekeyEvent", ok, &n)); }
        }
        Op::PutDocState { doc, state, max_sv } => {
            tx.execute("INSERT INTO doc_state (doc, state, max_sv) VALUES (?1, ?2, ?3) ON CONFLICT(doc) DO UPDATE SET state = excluded.state, max_sv = excluded.max_sv", params![doc, Store::blob(state)?, max_sv])?;
        }
        Op::BumpMaxSv { doc, sv } => {
            tx.execute("INSERT INTO doc_state (doc, state, max_sv) VALUES (?1, NULL, ?2) ON CONFLICT(doc) DO UPDATE SET max_sv = MAX(max_sv, excluded.max_sv)", params![doc, sv])?;
        }
        Op::AppendDocUpdate { doc, upd, k } => {
            let cur: i64 = tx.query_row("SELECT k FROM doc_seq WHERE doc = ?1", [doc], |r| r.get(0)).optional()?.unwrap_or(0);
            if cur + 1 != *k { return Err(drift("appendDocUpdate k", k, &(cur + 1))); }
            tx.execute("INSERT INTO doc_seq (doc, k) VALUES (?1, ?2) ON CONFLICT(doc) DO UPDATE SET k = excluded.k", params![doc, k])?;
            tx.execute("INSERT INTO doc_update (doc, k, upd) VALUES (?1, ?2, ?3)", params![doc, k, Store::blob(upd)?])?;
        }
        Op::DeleteDocUpdates { doc, through } => { tx.execute("DELETE FROM doc_update WHERE doc = ?1 AND k <= ?2", params![doc, through])?; }
        Op::AddOutbox { op, env, created, blobs } => {
            let blobs_json = match blobs { Some(b) if !b.is_empty() => Some(serde_json::to_string(b).unwrap_or_default()), _ => None };
            tx.execute("INSERT INTO outbox (op, env, created, blobs) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(op) DO UPDATE SET env = excluded.env, created = excluded.created, blobs = excluded.blobs", params![op, env, created, blobs_json])?;
        }
        Op::DeleteOutbox { ops } => { for o in ops { tx.execute("DELETE FROM outbox WHERE op = ?1", [o])?; } }
        Op::PutInbox { seq, env, inserted } => {
            let n = tx.execute("INSERT OR IGNORE INTO inbox (seq, env) VALUES (?1, ?2)", params![seq, env])? == 1;
            if n != *inserted { return Err(drift("putInbox", inserted, &n)); }
        }
        Op::PurgeEntity { ent } => {
            for sql in ["DELETE FROM field WHERE ent = ?1", "DELETE FROM event WHERE ent = ?1", "DELETE FROM doc_state WHERE doc = ?1", "DELETE FROM doc_seq WHERE doc = ?1", "DELETE FROM doc_update WHERE doc = ?1"] { tx.execute(sql, [ent])?; }
        }
        Op::DeleteInbox { seqs } => { for q in seqs { tx.execute("DELETE FROM inbox WHERE seq = ?1", [q])?; } }
        Op::AddQuarantine { seq, env, reason } => {
            tx.execute("INSERT INTO quarantine (seq, env, reason) VALUES (?1, ?2, ?3) ON CONFLICT(seq) DO UPDATE SET env = excluded.env, reason = excluded.reason", params![seq, env, reason])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ops(v: serde_json::Value) -> Vec<Op> { serde_json::from_value(v).unwrap() }
    fn b(s: &str) -> String { B64.encode(s) }

    #[test]
    fn a_batch_is_one_transaction_and_a_drifted_result_rolls_all_of_it_back() {
        let mut s = Store::open_memory().unwrap();
        // the second op assumes the register was NOT written (wrote=false) but the database has none: drift
        let bad = ops(json!([
            { "t": "setMeta", "k": "n", "v": "1" },
            { "t": "putField", "ent": "e", "f": "f", "val": "1", "hlc": "h1", "wrote": false },
        ]));
        assert!(matches!(s.commit(&bad), Err(StoreError::Drift(_))));
        assert_eq!(s.read(&Read::GetMeta { k: "n".into() }).unwrap(), json!(null), "the first write must be gone too");
        let good = ops(json!([
            { "t": "setMeta", "k": "n", "v": "1" },
            { "t": "putField", "ent": "e", "f": "f", "val": "1", "hlc": "h1", "wrote": true },
        ]));
        s.commit(&good).unwrap();
        assert_eq!(s.read(&Read::GetMeta { k: "n".into() }).unwrap(), json!("1"));
    }

    #[test]
    fn registers_are_last_writer_wins_by_hlc() {
        let mut s = Store::open_memory().unwrap();
        let put = |s: &mut Store, val: &str, hlc: &str, wrote: bool| s.commit(&ops(json!([{ "t": "putField", "ent": "e", "f": "f", "val": val, "hlc": hlc, "wrote": wrote }])));
        put(&mut s, "b", "h2", true).unwrap();
        put(&mut s, "a", "h1", false).unwrap(); // older: ignored
        put(&mut s, "x", "h2", false).unwrap(); // equal: ignored
        put(&mut s, "c", "h3", true).unwrap();
        assert_eq!(s.read(&Read::GetField { ent: "e".into(), f: "f".into() }).unwrap(), json!({ "val": "c", "hlc": "h3" }));
        assert!(put(&mut s, "z", "h1", true).is_err(), "assuming a write that would lose is drift");
    }

    #[test]
    fn doc_update_counter_never_goes_back_and_must_match() {
        let mut s = Store::open_memory().unwrap();
        s.commit(&ops(json!([
            { "t": "appendDocUpdate", "doc": "d", "upd": b("1"), "k": 1 },
            { "t": "appendDocUpdate", "doc": "d", "upd": b("2"), "k": 2 },
            { "t": "deleteDocUpdates", "doc": "d", "through": 2 },
        ]))).unwrap();
        assert_eq!(s.read(&Read::ListDocUpdates { doc: "d".into() }).unwrap(), json!([]));
        assert_eq!(s.read(&Read::DocSeq { doc: "d".into() }).unwrap(), json!(2));
        assert!(s.commit(&ops(json!([{ "t": "appendDocUpdate", "doc": "d", "upd": b("3"), "k": 1 }]))).is_err());
        s.commit(&ops(json!([{ "t": "appendDocUpdate", "doc": "d", "upd": b("3"), "k": 3 }]))).unwrap();
    }

    #[test]
    fn outbox_keeps_insertion_order_and_inbox_is_inserted_once() {
        let mut s = Store::open_memory().unwrap();
        s.commit(&ops(json!([
            { "t": "addOutbox", "op": "b", "env": "B", "created": 9 },
            { "t": "addOutbox", "op": "a", "env": "A", "created": 1 },
            { "t": "putInbox", "seq": 5, "env": "e5", "inserted": true },
        ]))).unwrap();
        let o = s.read(&Read::ListOutbox { limit: 10 }).unwrap();
        assert_eq!(o[0]["op"], "b");
        assert_eq!(o[1]["op"], "a");
        assert!(s.commit(&ops(json!([{ "t": "putInbox", "seq": 5, "env": "again", "inserted": true }]))).is_err());
        s.commit(&ops(json!([{ "t": "deleteOutbox", "ops": ["b", "zzz"] }]))).unwrap();
        assert_eq!(s.read(&Read::ListOutbox { limit: 10 }).unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_committed_transaction_survives_reopening_the_file() {
        let dir = std::env::temp_dir().join(format!("nevis-store-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ws.sqlite");
        {
            let mut s = Store::open(&path).unwrap();
            s.commit(&ops(json!([{ "t": "setMeta", "k": "deviceId", "v": "dev1" }]))).unwrap();
        } // dropped without a clean shutdown step: the WAL file holds the commit
        let s = Store::open(&path).unwrap();
        assert_eq!(s.read(&Read::GetMeta { k: "deviceId".into() }).unwrap(), json!("dev1"));
        assert_eq!(s.read(&Read::GetMeta { k: "storeVersion".into() }).unwrap(), json!(STORE_VERSION));
        std::fs::remove_dir_all(&dir).ok();
    }
}
