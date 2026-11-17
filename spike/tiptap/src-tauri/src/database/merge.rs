//! Conflict handling for database files (handoff §23). Two devices changed the same record: both complete versions are
//! kept (the loser goes to `history/records/<kind>/<id>/`), and for pages that are database rows the cells are merged per
//! property using their stamps, so "A edits Cost while B edits Notes" loses nothing. The same cell edited on both sides is
//! decided deterministically (higher stamp counter, then device id) and the other value stays in history.

use serde_json::{json, Map, Value};

fn rev(v: &Value, page: bool) -> i64 {
    if page {
        v.get("recordMeta").and_then(|m| m.get("revision")).and_then(Value::as_i64).unwrap_or(0)
    } else {
        v.get("revision").and_then(Value::as_i64).unwrap_or(0)
    }
}
fn updated(v: &Value) -> i64 {
    v.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64
}
fn op(v: &Value, page: bool) -> String {
    let m = if page { v.get("recordMeta") } else { Some(v) };
    m.and_then(|m| m.get("lastOperationId")).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// true when `a` wins over `b`: higher revision, then newer update, then the larger operation id (so both devices agree).
pub fn wins(a: &Value, b: &Value, page: bool) -> bool {
    (rev(a, page), updated(a), op(a, page)) >= (rev(b, page), updated(b), op(b, page))
}

fn stamp_rank(c: &Value) -> (i64, String) {
    let s = c.get("stamp");
    (s.and_then(|s| s.get("counter")).and_then(Value::as_i64).unwrap_or(0), s.and_then(|s| s.get("deviceId")).and_then(Value::as_str).unwrap_or_default().to_string())
}

/// Merge two versions of the same record. Returns the merged record and the complete versions that must be preserved.
pub fn merge_records(a: &Value, b: &Value) -> (Value, Vec<Value>) {
    if a == b {
        return (a.clone(), vec![]);
    }
    let (win, lose) = if wins(a, b, false) { (a, b) } else { (b, a) };
    // a tombstone never silently erases a newer edit; the higher revision decides and the other version stays in history
    let mut merged = win.clone();
    merged["revision"] = json!(rev(a, false).max(rev(b, false)) + 1);
    merged["updatedAt"] = json!(updated(a).max(updated(b)));
    merged["lastOperationId"] = json!(format!("merge:{}:{}", op(a, false), op(b, false)).chars().take(120).collect::<String>());
    (merged, vec![lose.clone()])
}

/// Merge two versions of a page. Row cells merge per property; everything else follows the winner.
pub fn merge_pages(a: &Value, b: &Value) -> (Value, Vec<Value>) {
    if a == b {
        return (a.clone(), vec![]);
    }
    let (win, lose) = if wins(a, b, true) { (a, b) } else { (b, a) };
    let mut merged = win.clone();
    let both_rows = a.get("database").is_some_and(|d| d.is_object()) && b.get("database").is_some_and(|d| d.is_object()) && a["database"].get("sourceId") == b["database"].get("sourceId");
    if both_rows {
        let (wc, lc) = (win["database"]["cells"].as_object().cloned().unwrap_or_default(), lose["database"]["cells"].as_object().cloned().unwrap_or_default());
        let mut cells = Map::new();
        for k in wc.keys().chain(lc.keys()) {
            if cells.contains_key(k) {
                continue;
            }
            let v = match (wc.get(k), lc.get(k)) {
                (Some(x), Some(y)) => if stamp_rank(y) > stamp_rank(x) { y } else { x },
                (Some(x), None) => x,
                (None, Some(y)) => y, // present on one side only: keep it, never lose data
                (None, None) => continue,
            };
            cells.insert(k.clone(), v.clone());
        }
        merged["database"]["cells"] = Value::Object(cells);
        // allocated ids are immutable tokens: union, the winner's token stays when both exist
        let mut alloc = lose["database"]["allocatedIds"].as_object().cloned().unwrap_or_default();
        for (k, v) in win["database"]["allocatedIds"].as_object().cloned().unwrap_or_default() {
            alloc.insert(k, v);
        }
        merged["database"]["allocatedIds"] = Value::Object(alloc);
        let r = win["database"].get("revision").and_then(Value::as_i64).unwrap_or(0).max(lose["database"].get("revision").and_then(Value::as_i64).unwrap_or(0)) + 1;
        merged["database"]["revision"] = json!(r);
    }
    let new_rev = rev(a, true).max(rev(b, true)) + 1;
    if !merged.get("recordMeta").is_some_and(Value::is_object) {
        merged["recordMeta"] = json!({ "format": 1, "createdAt": updated(win), "createdBy": "", "updatedBy": "", "inferred": true });
    }
    merged["recordMeta"]["revision"] = json!(new_rev);
    merged["recordMeta"]["lastOperationId"] = json!(format!("merge:{}:{}", op(a, true), op(b, true)).chars().take(120).collect::<String>());
    merged["updatedAt"] = json!(updated(a).max(updated(b)));
    (merged, vec![lose.clone()])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(rev: i64, at: i64, cells: Value, title: &str) -> Value {
        json!({ "id": "p1", "title": title, "updatedAt": at, "recordMeta": { "format": 1, "revision": rev, "lastOperationId": format!("op{rev}") },
            "database": { "format": 1, "sourceId": "s", "revision": rev, "cells": cells, "allocatedIds": {} } })
    }
    fn cell(v: i64, counter: i64, dev: &str) -> Value {
        json!({ "value": { "kind": "number", "value": v }, "stamp": { "counter": counter, "deviceId": dev, "opId": "x" } })
    }

    #[test]
    fn disjoint_cells_merge_and_both_versions_survive() {
        let a = page(3, 100, json!({ "cost": cell(10, 3, "D1") }), "T1");
        let b = page(3, 90, json!({ "notes": cell(7, 3, "D2") }), "T1");
        let (m, lost) = merge_pages(&a, &b);
        assert_eq!(m["database"]["cells"]["cost"]["value"]["value"], 10);
        assert_eq!(m["database"]["cells"]["notes"]["value"]["value"], 7);
        assert_eq!(lost.len(), 1);
        assert_eq!(m["recordMeta"]["revision"], 4);
        // symmetric: the other device computes the same answer
        let (m2, _) = merge_pages(&b, &a);
        assert_eq!(m["database"]["cells"], m2["database"]["cells"]);
    }

    #[test]
    fn same_cell_is_decided_by_stamp_then_device_and_loser_is_kept() {
        let a = page(2, 10, json!({ "cost": cell(1, 5, "D1") }), "a");
        let b = page(2, 20, json!({ "cost": cell(2, 5, "D2") }), "b");
        let (m, lost) = merge_pages(&a, &b);
        assert_eq!(m["database"]["cells"]["cost"]["value"]["value"], 2); // same counter: larger device id wins
        assert_eq!(lost.len(), 1);
        let (m2, _) = merge_pages(&b, &a);
        assert_eq!(m2["database"]["cells"]["cost"]["value"]["value"], 2);
        let c = page(2, 10, json!({ "cost": cell(1, 9, "D1") }), "a");
        assert_eq!(merge_pages(&c, &b).0["database"]["cells"]["cost"]["value"]["value"], 1); // higher counter beats device order
    }

    #[test]
    fn records_follow_the_higher_revision_and_keep_the_loser() {
        let a = json!({ "id": "v", "revision": 4, "updatedAt": 5, "lastOperationId": "a", "name": "A", "deletedAt": null });
        let b = json!({ "id": "v", "revision": 3, "updatedAt": 9, "lastOperationId": "b", "name": "B", "deletedAt": 7 });
        let (m, lost) = merge_records(&a, &b);
        assert_eq!(m["name"], "A");
        assert_eq!(m["deletedAt"], Value::Null); // edit-vs-delete: the newer revision decides, the tombstone version is preserved
        assert_eq!(lost[0]["name"], "B");
        assert_eq!(m["revision"], 5);
        assert_eq!(merge_records(&b, &a).0["name"], "A");
    }
}
