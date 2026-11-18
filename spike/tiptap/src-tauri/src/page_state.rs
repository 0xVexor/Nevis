//! Page state: the source of truth of a synced ProseMirror page is a Yjs document (the `yrs` crate), stored on the
//! server as an opaque blob `pages-state/<uuid>.bin`. The server never parses or merges it; every device merges
//! states itself and derives `pages/<id>.json` (the editing surface the editor and the MCP tools read and write)
//! from it. Local JSON edits come back in as `ingest` (a block-keyed diff applied to the state).
//!
//! Y document layout (the one y-prosemirror uses, so a later live-editing binding needs no migration):
//!   * `XmlFragment "prosemirror"`: one `XmlElement` per node, named by its node type, node attrs = element attributes;
//!     text lives in `XmlText` children whose format attributes are the marks (`{markName: markAttrs}`);
//!     inline atoms (hardBreak, mathInline...) are `XmlElement` siblings of the text runs.
//!   * `Map "page"`: one JSON value per page-level key (title, updatedAt, ...): last writer wins per key.
//!   * `Map "meta"`: the attrs of the `doc` node (`blockIdentityVersion`).
//! Deviations from y-prosemirror (inferred from its source, not tested against it): null attrs are stored (it skips
//! them), mark names that overlap use no `name--hash` key (Nevis has no overlapping marks).
//!
//! Blob: `NVPS`, u8 format=1, u8 flags (bit0 = encrypted, reserved), u16 schema_rev LE, 16 byte page uuid,
//! 16 byte genesis uuid, u32 payload_len LE, payload = Yjs update v1. The header is plain (later AEAD associated data).
//! Two states with different genesis are unrelated documents and are never merged (it would duplicate every block).

use crate::vault::{err, write_atomic, Res};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, Map as YMap, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact, TransactionMut, Update, Xml, XmlElementPrelim, XmlElementRef, XmlFragment, XmlOut, XmlTextPrelim, XmlTextRef};

pub const MAGIC: &[u8; 4] = b"NVPS";
pub const FORMAT: u8 = 1;
/// 1 = the BLOCK_TYPES and marks of this client (spike/tiptap/src/documents/blockIdentity.ts).
pub const SCHEMA_REV: u16 = 1;
const HEADER_LEN: usize = 44;
/// A state above this size is reported to the user (the server's blob limit is far higher).
pub const WARN_BYTES: usize = 8 << 20;

pub const BLOCK_TYPES: [&str; 23] = [
    "paragraph", "heading", "blockquote", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "codeBlock", "horizontalRule", "table", "tableRow",
    "tableCell", "tableHeader", "image", "callout", "toggle", "mathBlock", "mermaid", "drawing", "databaseEmbed", "layoutGroup", "layoutColumn",
];

fn is_block_type(t: &str) -> bool {
    BLOCK_TYPES.contains(&t)
}

pub fn new_uuid() -> [u8; 16] {
    *uuid::Uuid::new_v4().as_bytes()
}

// ───── header ─────

#[derive(Clone, Debug, PartialEq)]
pub struct Header {
    pub flags: u8,
    pub schema_rev: u16,
    pub page: [u8; 16],
    pub genesis: [u8; 16],
}

pub fn uuid_bytes(id: &str) -> Option<[u8; 16]> {
    (id.len() == 36).then(|| uuid::Uuid::parse_str(id).ok().map(|u| *u.as_bytes())).flatten()
}

pub fn uuid_str(b: &[u8; 16]) -> String {
    uuid::Uuid::from_bytes(*b).to_string()
}

pub fn encode_blob(h: &Header, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(MAGIC);
    out.push(FORMAT);
    out.push(h.flags);
    out.extend_from_slice(&h.schema_rev.to_le_bytes());
    out.extend_from_slice(&h.page);
    out.extend_from_slice(&h.genesis);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// Header and payload of a blob; nothing else is looked at.
pub fn decode_header(bytes: &[u8]) -> Res<(Header, &[u8])> {
    if bytes.len() < HEADER_LEN || &bytes[..4] != MAGIC || bytes[4] != FORMAT {
        return Err("PAGE_STATE:bad_header".into());
    }
    let (mut page, mut genesis) = ([0u8; 16], [0u8; 16]);
    page.copy_from_slice(&bytes[8..24]);
    genesis.copy_from_slice(&bytes[24..40]);
    let len = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
    if bytes.len() != HEADER_LEN + len {
        return Err("PAGE_STATE:bad_length".into());
    }
    if bytes[5] & 1 != 0 {
        return Err("PAGE_STATE:encrypted_unsupported".into());
    }
    Ok((Header { flags: bytes[5], schema_rev: u16::from_le_bytes([bytes[6], bytes[7]]), page, genesis }, &bytes[HEADER_LEN..]))
}

/// The header of `bytes` must belong to `page_id` (the id in the path).
pub fn check_blob(page_id: &str, bytes: &[u8]) -> Res<Header> {
    let (h, _) = decode_header(bytes)?;
    if uuid_bytes(page_id) != Some(h.page) {
        return Err("PAGE_STATE:page_mismatch".into());
    }
    Ok(h)
}

// ───── JSON shape ─────

fn num_to_any(n: &serde_json::Number) -> Any {
    match n.as_i64() {
        Some(i) => Any::Number(yrs::Number::Int(i)),
        None => Any::Number(yrs::Number::try_i64(n.as_f64().unwrap_or(0.0))),
    }
}

pub fn to_any(v: &Value) -> Any {
    match v {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => num_to_any(n),
        Value::String(s) => Any::String(Arc::from(s.as_str())),
        Value::Array(a) => Any::Array(a.iter().map(to_any).collect::<Vec<_>>().into()),
        Value::Object(o) => Any::Map(Arc::new(o.iter().map(|(k, v)| (k.clone(), to_any(v))).collect::<HashMap<_, _>>())),
    }
}

/// Integral numbers come back as integers (what JSON.stringify writes); keys are sorted.
pub fn from_any(a: &Any) -> Value {
    match a {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(yrs::Number::Int(i)) => Value::from(*i),
        Any::Number(yrs::Number::Float(f)) => norm_value(&serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number)),
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(_) => Value::Null,
        Any::Array(a) => Value::Array(a.iter().map(from_any).collect()),
        Any::Map(m) => {
            let sorted: BTreeMap<&String, &Any> = m.iter().collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), from_any(v))).collect())
        }
    }
}

fn obj_of(v: &Value, key: &str) -> Map<String, Value> {
    v.get(key).and_then(Value::as_object).cloned().unwrap_or_default()
}

/// Integral floats (1.0) are integers (1) everywhere: JSON.stringify never writes the first form.
fn norm_value(v: &Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if !n.is_i64() && !n.is_u64() && f.fract() == 0.0 && f.abs() < 9.0e15 => Value::from(f as i64),
            _ => v.clone(),
        },
        Value::Array(a) => Value::Array(a.iter().map(norm_value).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), norm_value(x))).collect()),
        _ => v.clone(),
    }
}

/// The comparable form of a content node: no empty `content`/`attrs`/`marks`, text runs with equal marks joined,
/// marks sorted by name, fixed key order.
pub fn canon_node(n: &Value) -> Value {
    let Some(o) = n.as_object() else { return n.clone() };
    let mut out = Map::new();
    out.insert("type".into(), o.get("type").cloned().unwrap_or(Value::Null));
    if let Some(a) = o.get("attrs").and_then(Value::as_object).filter(|a| !a.is_empty()) {
        out.insert("attrs".into(), norm_value(&Value::Object(a.clone())));
    }
    if let Some(t) = o.get("text").and_then(Value::as_str) {
        if let Some(marks) = o.get("marks").and_then(Value::as_array).filter(|m| !m.is_empty()) {
            out.insert("marks".into(), Value::Array(canon_marks(marks)));
        }
        out.insert("text".into(), Value::String(t.to_string()));
        return Value::Object(out);
    }
    if let Some(c) = o.get("content").and_then(Value::as_array) {
        let kids = canon_children(c);
        if !kids.is_empty() {
            out.insert("content".into(), Value::Array(kids));
        }
    }
    Value::Object(out)
}

fn canon_marks(marks: &[Value]) -> Vec<Value> {
    let mut v: Vec<Value> = marks
        .iter()
        .map(|m| {
            let mut o = Map::new();
            o.insert("type".into(), m.get("type").cloned().unwrap_or(Value::Null));
            if let Some(a) = m.get("attrs").and_then(Value::as_object).filter(|a| !a.is_empty()) {
                o.insert("attrs".into(), norm_value(&Value::Object(a.clone())));
            }
            Value::Object(o)
        })
        .collect();
    v.sort_by_key(|m| m["type"].as_str().unwrap_or("").to_string());
    v
}

fn canon_children(c: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    for n in c {
        let n = canon_node(n);
        if n.get("text").is_some() {
            if n["text"].as_str() == Some("") {
                continue;
            }
            if let Some(last) = out.last_mut().filter(|l| l.get("text").is_some() && l.get("marks") == n.get("marks")) {
                let joined = format!("{}{}", last["text"].as_str().unwrap_or(""), n["text"].as_str().unwrap_or(""));
                last["text"] = Value::String(joined);
                continue;
            }
        }
        out.push(n);
    }
    out
}

/// Canonical page: every key but `content` as it is, `content` in canonical form.
pub fn canon_page(p: &Value) -> Value {
    let mut o: Map<String, Value> = p.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), norm_value(v))).collect()).unwrap_or_default();
    if let Some(c) = p.get("content") {
        let c = canon_node(c);
        o.insert("content".into(), c);
    }
    Value::Object(o)
}

fn children_of(n: &Value) -> Vec<Value> {
    n.get("content").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn type_of(n: &Value) -> &str {
    n.get("type").and_then(Value::as_str).unwrap_or("")
}

fn block_id(n: &Value) -> Option<&str> {
    n.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str)
}

fn is_text(n: &Value) -> bool {
    type_of(n) == "text"
}

fn has_block_children(c: &[Value]) -> bool {
    c.iter().any(|n| is_block_type(type_of(n)))
}

/// A page can live as a state when its content is a plain ProseMirror document of nodes and marks we can represent
/// and it is an ordinary page (no database row, no folder or board, no string content such as the welcome page).
pub fn migratable(page: &Value) -> bool {
    let Some(o) = page.as_object() else { return false };
    if o.contains_key("database") || o.contains_key("dbHost") || o.get("kind").is_some_and(|k| !k.is_null() && k != "page") {
        return false;
    }
    let Some(c) = o.get("content") else { return false };
    if c.get("type").and_then(Value::as_str) != Some("doc") {
        return false;
    }
    fn ok(n: &Value, depth: usize) -> bool {
        let Some(o) = n.as_object() else { return false };
        if depth > 64 || !o.contains_key("type") || o.keys().any(|k| !["type", "attrs", "content", "text", "marks"].contains(&k.as_str())) {
            return false;
        }
        if let Some(m) = o.get("marks") {
            let Some(m) = m.as_array() else { return false };
            if m.iter().any(|m| m.as_object().is_none_or(|m| m.keys().any(|k| !["type", "attrs"].contains(&k.as_str())) || !m.get("type").is_some_and(Value::is_string))) {
                return false;
            }
        }
        if o.get("attrs").is_some_and(|a| !a.is_object()) || o.get("content").is_some_and(|c| !c.is_array()) {
            return false;
        }
        o.get("content").and_then(Value::as_array).is_none_or(|c| c.iter().all(|n| ok(n, depth + 1)))
    }
    ok(c, 0)
}

/// Gives every block a unique UUID block id: legacy `b1_<path>` ids are derived from the position and would collide
/// between devices that created different blocks at the same place. Returns true when something changed.
pub fn assign_uuid_block_ids(content: &mut Value) -> bool {
    fn walk(n: &mut Value, seen: &mut BTreeSet<String>) -> bool {
        let mut changed = false;
        if is_block_type(type_of(n)) {
            let old = block_id(n).map(str::to_string);
            let keep = old.as_ref().filter(|o| !o.starts_with("b1_") && !seen.contains(*o)).cloned();
            let id = keep.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            if old.as_deref() != Some(id.as_str()) {
                if let Some(o) = n.as_object_mut() {
                    let attrs = o.entry("attrs").or_insert_with(|| json!({}));
                    if !attrs.is_object() {
                        *attrs = json!({});
                    }
                    attrs["blockId"] = Value::String(id.clone());
                }
                changed = true;
            }
            seen.insert(id);
        }
        if let Some(c) = n.get_mut("content").and_then(Value::as_array_mut) {
            for k in c {
                changed |= walk(k, seen);
            }
        }
        changed
    }
    walk(content, &mut BTreeSet::new())
}

// ───── Y document → JSON ─────

fn new_doc() -> Doc {
    Doc::with_options(Options { offset_kind: OffsetKind::Utf16, ..Options::default() })
}

fn out_value(o: &Out) -> Option<Value> {
    match o {
        Out::Any(a) => Some(from_any(a)),
        _ => None,
    }
}

fn element_attrs<T: ReadTxn>(txn: &T, el: &XmlElementRef) -> Map<String, Value> {
    let mut sorted = BTreeMap::new();
    for (k, v) in el.attributes(txn) {
        if let Some(v) = out_value(&v) {
            sorted.insert(k.to_string(), v);
        }
    }
    sorted.into_iter().collect()
}

fn text_nodes<T: ReadTxn>(txn: &T, t: &XmlTextRef) -> Vec<Value> {
    let mut out = vec![];
    for d in t.diff(txn, |_| ()) {
        let Out::Any(Any::String(s)) = &d.insert else { continue };
        let mut node = Map::new();
        node.insert("type".into(), "text".into());
        if let Some(attrs) = d.attributes.as_deref().filter(|a| !a.is_empty()) {
            let mut marks: Vec<Value> = attrs
                .iter()
                .filter(|(_, v)| !matches!(v, Any::Null))
                .map(|(name, v)| {
                    let mut m = Map::new();
                    m.insert("type".into(), Value::String(name.to_string()));
                    if let Value::Object(a) = from_any(v) {
                        if !a.is_empty() {
                            m.insert("attrs".into(), Value::Object(a));
                        }
                    }
                    Value::Object(m)
                })
                .collect();
            marks.sort_by_key(|m| m["type"].as_str().unwrap_or("").to_string());
            if !marks.is_empty() {
                node.insert("marks".into(), Value::Array(marks));
            }
        }
        node.insert("text".into(), Value::String(s.to_string()));
        out.push(Value::Object(node));
    }
    out
}

fn children_json<T: ReadTxn, F: XmlFragment>(txn: &T, f: &F) -> Vec<Value> {
    let mut out = vec![];
    for c in f.children(txn) {
        match c {
            XmlOut::Element(e) => out.push(element_json(txn, &e)),
            XmlOut::Text(t) => out.extend(text_nodes(txn, &t)),
            XmlOut::Fragment(_) => {}
        }
    }
    out
}

fn element_json<T: ReadTxn>(txn: &T, el: &XmlElementRef) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), Value::String(el.tag().to_string()));
    let attrs = element_attrs(txn, el);
    if !attrs.is_empty() {
        o.insert("attrs".into(), Value::Object(attrs));
    }
    let kids = children_json(txn, el);
    if !kids.is_empty() {
        o.insert("content".into(), Value::Array(kids));
    }
    Value::Object(o)
}

// ───── JSON → Y document ─────

fn attrs_for_marks(marks: Option<&Vec<Value>>) -> Attrs {
    let mut a = Attrs::new();
    for m in marks.into_iter().flatten() {
        let name = m.get("type").and_then(Value::as_str).unwrap_or("");
        a.insert(Arc::from(name), to_any(&Value::Object(obj_of(m, "attrs"))));
    }
    a
}

/// Writes the children of an inline container into `el` (text runs and atoms in order).
fn write_inline<F: XmlFragment>(txn: &mut TransactionMut, el: &F, kids: &[Value]) {
    let kids = canon_children(kids);
    let mut run: Option<XmlTextRef> = None;
    let mut at = 0u32;
    for k in &kids {
        if is_text(k) {
            let t = match &run {
                Some(t) => t.clone(),
                None => {
                    let t = el.insert(txn, el.len(txn), XmlTextPrelim::new(""));
                    run = Some(t.clone());
                    at = 0;
                    t
                }
            };
            let s = k["text"].as_str().unwrap_or("");
            t.insert_with_attributes(txn, at, s, attrs_for_marks(k.get("marks").and_then(Value::as_array)));
            at += s.encode_utf16().count() as u32;
        } else {
            run = None;
            write_node(txn, el, el.len(txn), k);
        }
    }
}

fn write_node<F: XmlFragment>(txn: &mut TransactionMut, parent: &F, index: u32, node: &Value) -> XmlElementRef {
    let el = parent.insert(txn, index, XmlElementPrelim::empty(type_of(node)));
    for (k, v) in obj_of(node, "attrs") {
        el.insert_attribute(txn, k, to_any(&v));
    }
    let kids = children_of(node);
    if has_block_children(&kids) {
        for k in &kids {
            write_node(txn, &el, el.len(txn), k);
        }
    } else {
        write_inline(txn, &el, &kids);
    }
    el
}

fn set_attrs(txn: &mut TransactionMut, el: &XmlElementRef, from: &Map<String, Value>, to: &Map<String, Value>) {
    for (k, v) in to {
        if from.get(k) != Some(v) || !el.get_attribute(txn, k).is_some() {
            el.insert_attribute(txn, k.clone(), to_any(v));
        }
    }
    for k in from.keys().filter(|k| !to.contains_key(*k)) {
        el.remove_attribute(txn, k);
    }
}

/// One character of an inline container with the marks it carries; atoms are not representable here.
type Unit = (char, String);

fn units(kids: &[Value]) -> Option<Vec<Unit>> {
    let mut out = vec![];
    for k in canon_children(kids) {
        if !is_text(&k) {
            return None;
        }
        let marks = k.get("marks").map(|m| m.to_string()).unwrap_or_default();
        out.extend(k["text"].as_str().unwrap_or("").chars().map(|c| (c, marks.clone())));
    }
    Some(out)
}

fn utf16(u: &[Unit]) -> u32 {
    u.iter().map(|(c, _)| c.len_utf16() as u32).sum()
}

/// Inserts `add` (units) at UTF-16 position `at`, in runs of equal marks.
fn insert_units(txn: &mut TransactionMut, t: &XmlTextRef, mut at: u32, add: &[Unit]) {
    let mut i = 0;
    while i < add.len() {
        let mut j = i;
        let mut s = String::new();
        while j < add.len() && add[j].1 == add[i].1 {
            s.push(add[j].0);
            j += 1;
        }
        let marks: Option<Value> = (!add[i].1.is_empty()).then(|| serde_json::from_str(&add[i].1).unwrap_or(Value::Null));
        t.insert_with_attributes(txn, at, &s, attrs_for_marks(marks.as_ref().and_then(Value::as_array)));
        at += s.encode_utf16().count() as u32;
        i = j;
    }
}

enum Edit {
    Done,
    /// the element cannot be edited in place (inline atoms, several text runs): delete and insert it again
    Replace,
}

fn yblock_id<T: ReadTxn>(txn: &T, c: &XmlOut) -> Option<String> {
    match c {
        XmlOut::Element(e) => match e.get_attribute(txn, "blockId") {
            Some(Out::Any(Any::String(s))) => Some(s.to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn ychildren<T: ReadTxn, F: XmlFragment>(txn: &T, f: &F) -> Vec<XmlOut> {
    f.children(txn).collect()
}

/// Keys of children in order: the block id and how often it was seen before ("id#0", "id#1"): two blocks that
/// ended up with one id (two devices, one position-derived legacy id) are still told apart.
fn occ_keys<I: IntoIterator<Item = Option<String>>>(ids: I) -> Vec<Option<String>> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    ids.into_iter()
        .map(|id| {
            id.map(|id| {
                let n = seen.entry(id.clone()).or_insert(0);
                *n += 1;
                format!("{id}#{}", *n - 1)
            })
        })
        .collect()
}

fn json_keys(c: &[Value]) -> Vec<Option<String>> {
    occ_keys(c.iter().map(|n| block_id(n).map(str::to_string)))
}

fn y_keys<T: ReadTxn, F: XmlFragment>(txn: &T, f: &F) -> Vec<Option<String>> {
    occ_keys(ychildren(txn, f).iter().map(|c| yblock_id(txn, c)))
}

/// Longest increasing subsequence (by `from` position) of the keys both lists share, so blocks that only moved are
/// the ones that get deleted and inserted again.
fn keep_set(from: &[Value], to: &[Value], fk: &[Option<String>], tk: &[Option<String>]) -> BTreeSet<String> {
    let pos: HashMap<&str, usize> = fk.iter().enumerate().filter_map(|(i, k)| k.as_deref().map(|k| (k, i))).collect();
    let seq: Vec<(usize, &str)> = tk
        .iter()
        .enumerate()
        .filter_map(|(j, k)| k.as_deref().and_then(|k| pos.get(k).map(|p| (*p, j, k))))
        .filter(|(p, j, _)| type_of(&from[*p]) == type_of(&to[*j]))
        .map(|(p, _, k)| (p, k))
        .collect();
    // O(n log n) patience LIS
    let mut tails: Vec<usize> = vec![];
    let mut prev: Vec<Option<usize>> = vec![None; seq.len()];
    for (i, (p, _)) in seq.iter().enumerate() {
        let k = tails.partition_point(|&t| seq[t].0 < *p);
        if k > 0 {
            prev[i] = Some(tails[k - 1]);
        }
        if k == tails.len() { tails.push(i) } else { tails[k] = i }
    }
    let mut keep = BTreeSet::new();
    let mut cur = tails.last().copied();
    while let Some(i) = cur {
        keep.insert(seq[i].1.to_string());
        cur = prev[i];
    }
    keep
}

/// Applies the change `from` → `to` of one list of children onto the Y children of `parent`. The ids the writer
/// chose are kept as they are (the editor gives new blocks UUIDs itself).
fn sync_children<F: XmlFragment>(txn: &mut TransactionMut, parent: &F, from: &[Value], to: &[Value]) {
    let (fk, tk) = (json_keys(from), json_keys(to));
    if fk.iter().chain(&tk).any(Option::is_none) {
        // children without identity cannot be matched: the whole list is replaced
        let n = parent.len(txn);
        if n > 0 {
            parent.remove_range(txn, 0, n);
        }
        for k in to {
            write_node(txn, parent, parent.len(txn), k);
        }
        return;
    }
    let keep = keep_set(from, to, &fk, &tk);
    // deletions: gone from `to`, or moved
    for k in fk.iter().flatten().filter(|k| !keep.contains(*k)) {
        if let Some(i) = y_keys(txn, parent).iter().position(|y| y.as_ref() == Some(k)) {
            parent.remove(txn, i as u32);
        }
    }
    // kept blocks that changed
    for (j, t) in to.iter().enumerate() {
        let key = tk[j].as_ref().unwrap();
        if !keep.contains(key) {
            continue;
        }
        let f = &from[fk.iter().position(|k| k.as_ref() == Some(key)).unwrap()];
        if canon_node(f) == canon_node(t) {
            continue;
        }
        let kids = ychildren(txn, parent);
        let Some(i) = y_keys(txn, parent).iter().position(|y| y.as_ref() == Some(key)) else { continue };
        let XmlOut::Element(el) = &kids[i] else { continue };
        if let Edit::Replace = update_block(txn, el, f, t) {
            parent.remove(txn, i as u32);
            write_node(txn, parent, i as u32, t);
        }
    }
    // insertions, left to right, after the nearest block before them that is in the Y list
    for (j, t) in to.iter().enumerate() {
        if keep.contains(tk[j].as_ref().unwrap()) {
            continue;
        }
        let ys = y_keys(txn, parent);
        let mut at = 0u32;
        for p in tk[..j].iter().rev() {
            if let Some(k) = ys.iter().position(|y| y == p) {
                at = k as u32 + 1;
                break;
            }
        }
        write_node(txn, parent, at, t);
    }
}

fn update_block(txn: &mut TransactionMut, el: &XmlElementRef, from: &Value, to: &Value) -> Edit {
    set_attrs(txn, el, &obj_of(from, "attrs"), &obj_of(to, "attrs"));
    let (fc, tc) = (children_of(from), children_of(to));
    if has_block_children(&fc) || has_block_children(&tc) {
        sync_children(txn, el, &fc, &tc);
        return Edit::Done;
    }
    // an inline container: text in one run
    let (Some(fu), Some(tu)) = (units(&fc), units(&tc)) else { return Edit::Replace };
    let kids = ychildren(txn, el);
    let texts: Vec<&XmlTextRef> = kids.iter().filter_map(|c| if let XmlOut::Text(t) = c { Some(t) } else { None }).collect();
    if kids.iter().any(|c| !matches!(c, XmlOut::Text(_))) || texts.len() > 1 {
        return Edit::Replace;
    }
    let t = match texts.first() {
        Some(t) => (*t).clone(),
        None => el.insert(txn, 0, XmlTextPrelim::new("")),
    };
    let cur = units(&text_nodes(txn, &t)).unwrap_or_default();
    let pre = fu.iter().zip(&tu).take_while(|(a, b)| a == b).count();
    let suf = fu[pre..].iter().rev().zip(tu[pre..].iter().rev()).take_while(|(a, b)| a == b).count();
    let (removed, added) = (&fu[pre..fu.len() - suf], &tu[pre..tu.len() - suf]);
    let (at, del) = if cur == fu {
        (utf16(&cur[..pre]), utf16(removed))
    } else {
        // the text was changed here too (three-way): find what the other side removed, or just add
        match (!removed.is_empty()).then(|| cur.windows(removed.len()).position(|w| w == removed)).flatten() {
            Some(p) => (utf16(&cur[..p]), utf16(removed)),
            None => (utf16(&cur[..pre.min(cur.len())]), 0),
        }
    };
    if del > 0 {
        t.remove_range(txn, at, del);
    }
    insert_units(txn, &t, at, added);
    Edit::Done
}

// ───── the state ─────

pub struct State {
    pub doc: Doc,
    pub header: Header,
}

fn payload_of(doc: &Doc) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

fn load_updates(updates: &[&[u8]]) -> Res<Doc> {
    let doc = new_doc();
    {
        let mut txn = doc.transact_mut();
        for u in updates {
            txn.apply_update(Update::decode_v1(u).map_err(|e| format!("PAGE_STATE:bad_update:{e}"))?).map_err(|e| format!("PAGE_STATE:bad_update:{e}"))?;
        }
    }
    Ok(doc)
}

/// Canonical bytes of the union of some updates: a fresh document that applied them, encoded in full. Equal
/// content gives equal bytes whatever the order, which is what lets two devices settle on identical files.
fn canonical(updates: &[&[u8]]) -> Res<Vec<u8>> {
    Ok(payload_of(&load_updates(updates)?))
}

impl State {
    pub fn from_blob(bytes: &[u8]) -> Res<State> {
        let (header, payload) = decode_header(bytes)?;
        Ok(State { doc: load_updates(&[payload])?, header })
    }

    /// A new state with a fresh genesis, built from a page JSON.
    pub fn from_page(page_id: &str, page: &Value) -> Res<State> {
        let header = Header { flags: 0, schema_rev: SCHEMA_REV, page: uuid_bytes(page_id).ok_or("PAGE_STATE:bad_page_id")?, genesis: new_uuid() };
        let st = State { doc: new_doc(), header };
        st.apply(&json!({ "content": { "type": "doc" } }), page);
        Ok(st)
    }

    pub fn to_blob(&self) -> Vec<u8> {
        encode_blob(&self.header, &canonical(&[&payload_of(&self.doc)]).unwrap_or_default())
    }

    /// The page as JSON (canonical, fixed key order).
    pub fn project(&self) -> Value {
        let (page, meta, frag) = (self.doc.get_or_insert_map("page"), self.doc.get_or_insert_map("meta"), self.doc.get_or_insert_xml_fragment("prosemirror"));
        let txn = self.doc.transact();
        let mut o = Map::new();
        let mut keys: Vec<(String, Value)> = page.iter(&txn).filter_map(|(k, v)| out_value(&v).map(|v| (k.to_string(), v))).collect();
        keys.sort_by(|a, b| a.0.cmp(&b.0));
        o.extend(keys);
        let mut doc = Map::new();
        doc.insert("type".into(), "doc".into());
        let mut attrs: Vec<(String, Value)> = meta.iter(&txn).filter_map(|(k, v)| out_value(&v).map(|v| (k.to_string(), v))).collect();
        attrs.sort_by(|a, b| a.0.cmp(&b.0));
        if !attrs.is_empty() {
            doc.insert("attrs".into(), Value::Object(attrs.into_iter().collect()));
        }
        let kids = children_json(&txn, &frag);
        if !kids.is_empty() {
            doc.insert("content".into(), Value::Array(kids));
        }
        o.insert("content".into(), canon_node(&Value::Object(doc)));
        Value::Object(o)
    }

    /// Applies the change `from` → `to` (both page JSON) to the state; blocks are matched by `blockId`.
    /// `from` is normally the projection of this state; for a three-way merge it is the common ancestor and the state
    /// holds the other side's changes too. Returns true when the state changed.
    pub fn ingest(&self, from: &Value, to: &Value) -> Res<bool> {
        if self.header.schema_rev > SCHEMA_REV {
            return Err("PAGE_STATE:upgrade_required".into());
        }
        if canon_page(from) == canon_page(to) {
            return Ok(false);
        }
        if !migratable(to) {
            return Err("PAGE_STATE:not_representable".into());
        }
        self.apply(from, to);
        Ok(true)
    }

    fn apply(&self, from: &Value, to: &Value) {
        let (page, meta, frag) = (self.doc.get_or_insert_map("page"), self.doc.get_or_insert_map("meta"), self.doc.get_or_insert_xml_fragment("prosemirror"));
        let mut txn = self.doc.transact_mut();
        let (fo, tobj) = (from.as_object().cloned().unwrap_or_default(), to.as_object().cloned().unwrap_or_default());
        for (k, v) in tobj.iter().filter(|(k, _)| *k != "content") {
            if fo.get(k) != Some(v) || page.get(&txn, k).is_none() {
                page.insert(&mut txn, k.as_str(), to_any(v));
            }
        }
        for k in fo.keys().filter(|k| *k != "content" && !tobj.contains_key(*k)) {
            page.remove(&mut txn, k);
        }
        let (fa, ta) = (obj_of(from.get("content").unwrap_or(&Value::Null), "attrs"), obj_of(to.get("content").unwrap_or(&Value::Null), "attrs"));
        for (k, v) in &ta {
            if fa.get(k) != Some(v) || meta.get(&txn, k).is_none() {
                meta.insert(&mut txn, k.as_str(), to_any(v));
            }
        }
        for k in fa.keys().filter(|k| !ta.contains_key(*k)) {
            meta.remove(&mut txn, k);
        }
        let (fc, tc) = (children_of(from.get("content").unwrap_or(&Value::Null)), children_of(to.get("content").unwrap_or(&Value::Null)));
        sync_children(&mut txn, &frag, &canon_children(&fc), &canon_children(&tc));
    }
}

/// Merges two blobs of the same page. The result is the canonical union; when that is exactly what `remote`
/// already holds the remote bytes are returned unchanged and the flag is true (nothing to upload).
pub fn merge(local: &[u8], remote: &[u8]) -> Res<(Vec<u8>, bool)> {
    let ((lh, lp), (rh, rp)) = (decode_header(local)?, decode_header(remote)?);
    if lh.page != rh.page {
        return Err("PAGE_STATE:page_mismatch".into());
    }
    if lh.genesis != rh.genesis {
        return Err("PAGE_STATE:genesis_differs".into());
    }
    let merged = canonical(&[lp, rp])?;
    if merged == canonical(&[rp])? {
        return Ok((remote.to_vec(), true));
    }
    let h = Header { schema_rev: lh.schema_rev.max(rh.schema_rev), ..rh };
    Ok((encode_blob(&h, &merged), false))
}

pub fn same_genesis(a: &[u8], b: &[u8]) -> bool {
    matches!((decode_header(a), decode_header(b)), (Ok((x, _)), Ok((y, _))) if x.genesis == y.genesis)
}

// ───── files of a vault (callers hold the commit lock) ─────

pub fn bin_rel(id: &str) -> String {
    format!("pages-state/{id}.bin")
}

pub fn bin_path(root: &Path, id: &str) -> PathBuf {
    root.join(bin_rel(id))
}

fn proj_path(root: &Path, id: &str) -> PathBuf {
    root.join(".nevis/page-state").join(format!("{id}.proj"))
}

pub fn pending_path(root: &Path, id: &str) -> PathBuf {
    root.join(".nevis/page-state/pending").join(format!("{id}.bin"))
}

fn json_path(root: &Path, id: &str) -> PathBuf {
    root.join("pages").join(format!("{id}.json"))
}

fn md5_hex(b: &[u8]) -> String {
    use md5::{Digest, Md5};
    Md5::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// What the last projection looked like: the md5 of the JSON file and of the state file at that time.
fn read_proj(root: &Path, id: &str) -> Option<(String, String)> {
    let v: Value = serde_json::from_slice(&fs::read(proj_path(root, id)).ok()?).ok()?;
    Some((v["json"].as_str()?.to_string(), v["state"].as_str()?.to_string()))
}

fn write_proj(root: &Path, id: &str, json: &str, state: &str) -> Res<()> {
    write_atomic(&proj_path(root, id), json!({ "json": json, "state": state }).to_string().as_bytes())
}

/// Records that the JSON with this md5 is what the state `bin` was projected to (see `ingest_local_locked`).
pub fn mark_projection_locked(root: &Path, id: &str, json_md5: &str, bin: &[u8]) -> Res<()> {
    write_proj(root, id, json_md5, &md5_hex(bin))
}

pub fn has_state(root: &Path, id: &str) -> bool {
    bin_path(root, id).is_file()
}

pub fn read_state(root: &Path, id: &str) -> Res<Option<(State, Vec<u8>)>> {
    match fs::read(bin_path(root, id)) {
        Ok(b) => {
            check_blob(id, &b)?;
            Ok(Some((State::from_blob(&b)?, b)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

/// The ids of all pages that have a state file here.
pub fn state_ids(root: &Path) -> Vec<String> {
    fs::read_dir(root.join("pages-state"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".bin").map(str::to_string))
        .filter(|id| uuid_bytes(id).is_some())
        .collect()
}

/// Writes the state's projection unless the file already says the same thing, and records it. Order of writes
/// everywhere: `.bin`, then the JSON, then `.proj` (a crash in between leaves a diff that ingests to nothing).
fn write_projection(root: &Path, id: &str, st: &State, bin: &[u8]) -> Res<()> {
    let proj = st.project();
    let path = json_path(root, id);
    let current = fs::read(&path).ok();
    let same = current.as_ref().and_then(|b| serde_json::from_slice::<Value>(b).ok()).is_some_and(|v| canon_page(&v) == canon_page(&proj));
    let bytes = if same { current.unwrap_or_default() } else { proj.to_string().into_bytes() };
    if !same {
        write_atomic(&path, &bytes)?;
    }
    write_proj(root, id, &md5_hex(&bytes), &md5_hex(bin))
}

/// Before a local writer replaces the JSON of a page that has a state: refuses what the state cannot take in
/// (a state of a newer client, content we cannot represent), so nothing is half done.
pub fn precheck_locked(root: &Path, id: &str, json: &Value) -> Res<()> {
    let Some((st, _)) = read_state(root, id)? else { return Ok(()) };
    if st.header.schema_rev > SCHEMA_REV {
        return Err("PAGE_STATE:upgrade_required".into());
    }
    if !migratable(json) {
        return Err("PAGE_STATE:not_representable".into());
    }
    Ok(())
}

/// Takes in what a local writer put into `pages/<id>.json` since the last projection. Returns true when the state changed.
pub fn ingest_local_locked(root: &Path, id: &str) -> Res<bool> {
    let Some((st, bin)) = read_state(root, id)? else { return Ok(false) };
    let path = json_path(root, id);
    let Ok(bytes) = fs::read(&path) else {
        // the projection is gone (removed by hand): make it again, unless the page was deleted
        if !crate::sync::snapshot::tombstones_at(root)?.contains(&format!("pages/{id}.json")) {
            write_projection(root, id, &st, &bin)?;
        }
        return Ok(false);
    };
    if read_proj(root, id) == Some((md5_hex(&bytes), md5_hex(&bin))) {
        return Ok(false);
    }
    let json: Value = serde_json::from_slice(&bytes).map_err(|_| "STORAGE:unreadable_page".to_string())?;
    let changed = match st.ingest(&st.project(), &json) {
        Ok(c) => c,
        // an edit that cannot be represented (or a state from a newer client) stays a plain file edit; never overwritten
        Err(e) if e.starts_with("PAGE_STATE:") => return Err(e),
        Err(e) => return Err(e),
    };
    if changed {
        let new_bin = st.to_blob();
        write_atomic(&bin_path(root, id), &new_bin)?;
        write_projection(root, id, &st, &new_bin)?;
    } else {
        write_proj(root, id, &md5_hex(&bytes), &md5_hex(&bin))?;
    }
    Ok(changed)
}

/// `ingest_local_locked` for every page that has a state; a page that cannot be ingested is reported, not fatal.
pub fn ingest_all_locked(root: &Path) -> Vec<String> {
    let mut errors = vec![];
    for id in state_ids(root) {
        if let Err(e) = ingest_local_locked(root, &id) {
            errors.push(format!("{id}: {e}"));
        }
    }
    errors
}

/// Makes `bytes` (already merged, header checked) the state of the page here and brings the JSON up to date.
/// Local JSON edits must have been ingested before (and merged into `bytes`).
pub fn install_locked(root: &Path, id: &str, bytes: &[u8]) -> Res<()> {
    check_blob(id, bytes)?;
    let st = State::from_blob(bytes)?;
    write_atomic(&bin_path(root, id), bytes)?;
    write_projection(root, id, &st, bytes)
}

/// Removes the state files of a deleted page.
pub fn remove_locked(root: &Path, id: &str) {
    for p in [bin_path(root, id), proj_path(root, id), pending_path(root, id)] {
        let _ = fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PID: &str = "11111111-1111-4111-8111-111111111111";

    fn bid(n: u32) -> String {
        format!("00000000-0000-4000-8000-{n:012}")
    }
    fn p(n: u32, text: &str) -> Value {
        json!({ "type": "paragraph", "attrs": { "blockId": bid(n), "textAlign": null }, "content": [{ "type": "text", "text": text }] })
    }
    fn page(kids: Vec<Value>) -> Value {
        json!({ "id": PID, "title": "T", "updatedAt": 100, "deletedAt": null, "content": { "type": "doc", "attrs": { "blockIdentityVersion": 1 }, "content": kids } })
    }
    fn same(a: &Value, b: &Value) {
        assert_eq!(canon_page(a), canon_page(b), "\n{a}\n{b}");
    }
    fn roundtrip(v: &Value) -> Value {
        let st = State::from_page(PID, v).unwrap();
        let back = State::from_blob(&st.to_blob()).unwrap().project();
        same(&back, v);
        back
    }
    /// a second device: a copy of the blob
    fn fork(blob: &[u8]) -> State {
        State::from_blob(blob).unwrap()
    }

    #[test]
    fn every_block_type_marks_and_atoms_round_trip() {
        let blocks: Vec<Value> = BLOCK_TYPES.iter().enumerate().map(|(i, t)| json!({ "type": t, "attrs": { "blockId": bid(i as u32 + 1), "level": 2, "widths": [1.5, 2], "x": null, "s": "é" } })).collect();
        roundtrip(&page(blocks));
        let marks = json!([{ "type": "bold" }, { "type": "link", "attrs": { "href": "https://x.y", "target": null } }]);
        let rich = json!({ "type": "paragraph", "attrs": { "blockId": bid(1) }, "content": [
            { "type": "text", "text": "plain " }, { "type": "text", "text": "bold link", "marks": marks },
            { "type": "hardBreak" }, { "type": "mathInline", "attrs": { "latex": "x^2" } }, { "type": "text", "text": "سلام 😀 ok", "marks": [{ "type": "italic" }] } ] });
        let back = roundtrip(&page(vec![rich.clone()]));
        same(&back["content"]["content"][0], &rich);
        // nested lists, tables, layout, callout
        let nested = json!({ "type": "bulletList", "attrs": { "blockId": bid(2) }, "content": [
            { "type": "listItem", "attrs": { "blockId": bid(3) }, "content": [ p(4, "a"), { "type": "orderedList", "attrs": { "blockId": bid(5), "start": 1 }, "content": [
                { "type": "listItem", "attrs": { "blockId": bid(6) }, "content": [p(7, "deep")] } ] } ] } ] });
        let table = json!({ "type": "table", "attrs": { "blockId": bid(8) }, "content": [ { "type": "tableRow", "attrs": { "blockId": bid(9) }, "content": [
            { "type": "tableHeader", "attrs": { "blockId": bid(10), "colspan": 1 }, "content": [p(11, "h")] }, { "type": "tableCell", "attrs": { "blockId": bid(12) }, "content": [p(13, "c")] } ] } ] });
        let layout = json!({ "type": "layoutGroup", "attrs": { "blockId": bid(14), "widths": [1, 2] }, "content": [
            { "type": "layoutColumn", "attrs": { "blockId": bid(15) }, "content": [p(16, "L")] }, { "type": "layoutColumn", "attrs": { "blockId": bid(17) }, "content": [p(18, "R")] } ] });
        let callout = json!({ "type": "callout", "attrs": { "blockId": bid(19) }, "content": [p(20, "")] });
        roundtrip(&page(vec![nested, table, layout, callout]));
    }

    #[test]
    fn projection_is_canonical_and_integers_stay_integers() {
        let v = page(vec![json!({ "type": "heading", "attrs": { "blockId": bid(1), "level": 3 }, "content": [] })]);
        let out = State::from_page(PID, &v).unwrap().project();
        assert_eq!(out["content"]["content"][0]["attrs"]["level"].to_string(), "3");
        assert_eq!(out["updatedAt"].to_string(), "100");
        assert!(out["content"]["content"][0].get("content").is_none(), "empty content is left out");
        assert_eq!(out.to_string(), State::from_page(PID, &v).unwrap().project().to_string(), "fixed key order");
    }

    #[test]
    fn ingest_edits_text_with_persian_and_surrogate_pairs() {
        let a = page(vec![p(1, "سلام 😀 دنیا")]);
        let st = State::from_page(PID, &a).unwrap();
        let b = page(vec![p(1, "سلام 😀 زیبا دنیا!")]);
        assert!(st.ingest(&st.project(), &b).unwrap());
        same(&st.project(), &b);
        let c = page(vec![p(1, "سلام 😁 دنیا!")]);
        st.ingest(&st.project(), &c).unwrap();
        same(&st.project(), &c);
        let again = State::from_blob(&st.to_blob()).unwrap();
        same(&again.project(), &c);
        assert!(!st.ingest(&st.project(), &c).unwrap(), "no change, no ops");
    }

    #[test]
    fn marks_are_diffed_and_survive_a_round_trip() {
        let bold = |t: &str| json!({ "type": "text", "text": t, "marks": [{ "type": "bold" }] });
        let para = |kids: Vec<Value>| json!({ "type": "paragraph", "attrs": { "blockId": bid(1) }, "content": kids });
        let st = State::from_page(PID, &page(vec![para(vec![json!({ "type": "text", "text": "hello world" })])])).unwrap();
        let next = page(vec![para(vec![json!({ "type": "text", "text": "hello " }), bold("world")])]);
        st.ingest(&st.project(), &next).unwrap();
        same(&st.project(), &next);
    }

    #[test]
    fn blocks_inserted_deleted_moved_and_retyped() {
        let st = State::from_page(PID, &page(vec![p(1, "one"), p(2, "two"), p(3, "three")])).unwrap();
        let steps = vec![
            page(vec![p(1, "one"), p(4, "new"), p(2, "two"), p(3, "three")]),
            page(vec![p(3, "three"), p(1, "one"), p(4, "new"), p(2, "two")]),
            page(vec![p(1, "one"), p(2, "two")]),
            page(vec![json!({ "type": "heading", "attrs": { "blockId": bid(1), "level": 1 }, "content": [{ "type": "text", "text": "one" }] }), p(2, "two"), p(5, "five")]),
            page(vec![]),
        ];
        for s in steps {
            st.ingest(&st.project(), &s).unwrap();
            same(&st.project(), &s);
        }
    }

    #[test]
    fn page_keys_are_last_writer_wins_and_deleted_keys_go() {
        let st = State::from_page(PID, &page(vec![])).unwrap();
        let mut b = page(vec![]);
        b["title"] = "New".into();
        b.as_object_mut().unwrap().remove("deletedAt");
        b["icon"] = "x".into();
        st.ingest(&st.project(), &b).unwrap();
        same(&st.project(), &b);
    }

    #[test]
    fn concurrent_edits_to_different_blocks_and_the_same_paragraph_both_survive() {
        let base = State::from_page(PID, &page(vec![p(1, "hello world"), p(2, "second")])).unwrap();
        let blob = base.to_blob();
        let (a, b) = (fork(&blob), fork(&blob));
        // a edits the start of paragraph 1 and paragraph 2; b edits the end of paragraph 1
        a.ingest(&a.project(), &page(vec![p(1, "HEY hello world"), p(2, "second!")])).unwrap();
        b.ingest(&b.project(), &page(vec![p(1, "hello world, bye"), p(2, "second")])).unwrap();
        let (ba, bb) = (a.to_blob(), b.to_blob());
        let (m1, _) = merge(&ba, &bb).unwrap();
        let (m2, _) = merge(&bb, &ba).unwrap();
        assert_eq!(m1, m2, "bytes do not depend on the order");
        let merged = State::from_blob(&m1).unwrap().project();
        let text = merged["content"]["content"][0]["content"][0]["text"].as_str().unwrap().to_string();
        assert!(text.contains("HEY") && text.contains("bye") && text.contains("hello world"), "{text}");
        assert_eq!(merged["content"]["content"][1]["content"][0]["text"], "second!");
        // merging again changes nothing and is recognized as already contained
        let (again, equals) = merge(&m1, &m1).unwrap();
        assert_eq!(again, m1);
        assert!(equals);
        let (_, equals_a) = merge(&ba, &m1).unwrap();
        assert!(equals_a, "the merged state is the remote: nothing to upload");
        let (_, equals_b) = merge(&m1, &ba).unwrap();
        assert!(!equals_b, "local has more than the remote");
    }

    #[test]
    fn three_way_ingest_keeps_both_sides() {
        let ancestor = page(vec![p(1, "hello world"), p(2, "two")]);
        let theirs = State::from_page(PID, &ancestor).unwrap();
        theirs.ingest(&ancestor, &page(vec![p(1, "hello world!!"), p(2, "two")])).unwrap();
        // our local edit was made on the ancestor
        let mine = page(vec![p(1, "oh hello world"), p(2, "two"), p(3, "mine")]);
        theirs.ingest(&ancestor, &mine).unwrap();
        let out = theirs.project();
        assert_eq!(out["content"]["content"][0]["content"][0]["text"], "oh hello world!!");
        assert_eq!(out["content"]["content"][2]["content"][0]["text"], "mine");
    }

    #[test]
    fn two_blocks_with_one_id_are_kept_and_the_editor_can_rename_one() {
        // a paragraph with an inline atom is replaced as a whole: two devices editing it leave two elements with one id
        let atom = |a: &str, b: &str| json!({ "type": "paragraph", "attrs": { "blockId": bid(1) }, "content": [{ "type": "text", "text": a }, { "type": "hardBreak" }, { "type": "text", "text": b }] });
        let base = State::from_page(PID, &page(vec![atom("hello", "world"), p(2, "tail")])).unwrap();
        let blob = base.to_blob();
        let (a, b) = (fork(&blob), fork(&blob));
        a.ingest(&a.project(), &page(vec![atom("hello A", "world"), p(2, "tail")])).unwrap();
        b.ingest(&b.project(), &page(vec![atom("hello", "world B"), p(2, "tail")])).unwrap();
        let (m1, _) = merge(&a.to_blob(), &b.to_blob()).unwrap();
        let merged = State::from_blob(&m1).unwrap();
        let text = merged.project().to_string();
        assert!(text.contains("hello A") && text.contains("world B"), "both edits are in the merge: {text}");
        let kids = merged.project()["content"]["content"].as_array().unwrap().clone();
        assert_eq!(kids.iter().filter(|k| block_id(k) == Some(bid(1).as_str())).count(), 2, "the duplicate is there");
        // the editor repairs the duplicate (renames the second one) and saves
        let mut renamed = merged.project();
        renamed["content"]["content"][1]["attrs"]["blockId"] = Value::String(bid(9));
        merged.ingest(&merged.project(), &renamed).unwrap();
        let after = merged.project().to_string();
        assert!(after.contains("hello A") && after.contains("world B"), "nothing lost by the rename: {after}");
        same(&merged.project(), &renamed);
        // and everybody converges on it
        let (x, _) = merge(&merged.to_blob(), &a.to_blob()).unwrap();
        let (y, _) = merge(&a.to_blob(), &merged.to_blob()).unwrap();
        assert_eq!(x, y);
    }

    #[test]
    fn different_genesis_is_never_merged() {
        let (a, b) = (State::from_page(PID, &page(vec![p(1, "x")])).unwrap(), State::from_page(PID, &page(vec![p(1, "x")])).unwrap());
        assert_eq!(merge(&a.to_blob(), &b.to_blob()).unwrap_err(), "PAGE_STATE:genesis_differs");
        assert!(!same_genesis(&a.to_blob(), &b.to_blob()) && same_genesis(&a.to_blob(), &a.to_blob()));
    }

    #[test]
    fn header_errors_and_schema_gate() {
        let st = State::from_page(PID, &page(vec![p(1, "x")])).unwrap();
        let blob = st.to_blob();
        let h = check_blob(PID, &blob).unwrap();
        assert_eq!((h.schema_rev, h.flags), (SCHEMA_REV, 0));
        assert_eq!(check_blob("22222222-2222-4222-8222-222222222222", &blob).unwrap_err(), "PAGE_STATE:page_mismatch");
        assert!(decode_header(&blob[..20]).is_err() && decode_header(b"XXXX").is_err());
        let mut bad = blob.clone();
        bad[0] = b'X';
        assert_eq!(decode_header(&bad).unwrap_err(), "PAGE_STATE:bad_header");
        let mut trunc = blob.clone();
        trunc.pop();
        assert_eq!(decode_header(&trunc).unwrap_err(), "PAGE_STATE:bad_length");
        let mut enc = blob.clone();
        enc[5] = 1;
        assert!(decode_header(&enc).is_err());
        // a state from a newer client: ingest refuses, a byte level merge still works
        let mut newer = blob.clone();
        newer[6..8].copy_from_slice(&(SCHEMA_REV + 1).to_le_bytes());
        let ns = State::from_blob(&newer).unwrap();
        assert_eq!(ns.ingest(&ns.project(), &page(vec![p(1, "y")])).unwrap_err(), "PAGE_STATE:upgrade_required");
        let (m, _) = merge(&blob, &newer).unwrap();
        assert_eq!(decode_header(&m).unwrap().0.schema_rev, SCHEMA_REV + 1);
    }

    #[test]
    fn canonical_bytes_are_idempotent() {
        let st = State::from_page(PID, &page(vec![p(1, "abc"), p(2, "def")])).unwrap();
        st.ingest(&st.project(), &page(vec![p(1, "abXc")])).unwrap();
        let blob = st.to_blob();
        assert_eq!(State::from_blob(&blob).unwrap().to_blob(), blob);
    }

    #[test]
    fn migratable_pages_and_legacy_ids() {
        assert!(migratable(&page(vec![p(1, "x")])));
        assert!(!migratable(&json!({ "id": "x", "content": "a string" })));
        assert!(!migratable(&json!({ "id": "x", "content": { "type": "doc" }, "database": {} })));
        assert!(!migratable(&json!({ "id": "x", "kind": "folder", "content": { "type": "doc" } })));
        assert!(!migratable(&json!({ "content": { "type": "doc", "content": [{ "type": "paragraph", "extra": 1 }] } })));
        let mut c = json!({ "type": "doc", "content": [ { "type": "paragraph", "attrs": { "blockId": "b1_0" } }, { "type": "paragraph", "attrs": { "blockId": "b1_1" } }, { "type": "paragraph" } ] });
        assert!(assign_uuid_block_ids(&mut c));
        let ids: BTreeSet<&str> = c["content"].as_array().unwrap().iter().map(|n| n["attrs"]["blockId"].as_str().unwrap()).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids.iter().all(|i| !i.starts_with("b1_")));
    }
}
