//! Three-way merge of a page that was edited on two devices, block by block.
//!
//! The engine used to keep the whole page with the newer `updatedAt` and put the other version in the history, even
//! when the two edits touched different blocks. Here the top-level blocks of the TipTap document are matched by
//! `blockId` and compared with the common base: a block changed (edited, added, deleted, moved) on one side only is
//! taken from that side. Anything that is not clearly one-sided is left to the old rule (`None`): the same block
//! changed differently on both sides, delete against edit, two different reorderings, repeated or missing block ids.
//!
//! The result must not depend on which version is called `local`: two devices that meet the same conflict with the
//! roles swapped have to write the same bytes, or they would upload alternating versions forever. So the order is built
//! only from sets and from the base: the surviving base blocks in base order (or in the order of the one side that moved
//! them), and the blocks that are new on a side as runs placed after the nearest preceding surviving block, runs
//! at the same place ordered by the ids they start with.

use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

type Blocks<'a> = Vec<(&'a str, &'a Value)>;

/// The merged page, or None when the two versions must not be merged automatically.
pub fn merge_pages(base: &Value, local: &Value, remote: &Value) -> Option<Value> {
    let (b, l, r) = (base.as_object()?, local.as_object()?, remote.as_object()?);
    if [b, l, r].iter().any(|p| p.contains_key("database") || p.get("deletedAt").is_some_and(|d| !d.is_null())) {
        return None;
    }
    let (bc, lc, rc) = (b.get("content")?, l.get("content")?, r.get("content")?);
    if ![bc, lc, rc].iter().all(|c| is_doc(c)) {
        return None;
    }
    let mut out = Map::new();
    for k in b.keys().chain(l.keys()).chain(r.keys()).collect::<BTreeSet<_>>() {
        let (bv, lv, rv) = (b.get(k), l.get(k), r.get(k));
        let value = if k == "content" {
            Some(merge_doc(bc, lc, rc)?)
        } else if k == "updatedAt" {
            Some(later(lv?, rv?)?)
        } else if lv == rv || rv == bv {
            lv.cloned()
        } else if lv == bv {
            rv.cloned()
        } else {
            return None;
        };
        if let Some(v) = value {
            out.insert(k.clone(), v);
        }
    }
    let merged = Value::Object(out);
    valid_page(&merged).then_some(merged)
}

fn is_doc(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("doc") && v.get("content").is_none_or(Value::is_array)
}

fn later(a: &Value, b: &Value) -> Option<Value> {
    let (x, y) = (a.as_f64()?, b.as_f64()?);
    // (equal numbers can be written differently, 1 and 1.0: the same pick on both devices)
    Some(if x > y || (x == y && a.to_string() <= b.to_string()) { a.clone() } else { b.clone() })
}

fn blocks_of(doc: &Value) -> &[Value] {
    doc.get("content").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn block_id(block: &Value) -> Option<&str> {
    block.get("attrs")?.get("blockId")?.as_str().filter(|id| !id.is_empty())
}

/// Blocks with their ids; None when a block has no id or an id repeats.
fn identified(doc: &Value) -> Option<Blocks<'_>> {
    let mut seen = BTreeSet::new();
    blocks_of(doc).iter().map(|b| block_id(b).filter(|id| seen.insert(*id)).map(|id| (id, b))).collect()
}

fn merge_doc(base: &Value, local: &Value, remote: &Value) -> Option<Value> {
    let rest = |d: &Value| d.as_object().map(|o| o.iter().filter(|(k, _)| *k != "content").map(|(k, v)| (k.clone(), v.clone())).collect::<BTreeMap<_, _>>());
    let (bo, lo, ro) = (rest(base)?, rest(local)?, rest(remote)?);
    let mut doc = Map::new();
    for k in bo.keys().chain(lo.keys()).chain(ro.keys()).collect::<BTreeSet<_>>() {
        let (bv, lv, rv) = (bo.get(k), lo.get(k), ro.get(k));
        let value = if lv == rv || rv == bv { lv } else if lv == bv { rv } else { return None };
        if let Some(v) = value {
            doc.insert(k.clone(), v.clone());
        }
    }
    let content = if blocks_of(local) == blocks_of(remote) || blocks_of(remote) == blocks_of(base) {
        blocks_of(local).to_vec()
    } else if blocks_of(local) == blocks_of(base) {
        blocks_of(remote).to_vec()
    } else {
        merge_blocks(identified(base)?, identified(local)?, identified(remote)?)?
    };
    doc.insert("content".into(), Value::Array(content));
    Some(Value::Object(doc))
}

fn merge_blocks<'a>(base: Blocks<'a>, local: Blocks<'a>, remote: Blocks<'a>) -> Option<Vec<Value>> {
    let map = |v: &Blocks<'a>| v.iter().cloned().collect::<BTreeMap<&str, &Value>>();
    let (bm, lm, rm) = (map(&base), map(&local), map(&remote));
    // content of every block that survives, by id
    let mut kept: BTreeMap<&str, &Value> = BTreeMap::new();
    for id in bm.keys().chain(lm.keys()).chain(rm.keys()).collect::<BTreeSet<_>>() {
        let chosen = match (bm.get(id), lm.get(id), rm.get(id)) {
            (Some(b), Some(l), Some(r)) => Some(if l == r || r == b { *l } else if l == b { *r } else { return None }),
            (Some(b), Some(l), None) => if l == b { None } else { return None }, // deleted there, edited here
            (Some(b), None, Some(r)) => if r == b { None } else { return None },
            (Some(_), None, None) => None,
            (None, Some(l), Some(r)) => Some(if l == r { *l } else { return None }),
            (None, Some(x), None) | (None, None, Some(x)) => Some(*x),
            (None, None, None) => None,
        };
        if let Some(c) = chosen {
            kept.insert(id, c);
        }
    }
    // the surviving blocks of the base: base order, or the order of the one side that moved them
    let survivors = |v: &Blocks<'a>| v.iter().map(|(id, _)| *id).filter(|id| bm.contains_key(id) && kept.contains_key(id)).collect::<Vec<_>>();
    let (sb, sl, sr) = (survivors(&base), survivors(&local), survivors(&remote));
    let skeleton = if sl == sr || sr == sb { sl } else if sl == sb { sr } else { return None };
    let on_skeleton: BTreeSet<&str> = skeleton.iter().copied().collect();
    // new blocks of each side as runs after the surviving block that precedes them there (None: at the start)
    let runs = |v: &Blocks<'a>| {
        let mut out: BTreeMap<Option<&str>, Vec<Vec<&str>>> = BTreeMap::new();
        let (mut anchor, mut open) = (None, false);
        for (id, _) in v {
            if on_skeleton.contains(id) {
                (anchor, open) = (Some(*id), false);
            } else if !bm.contains_key(id) {
                let list = out.entry(anchor).or_default();
                if open {
                    list.last_mut().expect("open run").push(id);
                } else {
                    list.push(vec![id]);
                    open = true;
                }
            }
        }
        out
    };
    let (rl, rr) = (runs(&local), runs(&remote));
    let mut merged_runs: BTreeMap<Option<&str>, BTreeSet<Vec<&str>>> = BTreeMap::new();
    for (anchor, list) in rl.iter().chain(rr.iter()) {
        merged_runs.entry(*anchor).or_default().extend(list.iter().cloned());
    }
    // an id new on both sides must have been put in the same place by both (the same run), or we cannot tell where it belongs
    let mut placed = BTreeSet::new();
    for run in merged_runs.values().flatten().flatten() {
        if !placed.insert(*run) {
            return None;
        }
    }
    let mut out = vec![];
    let push_runs = |anchor: Option<&str>, out: &mut Vec<Value>| {
        for run in merged_runs.get(&anchor).into_iter().flatten() {
            out.extend(run.iter().filter_map(|id| kept.get(id)).map(|b| (*b).clone()));
        }
    };
    push_runs(None, &mut out);
    for id in &skeleton {
        out.push((*kept.get(id)?).clone());
        push_runs(Some(id), &mut out);
    }
    // every surviving block is in the result exactly once
    (out.len() == kept.len()).then_some(out)
}

/// The minimal shape of a page the editor can open: a doc whose blocks are objects with a type and distinct block ids.
fn valid_page(page: &Value) -> bool {
    let Some(content) = page.get("content") else { return false };
    if !is_doc(content) {
        return false;
    }
    let mut ids = BTreeSet::new();
    blocks_of(content).iter().all(|b| b.get("type").is_some_and(Value::is_string) && block_id(b).is_some_and(|id| ids.insert(id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn block(id: &str, text: &str) -> Value {
        json!({ "type": "paragraph", "attrs": { "blockId": id }, "content": [{ "type": "text", "text": text }] })
    }

    fn page(title: &str, blocks: &[(&str, &str)], at: i64) -> Value {
        let kids: Vec<Value> = blocks.iter().map(|(id, t)| block(id, t)).collect();
        json!({ "id": "p", "title": title, "icon": "", "content": { "type": "doc", "content": kids }, "updatedAt": at, "deletedAt": null })
    }

    fn bytes(v: &Value) -> Vec<u8> {
        crate::sync::snapshot::canonical(v).unwrap()
    }

    /// merge(base, a, b) and merge(base, b, a) must be the same bytes.
    fn both_ways(base: &Value, a: &Value, b: &Value) -> Option<Value> {
        let (x, y) = (merge_pages(base, a, b), merge_pages(base, b, a));
        assert_eq!(x.as_ref().map(bytes), y.as_ref().map(bytes), "swapping the sides changed the result");
        x
    }

    fn texts(p: &Value) -> Vec<String> {
        blocks_of(&p["content"]).iter().map(|b| b["content"][0]["text"].as_str().unwrap_or("").to_string()).collect()
    }

    const BASE: [(&str, &str); 4] = [("a", "one"), ("b", "two"), ("c", "three"), ("d", "four")];

    #[test]
    fn edits_of_different_blocks_merge() {
        let base = page("t", &BASE, 1);
        let l = page("t", &[("a", "one!"), ("b", "two"), ("c", "three"), ("d", "four")], 5);
        let r = page("t", &[("a", "one"), ("b", "two"), ("c", "three!"), ("d", "four")], 9);
        let m = both_ways(&base, &l, &r).unwrap();
        assert_eq!(texts(&m), ["one!", "two", "three!", "four"]);
        assert_eq!(m["updatedAt"], 9);
    }

    #[test]
    fn the_same_block_changed_on_both_sides_is_not_merged() {
        let base = page("t", &BASE, 1);
        let l = page("t", &[("a", "x"), ("b", "two"), ("c", "three"), ("d", "four")], 2);
        let r = page("t", &[("a", "y"), ("b", "two"), ("c", "three"), ("d", "four")], 3);
        assert!(both_ways(&base, &l, &r).is_none());
        // the same change on both sides is no conflict
        let same = page("t", &[("a", "x"), ("b", "two"), ("c", "three"), ("d", "four")], 3);
        assert_eq!(texts(&both_ways(&base, &l, &same).unwrap())[0], "x");
    }

    #[test]
    fn both_sides_adding_at_the_same_place_is_ordered_by_block_id() {
        let base = page("t", &BASE, 1);
        let l = page("t", &[("a", "one"), ("z", "from l"), ("b", "two"), ("c", "three"), ("d", "four")], 2);
        let r = page("t", &[("a", "one"), ("m", "from r"), ("b", "two"), ("c", "three"), ("d", "four")], 3);
        assert_eq!(texts(&both_ways(&base, &l, &r).unwrap()), ["one", "from r", "from l", "two", "three", "four"]);
        // runs stay together
        let l2 = page("t", &[("a", "one"), ("z", "z1"), ("y", "y1"), ("b", "two"), ("c", "three"), ("d", "four")], 2);
        assert_eq!(texts(&both_ways(&base, &l2, &r).unwrap()), ["one", "from r", "z1", "y1", "two", "three", "four"]);
    }

    #[test]
    fn a_deletion_and_an_edit_of_another_block_merge_but_delete_against_edit_does_not() {
        let base = page("t", &BASE, 1);
        let del = page("t", &[("a", "one"), ("c", "three"), ("d", "four")], 2);
        let edit_d = page("t", &[("a", "one"), ("b", "two"), ("c", "three"), ("d", "four!")], 3);
        assert_eq!(texts(&both_ways(&base, &del, &edit_d).unwrap()), ["one", "three", "four!"]);
        let edit_b = page("t", &[("a", "one"), ("b", "two!"), ("c", "three"), ("d", "four")], 3);
        assert!(both_ways(&base, &del, &edit_b).is_none());
        // deleted on both sides
        assert_eq!(texts(&both_ways(&base, &del, &del).unwrap()), ["one", "three", "four"]);
    }

    #[test]
    fn a_reorder_on_one_side_merges_and_different_reorders_do_not() {
        let base = page("t", &BASE, 1);
        let moved = page("t", &[("c", "three"), ("a", "one"), ("b", "two"), ("d", "four")], 2);
        let edit = page("t", &[("a", "one"), ("b", "two"), ("c", "three"), ("d", "four!")], 3);
        assert_eq!(texts(&both_ways(&base, &moved, &edit).unwrap()), ["three", "one", "two", "four!"]);
        let other = page("t", &[("a", "one"), ("b", "two"), ("d", "four"), ("c", "three")], 3);
        assert!(both_ways(&base, &moved, &other).is_none());
        assert!(both_ways(&base, &moved, &moved).is_some());
    }

    #[test]
    fn blocks_without_ids_and_repeated_ids_are_not_merged() {
        let base = page("t", &BASE, 1);
        let l = page("t", &[("a", "x"), ("b", "two"), ("c", "three"), ("d", "four")], 2);
        let r = page("t", &[("a", "one"), ("b", "two"), ("c", "three"), ("d", "y")], 3);
        let mut legacy = r.clone();
        legacy["content"]["content"][1] = json!({ "type": "paragraph", "content": [{ "type": "text", "text": "two" }] });
        assert!(both_ways(&base, &l, &legacy).is_none());
        let mut dup = r.clone();
        dup["content"]["content"][1] = block("a", "two");
        assert!(both_ways(&base, &l, &dup).is_none());
        // not a doc
        let mut html = r;
        html["content"] = json!("<p>x</p>");
        assert!(both_ways(&base, &l, &html).is_none());
    }

    #[test]
    fn the_title_and_the_other_fields_merge_per_key() {
        let base = page("t", &BASE, 1);
        let mut l = page("title l", &BASE, 2);
        let mut r = page("t", &[("a", "one"), ("b", "two"), ("c", "three"), ("d", "four!")], 3);
        r["icon"] = json!("x");
        let m = both_ways(&base, &l, &r).unwrap();
        assert_eq!((m["title"].as_str(), m["icon"].as_str()), (Some("title l"), Some("x")));
        r["title"] = json!("title r");
        assert!(both_ways(&base, &l, &r).is_none(), "the title changed differently on both sides");
        r["title"] = json!("t");
        l["icon"] = json!("y");
        assert!(both_ways(&base, &l, &r).is_none(), "so did the icon");
        // a page in the trash on one side is not merged
        let mut gone = page("t", &BASE, 2);
        gone["deletedAt"] = json!(7);
        assert!(both_ways(&base, &gone, &r).is_none());
    }

    struct Gen(u64);
    impl Gen {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }
    }

    /// One side's random edit of the base: edit, delete, add and move blocks.
    fn mutate(g: &mut Gen, base: &[(String, String)], side: &str, serial: &mut usize) -> Vec<(String, String)> {
        let mut v = base.to_vec();
        for _ in 0..g.below(4) {
            match g.below(5) {
                0 if !v.is_empty() => {
                    let i = g.below(v.len());
                    v[i].1 = format!("{} {side}{}", v[i].1, g.below(3));
                }
                1 if !v.is_empty() => {
                    v.remove(g.below(v.len()));
                }
                2 | 3 => {
                    *serial += 1;
                    // a small id space, so that both sides sometimes add the same id (with the same or other text)
                    let id = format!("n{}", g.below(4));
                    if !v.iter().any(|(i, _)| *i == id) {
                        v.insert(g.below(v.len() + 1), (id, format!("new{}", g.below(2))));
                    }
                }
                _ if v.len() > 1 => {
                    let x = v.remove(g.below(v.len()));
                    v.insert(g.below(v.len() + 1), x);
                }
                _ => {}
            }
        }
        v
    }

    #[test]
    fn swapping_the_sides_never_changes_the_result() {
        let mut g = Gen(0x2545_F491_4F6C_DD1D);
        let (mut merged, mut refused) = (0, 0);
        for _ in 0..2000 {
            let n = g.below(7);
            let base: Vec<(String, String)> = (0..n).map(|i| (format!("b{i}"), format!("t{i}"))).collect();
            let mut serial = 0;
            let (l, r) = (mutate(&mut g, &base, "l", &mut serial), mutate(&mut g, &base, "r", &mut serial));
            let mk = |v: &[(String, String)], at| {
                let refs: Vec<(&str, &str)> = v.iter().map(|(i, t)| (i.as_str(), t.as_str())).collect();
                page("t", &refs, at)
            };
            let (pb, pl, pr) = (mk(&base, 1), mk(&l, 2 + g.below(3) as i64), mk(&r, 2 + g.below(3) as i64));
            match both_ways(&pb, &pl, &pr) {
                Some(m) => {
                    merged += 1;
                    assert!(valid_page(&m));
                    // a block only one side touched is in the result as that side has it
                    for (id, t) in &l {
                        if !base.iter().any(|(i, _)| i == id) && !r.iter().any(|(i, _)| i == id) {
                            assert!(texts(&m).contains(t));
                        }
                    }
                }
                None => refused += 1,
            }
        }
        assert!(merged > 200 && refused > 200, "the generator should cover both outcomes: {merged} merged, {refused} refused");
    }
}
