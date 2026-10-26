use super::*;
use crate::vault::Vault;
use serde_json::json;

fn vault() -> (Vault, std::path::PathBuf) {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!("noviq-dbtest-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&dir);
    let v = Vault::create(dir.clone(), "test").unwrap();
    (v, dir)
}

fn rec(kind: &str, id: &str, revision: i64, extra: Value) -> Value {
    let mut r = json!({ "format": 1, "id": id, "vaultId": "v", "revision": revision, "createdAt": 1, "updatedAt": 1, "createdBy": "U1", "updatedBy": "U1", "deletedAt": null, "lastOperationId": "op" });
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        r[k] = v;
    }
    let _ = kind;
    r
}

fn page(id: &str, revision: i64, title: &str, source: &str, cells: Value) -> Value {
    json!({ "id": id, "parentId": null, "title": title, "updatedAt": 5, "deletedAt": null, "favorite": false, "sort": 0, "content": { "type": "doc", "content": [] },
        "recordMeta": { "format": 1, "revision": revision, "createdAt": 1, "createdBy": "U1", "updatedBy": "U1", "lastOperationId": "op" },
        "database": { "format": 1, "sourceId": source, "schemaRevision": 1, "revision": revision, "sortKey": id, "parentItemId": null, "cells": cells, "allocatedIds": {}, "archivedCells": {} } })
}

fn batch(op: &str, records: Vec<Value>, pages: Vec<Value>) -> Value {
    json!({ "operationId": op, "vaultId": "v", "records": records, "pages": pages, "history": [], "commit": { "operationId": op, "generation": 1, "changed": [], "warnings": [] }, "undo": null })
}
fn rw(kind: &str, base: i64, after: Value) -> Value {
    json!({ "kind": kind, "id": after["id"], "baseRevision": base, "after": after })
}
fn pw(base: i64, after: Value) -> Value {
    json!({ "id": after["id"], "baseRevision": base, "after": after })
}

fn crash(at: Option<&'static str>) {
    CRASH.with(|c| *c.borrow_mut() = at);
}

#[test]
fn commit_writes_records_pages_history_and_operation_result() {
    let (v, root) = vault();
    let mut b = batch("op1", vec![rw("source", 0, rec("source", "s1", 1, json!({ "titlePropertyId": "t1", "schemaRevision": 1 })))], vec![pw(0, page("p1", 1, "T1", "s1", json!({})))]);
    b["history"] = json!([{ "recordKind": "source", "id": "s1", "revision": 1, "body": { "old": true } }]);
    commit(&v.root, &b).unwrap();
    assert!(root.join("databases/sources/s1.json").exists());
    assert_eq!(read_json(&root.join("pages/p1.json")).unwrap()["title"], "T1");
    assert!(get_operation(&v.root, "op1").unwrap().is_some());
    assert_eq!(history(&v.root, "source", "s1").unwrap()[0]["body"]["old"], true);
    assert!(fs::read_dir(journal_dir(&root)).map_or(true, |d| d.count() == 0), "journal is pruned after apply");
    let all = load_all(&v.root).unwrap();
    assert_eq!(all["records"]["source"].as_array().unwrap().len(), 1);
}

#[test]
fn ids_with_forbidden_filename_characters_round_trip() {
    let (v, root) = vault();
    let id = "rep:tpl|1|2026-10-25T05:30:00.000Z";
    commit(&v.root, &batch("op-e", vec![rw("event", 0, rec("event", id, 1, json!({ "type": "workflow_run", "pageId": null, "principalId": null, "data": null })))], vec![])).unwrap();
    let name = enc(id).unwrap();
    assert!(!name.contains(':') && !name.contains('|'));
    assert!(root.join("databases/events").join(format!("{name}.json")).exists());
    let all = load_all(&v.root).unwrap();
    assert_eq!(all["records"]["event"][0]["id"], id);
    assert!(enc(&"x".repeat(500)).unwrap().len() < 200);
}

#[test]
fn stale_writer_is_refused_with_both_revisions() {
    let (v, _r) = vault();
    commit(&v.root, &batch("a", vec![rw("view", 0, rec("view", "v1", 1, json!({ "name": "A" })))], vec![])).unwrap();
    let e = commit(&v.root, &batch("b", vec![rw("view", 0, rec("view", "v1", 1, json!({ "name": "B" })))], vec![])).unwrap_err();
    assert!(e.starts_with("REVISION_CONFLICT:view/v1:0:1"), "{e}");
    let ok = commit(&v.root, &batch("c", vec![rw("view", 1, rec("view", "v1", 2, json!({ "name": "C" })))], vec![]));
    assert!(ok.is_ok());
    // a stale page write too
    commit(&v.root, &batch("p", vec![], vec![pw(0, page("p9", 1, "x", "s", json!({})))])).unwrap();
    assert!(commit(&v.root, &batch("p2", vec![], vec![pw(0, page("p9", 1, "y", "s", json!({})))])).unwrap_err().starts_with("REVISION_CONFLICT:page/p9"));
}

#[test]
fn crash_before_journal_commit_has_no_effect() {
    let (v, root) = vault();
    crash(Some("before_journal_commit"));
    let r = commit(&v.root, &batch("c1", vec![rw("view", 0, rec("view", "v1", 1, json!({})))], vec![pw(0, page("p1", 1, "x", "s", json!({})))]));
    crash(None);
    assert!(r.is_err());
    assert_eq!(recover(&v.root).unwrap()["replayed"], 0);
    assert!(!root.join("databases/views/v1.json").exists());
    assert!(!root.join("pages/p1.json").exists());
    assert!(fs::read_dir(journal_dir(&root)).map_or(true, |d| d.count() == 0), "an uncommitted journal is discarded");
}

#[test]
fn crash_between_writes_is_replayed_exactly_once() {
    let (v, root) = vault();
    crash(Some("between_writes"));
    let b = batch("c2", vec![rw("view", 0, rec("view", "v1", 1, json!({ "name": "one" }))), rw("view", 0, rec("view", "v2", 1, json!({ "name": "two" })))], vec![pw(0, page("p1", 1, "x", "s", json!({})))]);
    assert!(commit(&v.root, &b).is_err());
    crash(None);
    assert!(root.join("databases/views/v1.json").exists() && !root.join("databases/views/v2.json").exists(), "half applied on disk");
    assert_eq!(recover(&v.root).unwrap()["replayed"], 1);
    assert!(root.join("databases/views/v2.json").exists() && root.join("pages/p1.json").exists());
    assert_eq!(recover(&v.root).unwrap()["replayed"], 0, "a second recovery finds nothing");
    assert_eq!(read_json(&root.join("databases/views/v1.json")).unwrap()["revision"], 1);
}

#[test]
fn crash_after_journal_commit_and_before_index_recover() {
    let (v, root) = vault();
    for point in ["after_journal_commit", "before_index"] {
        crash(Some(point));
        let id = format!("v-{point}");
        let _ = commit(&v.root, &batch(point, vec![rw("view", 0, rec("view", &id, 1, json!({})))], vec![]));
        crash(None);
        recover(&v.root).unwrap();
        assert!(root.join("databases/views").join(format!("{}.json", enc(&id).unwrap())).exists(), "{point}");
    }
}

#[test]
fn recovery_fails_closed_when_a_file_matches_neither_side() {
    let (v, root) = vault();
    crash(Some("after_journal_commit"));
    let _ = commit(&v.root, &batch("c3", vec![rw("view", 0, rec("view", "v1", 1, json!({ "name": "mine" })))], vec![]));
    crash(None);
    // somebody wrote revision 7 in the meantime
    write_atomic(&root.join("databases/views/v1.json"), rec("view", "v1", 7, json!({ "name": "theirs" })).to_string().as_bytes()).unwrap();
    let e = recover(&v.root).unwrap_err();
    assert!(e.starts_with("RECOVERY_REQUIRED:"), "{e}");
    assert_eq!(read_json(&root.join("databases/views/v1.json")).unwrap()["name"], "theirs", "nothing was overwritten");
    assert!(fs::read_dir(journal_dir(&root)).unwrap().count() == 1, "the journal is kept for repair");
}

#[test]
fn bodyless_page_write_keeps_the_body_on_disk() {
    let (v, root) = vault();
    commit(&v.root, &batch("a", vec![], vec![pw(0, page("p1", 1, "T", "s", json!({})))])).unwrap();
    let mut p2 = page("p1", 2, "T2", "s", json!({}));
    p2.as_object_mut().unwrap().remove("content"); // the UI had not loaded the body
    commit(&v.root, &batch("b", vec![], vec![pw(1, p2)])).unwrap();
    let on_disk = read_json(&root.join("pages/p1.json")).unwrap();
    assert_eq!(on_disk["title"], "T2");
    assert_eq!(on_disk["content"]["type"], "doc");
}

#[test]
fn unknown_formats_and_foreign_names_are_quarantined_not_rewritten() {
    let (v, root) = vault();
    write_atomic(&root.join("databases/views/alien.json"), json!({ "format": 9, "id": "alien", "revision": 1 }).to_string().as_bytes()).unwrap();
    write_atomic(&root.join("databases/views/mismatch.json"), rec("view", "other", 1, json!({})).to_string().as_bytes()).unwrap();
    fs::write(root.join("databases/views/broken.json"), b"{not json").unwrap();
    let all = load_all(&v.root).unwrap();
    assert_eq!(all["quarantined"].as_array().unwrap().len(), 3);
    assert!(all["records"].get("view").is_none());
    assert!(fs::read_to_string(root.join("databases/views/alien.json")).unwrap().contains("\"format\":9"));
}

#[test]
fn oversize_batches_and_bad_ids_are_rejected_before_touching_disk() {
    let (v, root) = vault();
    assert!(commit(&v.root, &batch("x", vec![json!({ "kind": "nope", "id": "a", "baseRevision": 0, "after": {} })], vec![])).is_err());
    assert!(commit(&v.root, &batch("x", vec![], vec![json!({ "id": "../evil", "baseRevision": 0, "after": { "id": "../evil" } })])).is_err());
    let mut r = rec("view", "big", 1, json!({}));
    r["blob"] = json!("x".repeat(MAX_RECORD_BYTES + 10));
    assert!(commit(&v.root, &batch("x", vec![rw("view", 0, r)], vec![])).unwrap_err().starts_with("QUOTA:"));
    assert!(!root.join("databases/views/big.json").exists());
}

#[test]
fn history_is_trimmed_and_runtime_keys_listed() {
    let (v, _r) = vault();
    for i in 1..=60 {
        let mut b = batch(&format!("h{i}"), vec![], vec![]);
        b["history"] = json!([{ "recordKind": "view", "id": "v", "revision": i, "body": { "n": i } }]);
        commit(&v.root, &b).unwrap();
    }
    let h = history(&v.root, "view", "v").unwrap();
    assert_eq!(h.len(), KEEP_HISTORY);
    assert_eq!(h[0]["revision"], 60);
    runtime_set(&v.root, "pending:wf:p1", &json!({ "a": 1 })).unwrap();
    runtime_set(&v.root, "cursor:wf", &json!(5)).unwrap();
    assert_eq!(runtime_get(&v.root, "pending:wf:p1").unwrap().unwrap()["a"], 1);
    assert_eq!(runtime_keys(&v.root, "pending:"), vec!["pending:wf:p1".to_string()]);
    runtime_delete(&v.root, "pending:wf:p1").unwrap();
    assert!(runtime_keys(&v.root, "pending:").is_empty());
}

fn seed_index_vault() -> (Vault, std::path::PathBuf) {
    let (v, root) = vault();
    let cells = |cost: Value, tags: Value, done: Option<bool>, notes: &str| {
        let mut c = json!({ "cost": { "value": { "kind": "number", "value": cost }, "stamp": {} }, "tags": { "value": { "kind": "multi_select", "optionIds": tags }, "stamp": {} },
            "notes": { "value": { "kind": "text", "runs": if notes.is_empty() { json!([]) } else { json!([{ "text": notes }]) } }, "stamp": {} } });
        if let Some(d) = done { c["done"] = json!({ "value": { "kind": "checkbox", "value": d }, "stamp": {} }); }
        c
    };
    let recs = vec![
        rw("source", 0, rec("source", "s1", 1, json!({ "titlePropertyId": "title", "schemaRevision": 1 }))),
        rw("edge", 0, rec("edge", "e1", 1, json!({ "definitionId": "r", "fromPageId": "T1", "toPageId": "P1", "sortKey": "V" }))),
    ];
    let pages = vec![
        pw(0, page("T1", 1, "تکلیف ۱", "s1", cells(json!(0), json!(["red", "blue"]), Some(false), ""))),
        pw(0, page("T2", 1, "T2", "s1", cells(json!(10), json!(["blue"]), Some(true), "   "))),
        pw(0, page("T3", 1, "T3", "s1", cells(Value::Null, json!([]), Some(false), "alpha"))),
        pw(0, page("T4", 1, "T4", "s1", cells(json!(-5), json!(["green"]), Some(true), "beta"))),
    ];
    commit(&v.root, &batch("seed", recs, pages)).unwrap();
    (v, root)
}

#[test]
fn index_candidates_match_the_fixture_expectations() {
    let (v, root) = seed_index_vault();
    let mut db = rusqlite::Connection::open_in_memory().unwrap();
    index::ensure_schema(&db).unwrap();
    assert!(index::needs_rebuild(&db));
    assert_eq!(index::rebuild(&mut db, &v.root).unwrap() > 0, true);
    assert!(!index::needs_rebuild(&db));
    let c = |p: &str, op: &str, x: Value| index::candidates(&db, &v.root, "s1", p, op, &x).unwrap();
    assert_eq!(c("cost", "is_empty", Value::Null), vec!["T3"]); // F01
    assert_eq!(c("done", "equals", json!(false)), vec!["T1", "T3"]); // F02
    assert_eq!(c("notes", "is_empty", Value::Null), vec!["T1"]); // F03: whitespace is not empty
    assert_eq!(c("cost", "gte", json!(0)), vec!["T1", "T2"]);
    assert_eq!(c("cost", "lt", json!(0)), vec!["T4"]); // numbers are numeric, not strings
    assert_eq!(c("tags", "contains", json!("blue")), vec!["T1", "T2"]);
    assert_eq!(c("title", "starts_with", json!("تکلیف")), vec!["T1"]);
    assert_eq!(c("title", "equals", json!("t2")), vec!["T2"]); // case folded key
    assert_eq!(index::count_items(&db, &v.root, "s1").unwrap(), 4);
    assert!(index::candidates(&db, &v.root, "s1", "cost", "regex", &json!("x")).unwrap_err().starts_with("INVALID_FILTER:"));
    let _ = root;
}

#[test]
fn incremental_index_equals_a_rebuild_after_edits_and_deletes() {
    let (v, root) = seed_index_vault();
    let mut inc = rusqlite::Connection::open_in_memory().unwrap();
    index::ensure_schema(&inc).unwrap();
    index::rebuild(&mut inc, &v.root).unwrap();
    // change a cell, trash a row, tombstone an edge
    let mut t2 = page("T2", 2, "T2 renamed", "s1", json!({ "cost": { "value": { "kind": "number", "value": 99 }, "stamp": {} } }));
    t2["database"]["revision"] = json!(2);
    let mut t4 = page("T4", 2, "T4", "s1", json!({}));
    t4["deletedAt"] = json!(9);
    let e1 = rec("edge", "e1", 2, json!({ "definitionId": "r", "fromPageId": "T1", "toPageId": "P1", "sortKey": "V", "deletedAt": 9 }));
    let b = batch("edit", vec![rw("edge", 1, e1)], vec![pw(1, t2), pw(1, t4)]);
    commit(&v.root, &b).unwrap();
    index::apply_batch(&mut inc, &v.root, &b).unwrap();
    let mut fresh = rusqlite::Connection::open_in_memory().unwrap();
    index::ensure_schema(&fresh).unwrap();
    index::rebuild(&mut fresh, &v.root).unwrap();
    let dump = |db: &rusqlite::Connection| {
        let mut out = vec![];
        for q in ["SELECT page_id,deleted,row_revision FROM db_items ORDER BY 1", "SELECT property_id,page_id,value_kind,is_empty,number_value,text_key,boolean_value FROM db_values_scalar ORDER BY 1,2", "SELECT property_id,page_id,member_id FROM db_values_members ORDER BY 1,2,3", "SELECT id,deleted FROM db_relation_edges ORDER BY 1"] {
            let mut st = db.prepare(q).unwrap();
            let n = st.column_count();
            let rows = st.query_map([], |r| Ok((0..n).map(|i| format!("{:?}", r.get::<_, rusqlite::types::Value>(i).unwrap())).collect::<Vec<_>>().join("|"))).unwrap();
            out.extend(rows.map(|r| r.unwrap()));
        }
        out
    };
    assert_eq!(dump(&inc), dump(&fresh));
    assert_eq!(index::candidates(&inc, &v.root, "s1", "cost", "equals", &json!(99)).unwrap(), vec!["T2"]);
    assert_eq!(index::count_items(&inc, &v.root, "s1").unwrap(), 3); // T4 is in the trash
    let _ = root;
}

#[test]
fn index_of_another_version_is_dropped_not_migrated() {
    let (v, _r) = seed_index_vault();
    let mut db = rusqlite::Connection::open_in_memory().unwrap();
    index::ensure_schema(&db).unwrap();
    index::rebuild(&mut db, &v.root).unwrap();
    db.execute("UPDATE db_index_meta SET value='0' WHERE key='version'", []).unwrap();
    index::ensure_schema(&db).unwrap();
    assert!(index::needs_rebuild(&db));
    assert_eq!(db.query_row::<i64, _, _>("SELECT COUNT(*) FROM db_items", [], |r| r.get(0)).unwrap(), 0);
}
