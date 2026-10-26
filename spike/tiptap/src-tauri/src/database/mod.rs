//! Database records of a Vault (docs/notion-database-handoff.md §6). Canonical files:
//!
//! ```text
//! databases/<containers|sources|properties|views|relations|edges|templates|workflows|comments|principals|grants|events|allocators>/<id>.json
//! history/records/<kind>/<id>/<revision>.json         full pre-images (synced)
//! .noviq/database-journal/<operation>.json            redo journal, local only
//! .noviq/database-ops/<operation>.json                results of applied operations (idempotent retries), local only
//! .noviq/database-undo.json, .noviq/workflow-runtime/ local only
//! .noviq/index.db                                     disposable query index (see index.rs)
//! ```
//!
//! A batch is one durable unit: it is written to a journal, the journal is marked committed, the post-images are applied
//! idempotently, the index is updated and the journal is pruned. After a crash `recover` replays committed journals; a file
//! that matches neither the expected old revision nor the new one fails closed (`RECOVERY_REQUIRED`) and nothing is overwritten.

pub mod index;
pub mod merge;

use crate::vault::{err, now_ms, write_atomic, Res};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub const KINDS: [(&str, &str); 13] = [
    ("container", "containers"),
    ("source", "sources"),
    ("property", "properties"),
    ("view", "views"),
    ("relation", "relations"),
    ("edge", "edges"),
    ("template", "templates"),
    ("workflow", "workflows"),
    ("comment", "comments"),
    ("principal", "principals"),
    ("grant", "grants"),
    ("event", "events"),
    ("allocator", "allocators"),
];

pub const MAX_BATCH_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_WRITES: usize = 20_000;
pub const KEEP_HISTORY: usize = 50;
pub const KEEP_OPS: usize = 6_000;

pub fn dir_of(kind: &str) -> Res<&'static str> {
    KINDS.iter().find(|(k, _)| *k == kind).map(|(_, d)| *d).ok_or_else(|| format!("unknown record kind: {kind}"))
}

/// File-name form of an id. Ids made by the app may contain `:` `|` etc. (event ids), which Windows forbids in names.
/// Everything outside `[A-Za-z0-9_-]` becomes `~XX`; very long ids are cut and suffixed with a hash. The record itself
/// carries the real id, so decoding is never needed.
pub fn enc(id: &str) -> Res<String> {
    if id.is_empty() {
        return Err("empty id".into());
    }
    let mut out = String::new();
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            out.push(b as char);
        } else {
            out.push_str(&format!("~{b:02x}"));
        }
    }
    if out.len() > 160 {
        let mut h = Sha256::new();
        h.update(id.as_bytes());
        let hex: String = h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect();
        out = format!("{}~~{hex}", &out[..100]);
    }
    Ok(out)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn rec_path(root: &Path, kind: &str, id: &str) -> Res<PathBuf> {
    Ok(root.join("databases").join(dir_of(kind)?).join(format!("{}.json", enc(id)?)))
}
fn page_path(root: &Path, id: &str) -> Res<PathBuf> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("bad page id: {id}"));
    }
    Ok(root.join("pages").join(format!("{id}.json")))
}
fn journal_dir(root: &Path) -> PathBuf {
    root.join(".noviq/database-journal")
}
fn ops_dir(root: &Path) -> PathBuf {
    root.join(".noviq/database-ops")
}

fn revision_of(v: &Value) -> i64 {
    v.get("revision").and_then(Value::as_i64).unwrap_or(0)
}
fn page_revision(v: &Value) -> i64 {
    v.get("recordMeta").and_then(|m| m.get("revision")).and_then(Value::as_i64).unwrap_or(0)
}

#[cfg(test)]
thread_local! { pub static CRASH: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) }; }

#[cfg(test)]
fn crash_point(name: &str) -> Res<()> {
    CRASH.with(|c| if *c.borrow() == Some(name) { Err(format!("simulated crash at {name}")) } else { Ok(()) })
}
#[cfg(not(test))]
fn crash_point(_name: &str) -> Res<()> {
    Ok(())
}

// ───── loading ─────

/// Every record, read in parallel. Records with an unknown format are reported, never rewritten.
pub fn load_all(root: &Path) -> Res<Value> {
    let mut files: Vec<(&'static str, PathBuf)> = vec![];
    for (kind, dir) in KINDS {
        let d = root.join("databases").join(dir);
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") && !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.')) {
                files.push((kind, p));
            }
        }
    }
    let loaded: Vec<(&str, PathBuf, Option<Value>)> = files.into_iter().map(|(k, p)| { let v = read_json(&p); (k, p, v) }).collect();
    let mut records = Map::new();
    let mut quarantined = vec![];
    for (kind, path, v) in loaded {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        match v {
            Some(v) if v.get("format").and_then(Value::as_i64) == Some(1) && v.get("id").and_then(Value::as_str).is_some() => {
                let id = v["id"].as_str().unwrap_or_default();
                if enc(id).ok().as_deref() != Some(stem.as_str()) {
                    quarantined.push(json!({ "kind": kind, "id": id, "reason": "id does not match its file name" }));
                    continue;
                }
                records.entry(kind.to_string()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(v);
            }
            Some(v) => quarantined.push(json!({ "kind": kind, "id": v.get("id").cloned().unwrap_or(json!(stem)), "reason": "unknown record format" })),
            None => quarantined.push(json!({ "kind": kind, "id": stem, "reason": "unreadable file" })),
        }
    }
    Ok(json!({ "records": records, "quarantined": quarantined }))
}

// ───── commit / recovery ─────

struct Batch<'a> {
    id: String,
    records: &'a [Value],
    pages: &'a [Value],
    history: &'a [Value],
    commit: &'a Value,
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[])
}

fn parse<'a>(b: &'a Value) -> Res<Batch<'a>> {
    let id = b.get("operationId").and_then(Value::as_str).ok_or("batch without operationId")?.to_string();
    let batch = Batch { id, records: arr(b, "records"), pages: arr(b, "pages"), history: arr(b, "history"), commit: b.get("commit").unwrap_or(&Value::Null) };
    if batch.records.len() + batch.pages.len() + batch.history.len() > MAX_WRITES {
        return Err("QUOTA:batch has too many writes".into());
    }
    for r in batch.records {
        let kind = r.get("kind").and_then(Value::as_str).ok_or("record write without kind")?;
        let id = r.get("id").and_then(Value::as_str).ok_or("record write without id")?;
        rec_path(Path::new("x"), kind, id)?; // validates kind and id
        if let Some(after) = r.get("after").filter(|a| !a.is_null()) {
            if after.get("id").and_then(Value::as_str) != Some(id) {
                return Err(format!("record {kind}/{id}: id does not match"));
            }
            if after.to_string().len() > MAX_RECORD_BYTES {
                return Err(format!("QUOTA:record {kind}/{id} is larger than {MAX_RECORD_BYTES} bytes"));
            }
        }
    }
    for p in batch.pages {
        let id = p.get("id").and_then(Value::as_str).ok_or("page write without id")?;
        page_path(Path::new("x"), id)?;
    }
    Ok(batch)
}

/// The revision a file has on disk (0 = not there).
fn on_disk(root: &Path, w: &Value, is_page: bool) -> Res<i64> {
    let id = w["id"].as_str().unwrap_or_default();
    if is_page {
        Ok(read_json(&page_path(root, id)?).map_or(0, |v| page_revision(&v)))
    } else {
        Ok(read_json(&rec_path(root, w["kind"].as_str().unwrap_or_default(), id)?).map_or(0, |v| revision_of(&v)))
    }
}

fn post_revision(w: &Value, is_page: bool) -> Option<i64> {
    let after = w.get("after").filter(|a| !a.is_null())?;
    Some(if is_page { page_revision(after) } else { revision_of(after) })
}

fn verify(root: &Path, b: &Batch, recovering: bool) -> Res<()> {
    for (list, is_page) in [(b.records, false), (b.pages, true)] {
        for w in list {
            let cur = on_disk(root, w, is_page)?;
            let base = w.get("baseRevision").and_then(Value::as_i64).unwrap_or(0);
            let what = if is_page { format!("page/{}", w["id"].as_str().unwrap_or("?")) } else { format!("{}/{}", w["kind"].as_str().unwrap_or("?"), w["id"].as_str().unwrap_or("?")) };
            if cur == base {
                continue;
            }
            if recovering {
                if post_revision(w, is_page) == Some(cur) {
                    continue; // already applied
                }
                // a record that is being removed and is already gone
                if w.get("after").map_or(true, Value::is_null) && cur == 0 {
                    continue;
                }
                return Err(format!("RECOVERY_REQUIRED:{what} does not match the journal (expected {base}, found {cur})"));
            }
            return Err(format!("REVISION_CONFLICT:{what}:{base}:{cur}"));
        }
    }
    Ok(())
}

fn apply(root: &Path, b: &Batch) -> Res<()> {
    let mut n = 0;
    for w in b.records {
        crash_if_second("between_writes", &mut n)?;
        let (kind, id) = (w["kind"].as_str().unwrap_or_default(), w["id"].as_str().unwrap_or_default());
        let path = rec_path(root, kind, id)?;
        match w.get("after").filter(|a| !a.is_null()) {
            Some(after) => write_atomic(&path, after.to_string().as_bytes())?,
            None => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    for w in b.pages {
        crash_if_second("between_writes", &mut n)?;
        let id = w["id"].as_str().unwrap_or_default();
        let path = page_path(root, id)?;
        match w.get("after").filter(|a| !a.is_null()) {
            Some(after) => {
                // the UI loads page bodies lazily: a post-image without a body must never wipe the body on disk
                let bodyless = after.get("content").map_or(true, Value::is_null);
                if bodyless {
                    if let Some(cur) = read_json(&path).and_then(|c| c.get("content").cloned()).filter(|c| !c.is_null()) {
                        let mut merged = after.clone();
                        merged["content"] = cur;
                        write_atomic(&path, merged.to_string().as_bytes())?;
                        continue;
                    }
                }
                write_atomic(&path, after.to_string().as_bytes())?;
            }
            None => {
                if path.exists() {
                    let dest = root.join(".trash/pages").join(format!("{id}.json"));
                    let _ = fs::create_dir_all(root.join(".trash/pages"));
                    let _ = fs::remove_file(&dest);
                    fs::rename(&path, &dest).map_err(err)?;
                    write_atomic(&root.join(".trash/pages").join(format!("{id}.del")), now_ms().to_string().as_bytes())?;
                }
            }
        }
    }
    for h in b.history {
        let (kind, id) = (h["recordKind"].as_str().unwrap_or_default(), h["id"].as_str().unwrap_or_default());
        let rev = h.get("revision").and_then(Value::as_i64).unwrap_or(0);
        let dir = root.join("history/records").join(enc(kind)?).join(enc(id)?);
        write_atomic(&dir.join(format!("{rev:010}.json")), json!({ "revision": rev, "body": h.get("body").cloned().unwrap_or(Value::Null) }).to_string().as_bytes())?;
        trim_history(&dir);
    }
    if !b.commit.is_null() {
        write_atomic(&ops_dir(root).join(format!("{}.json", enc(&b.id)?)), b.commit.to_string().as_bytes())?;
    }
    Ok(())
}

fn crash_if_second(name: &str, n: &mut usize) -> Res<()> {
    *n += 1;
    if *n == 2 { crash_point(name) } else { Ok(()) }
}

fn trim_history(dir: &Path) {
    let mut names: Vec<_> = fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| e.file_name().to_str().map(String::from)).filter(|n| n.ends_with(".json")).collect();
    names.sort();
    if names.len() > KEEP_HISTORY {
        for n in &names[..names.len() - KEEP_HISTORY] {
            let _ = fs::remove_file(dir.join(n));
        }
    }
}

fn prune_ops(root: &Path) {
    let dir = ops_dir(root);
    let mut files: Vec<_> = fs::read_dir(&dir).into_iter().flatten().flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    if files.len() <= KEEP_OPS + 500 {
        return;
    }
    files.sort();
    for (_, p) in &files[..files.len() - KEEP_OPS] {
        let _ = fs::remove_file(p);
    }
}

/// Durable, atomic from the app's point of view. Errors carry a code prefix the UI maps to its stable error codes.
pub fn commit(root: &Path, batch: &Value) -> Res<()> {
    let b = parse(batch)?;
    if batch.to_string().len() > MAX_BATCH_BYTES {
        return Err("QUOTA:batch is larger than 64 MiB".into());
    }
    verify(root, &b, false)?;
    let jpath = journal_dir(root).join(format!("{}.json", enc(&b.id)?));
    write_atomic(&jpath, json!({ "batch": batch, "committed": false }).to_string().as_bytes())?;
    crash_point("before_journal_commit")?;
    write_atomic(&jpath, json!({ "batch": batch, "committed": true }).to_string().as_bytes())?;
    crash_point("after_journal_commit")?;
    apply(root, &b)?;
    crash_point("before_index")?;
    let _ = fs::remove_file(&jpath); // applied: the journal has done its job
    prune_ops(root);
    Ok(())
}

/// Replay committed journals; drop uncommitted ones (they have no visible effect). Fails closed on any mismatch.
pub fn recover(root: &Path) -> Res<Value> {
    let dir = journal_dir(root);
    let mut replayed = 0;
    let mut files: Vec<PathBuf> = fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json")).collect();
    files.sort();
    for p in files {
        let Some(j) = read_json(&p) else {
            // a journal that cannot be parsed was never committed completely: atomic writes make this a leftover
            let _ = fs::remove_file(&p);
            continue;
        };
        if j.get("committed").and_then(Value::as_bool) != Some(true) {
            let _ = fs::remove_file(&p);
            continue;
        }
        let batch = j.get("batch").ok_or("journal without batch")?;
        let b = parse(batch)?;
        verify(root, &b, true)?;
        apply(root, &b)?;
        let _ = fs::remove_file(&p);
        replayed += 1;
    }
    Ok(json!({ "replayed": replayed }))
}

pub fn get_operation(root: &Path, id: &str) -> Res<Option<Value>> {
    Ok(read_json(&ops_dir(root).join(format!("{}.json", enc(id)?))))
}

pub fn history(root: &Path, kind: &str, id: &str) -> Res<Vec<Value>> {
    let dir = root.join("history/records").join(enc(kind)?).join(enc(id)?);
    let mut out: Vec<Value> = fs::read_dir(&dir).into_iter().flatten().flatten().filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".json"))).filter_map(|e| read_json(&e.path())).collect();
    out.sort_by_key(|v| std::cmp::Reverse(v.get("revision").and_then(Value::as_i64).unwrap_or(0)));
    Ok(out)
}

// ───── device-local state ─────

pub fn undo_load(root: &Path) -> Value {
    read_json(&root.join(".noviq/database-undo.json")).unwrap_or(json!([]))
}
pub fn undo_save(root: &Path, v: &Value) -> Res<()> {
    write_atomic(&root.join(".noviq/database-undo.json"), v.to_string().as_bytes())
}
pub fn runtime_get(root: &Path, key: &str) -> Res<Option<Value>> {
    Ok(read_json(&root.join(".noviq/workflow-runtime").join(format!("{}.json", enc(key)?))).and_then(|v| v.get("value").cloned()))
}
pub fn runtime_set(root: &Path, key: &str, v: &Value) -> Res<()> {
    write_atomic(&root.join(".noviq/workflow-runtime").join(format!("{}.json", enc(key)?)), json!({ "__key": key, "value": v }).to_string().as_bytes())
}
pub fn runtime_delete(root: &Path, key: &str) -> Res<()> {
    let _ = fs::remove_file(root.join(".noviq/workflow-runtime").join(format!("{}.json", enc(key)?)));
    Ok(())
}
/// Keys are stored inside the file (`{"key": ..., "value": ...}`) so prefixes can be listed despite name encoding.
pub fn runtime_keys(root: &Path, prefix: &str) -> Vec<String> {
    let mut out = vec![];
    for e in fs::read_dir(root.join(".noviq/workflow-runtime")).into_iter().flatten().flatten() {
        if let Some(v) = read_json(&e.path()) {
            if let Some(k) = v.get("__key").and_then(Value::as_str) {
                if k.starts_with(prefix) {
                    out.push(k.to_string());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;

// ───── conflicts (used by sync and by the vault's conflict-copy merge) ─────

fn short_hash(v: &Value) -> String {
    let mut h = Sha256::new();
    h.update(v.to_string().as_bytes());
    h.finalize().iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// A synced database path is `databases/<known dir>/<file>.json`, nothing deeper, no escapes.
pub fn safe_database_rel(p: &str) -> bool {
    let Some(rest) = p.strip_prefix("databases/") else { return false };
    let mut it = rest.split('/');
    let (Some(dir), Some(file), None) = (it.next(), it.next(), it.next()) else { return false };
    KINDS.iter().any(|(_, d)| *d == dir) && file.ends_with(".json") && !file.starts_with('.') && file.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'~' | b'.' | b' ' | b'(' | b')'))
}

/// Both complete versions are kept: the loser becomes a history entry of its record, whichever side won.
pub fn keep_losers(root: &Path, rel_path: &str, losers: &[Value]) -> Res<()> {
    let dir_name = rel_path.split('/').nth(1).unwrap_or_default();
    let Some((kind, _)) = KINDS.iter().find(|(_, d)| *d == dir_name) else { return Err(format!("not a database path: {rel_path}")) };
    for l in losers {
        let id = l.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let rev = revision_of(l);
        let dir = root.join("history/records").join(enc(kind)?).join(enc(id)?);
        write_atomic(&dir.join(format!("{rev:010}-conflict-{}.json", short_hash(l))), json!({ "revision": rev, "body": l, "conflict": true }).to_string().as_bytes())?;
    }
    Ok(())
}

/// The complete losing version of a page (properties, stamps, extension), not just its title and body.
pub fn keep_page_loser(root: &Path, id: &str, loser: &Value) -> Res<()> {
    if loser.get("database").is_none() && loser.get("recordMeta").is_none() {
        return Ok(()); // a plain page: the vault's own history entry (title + body) is complete
    }
    let rev = page_revision(loser);
    let dir = root.join("history/records").join("page").join(enc(id)?);
    write_atomic(&dir.join(format!("{rev:010}-conflict-{}.json", short_hash(loser))), json!({ "revision": rev, "body": loser, "conflict": true }).to_string().as_bytes())?;
    trim_history(&dir);
    Ok(())
}
