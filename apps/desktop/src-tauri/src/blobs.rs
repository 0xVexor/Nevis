//! The files of attachments on the desktop (ROADMAP M9): `<data>/files/<workspace>/<ab>/<sha256>`, named by the SHA-256 of their bytes.
//! The row that makes a file known lives in the workspace's SQLite (`store.rs`). Order of writes: the file is written whole to a temporary
//! name, flushed, renamed into place; ONLY THEN is the row inserted. A crash leaves at most a file without a row (harmless), never a row
//! without its bytes. Rust checks the hash of every file it is given, so a name always means its content.
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn valid_hash(h: &str) -> bool { h.len() == 64 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// `files/<ws>/<ab>/<hash>`; None for a malformed workspace or hash (nothing outside the folder can be named).
pub fn file_path(data_dir: &Path, ws: &str, hash: &str) -> Option<PathBuf> {
    let ws_ok = !ws.is_empty() && ws.len() <= 64 && ws.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ws_ok || !valid_hash(hash) { return None; }
    Some(data_dir.join("files").join(ws).join(&hash[..2]).join(hash))
}

#[derive(Debug)]
pub enum PutError { BadName, HashMismatch, Io(String) }
impl PutError {
    pub fn message(&self) -> String {
        match self { PutError::BadName => "bad attachment name".into(), PutError::HashMismatch => "the bytes do not match their hash".into(), PutError::Io(e) => format!("io: {e}") }
    }
}

/// Writes the file (if it is not there already). The bytes must hash to `hash`.
pub fn write_file(data_dir: &Path, ws: &str, hash: &str, bytes: &[u8]) -> Result<(), PutError> {
    let path = file_path(data_dir, ws, hash).ok_or(PutError::BadName)?;
    if sha256_hex(bytes) != hash { return Err(PutError::HashMismatch); }
    if path.exists() { return Ok(()); }
    let dir = path.parent().ok_or(PutError::BadName)?;
    std::fs::create_dir_all(dir).map_err(|e| PutError::Io(e.to_string()))?;
    let tmp = dir.join(format!(".{hash}.{}.tmp", std::process::id()));
    let mut f = std::fs::File::create(&tmp).map_err(|e| PutError::Io(e.to_string()))?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| { let _ = std::fs::remove_file(&tmp); PutError::Io(e.to_string()) })?;
    std::fs::rename(&tmp, &path).map_err(|e| { let _ = std::fs::remove_file(&tmp); PutError::Io(e.to_string()) })
}

pub fn read_file(data_dir: &Path, ws: &str, hash: &str) -> Option<Vec<u8>> { std::fs::read(file_path(data_dir, ws, hash)?).ok() }

pub fn remove_file(data_dir: &Path, ws: &str, hash: &str) { if let Some(p) = file_path(data_dir, ws, hash) { let _ = std::fs::remove_file(p); } }

/// A mime type the way a header may carry it: letters, digits and `/ + . -` only, else empty (it is only ever a hint).
pub fn clean_mime(m: &str) -> String {
    if m.len() <= 100 && m.bytes().all(|c| c.is_ascii_alphanumeric() || b"/+.-".contains(&c)) { m.to_string() } else { String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nevis-blobs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn names_never_leave_the_folder() {
        let d = tmp("names");
        let h = sha256_hex(b"x");
        assert!(file_path(&d, "ws-1", &h).unwrap().starts_with(d.join("files")));
        for bad in ["../x", "", "a/b", "A".repeat(65).as_str()] { assert!(file_path(&d, bad, &h).is_none(), "{bad}"); }
        for bad in ["../../etc/passwd", &"A".repeat(64), &"a".repeat(63), ""] { assert!(file_path(&d, "ws", bad).is_none(), "{bad}"); }
    }

    #[test]
    fn a_file_is_kept_whole_and_only_under_its_own_hash() {
        let d = tmp("write");
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let h = sha256_hex(&bytes);
        write_file(&d, "ws", &h, &bytes).unwrap();
        assert_eq!(read_file(&d, "ws", &h).unwrap(), bytes);
        write_file(&d, "ws", &h, &bytes).unwrap(); // again: fine
        assert!(matches!(write_file(&d, "ws", &sha256_hex(b"other"), &bytes), Err(PutError::HashMismatch)));
        assert!(read_file(&d, "ws", &sha256_hex(b"other")).is_none(), "a refused file leaves nothing");
        // no temporary file is left behind
        let left: Vec<_> = std::fs::read_dir(file_path(&d, "ws", &h).unwrap().parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(left, vec![h.clone()]);
        remove_file(&d, "ws", &h);
        assert!(read_file(&d, "ws", &h).is_none());
    }

    #[test]
    fn rows_pending_in_order_and_the_outbox_keeps_its_gate_across_a_reopen_and_a_migration() {
        let mut s = Store::open_memory().unwrap();
        for (i, h) in ["a", "b", "c"].iter().enumerate() { s.blob_insert(&h.repeat(64), 10 + i as i64, "image/png", false).unwrap(); }
        s.blob_set(&"a".repeat(64), Some(true), None).unwrap();
        s.blob_set(&"b".repeat(64), None, Some("blob_too_large")).unwrap();
        let pending: Vec<String> = s.blob_list(true).unwrap().iter().map(|v| v["hash"].as_str().unwrap().to_string()).collect();
        assert_eq!(pending, vec!["c".repeat(64)]);
        assert_eq!(s.blob_list(false).unwrap().len(), 3);
        let again = s.blob_insert(&"a".repeat(64), 999, "x/y", false).unwrap(); // a second insert never changes size, mime or remote
        assert_eq!((again["size"].as_i64(), again["remote"].as_bool()), (Some(10), Some(true)));
        s.blob_remove(&"c".repeat(64)).unwrap();
        assert!(s.blob_meta(&"c".repeat(64)).unwrap().is_none());
    }

    #[test]
    fn a_database_made_before_m9_gets_the_outbox_column_and_keeps_its_rows() {
        use crate::store::{Op, Read};
        use serde_json::json;
        let dir = tmp("migrate");
        let path = dir.join("ws.sqlite");
        {
            let c = rusqlite::Connection::open(&path).unwrap();
            c.execute_batch("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL UNIQUE, env TEXT NOT NULL, created INTEGER NOT NULL); INSERT INTO outbox (op, env, created) VALUES ('old', 'E', 1);").unwrap();
        }
        let mut s = Store::open(&path).unwrap();
        let ops: Vec<Op> = serde_json::from_value(json!([{ "t": "addOutbox", "op": "new", "env": "N", "created": 2, "blobs": ["a"] }])).unwrap();
        s.commit(&ops).unwrap();
        let o = s.read(&Read::ListOutbox { limit: 10 }).unwrap();
        assert_eq!(o[0]["op"], "old");
        assert!(o[0].get("blobs").is_none());
        assert_eq!(o[1]["blobs"], json!(["a"]));
    }
}
