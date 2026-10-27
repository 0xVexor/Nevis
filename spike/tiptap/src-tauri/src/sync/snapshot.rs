//! Provider-neutral, versioned snapshots. Absence is never a remote deletion.
use crate::vault::{err, write_atomic, Res, Vault};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub const MAX_FILE: usize = 95 * 1024 * 1024;
pub const MAX_SNAPSHOT: usize = 512 * 1024 * 1024;
pub type Files = BTreeMap<String, Vec<u8>>;
pub fn hash(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
pub fn canonical(v: &Value) -> Res<Vec<u8>> {
    serde_json::to_vec_pretty(v).map_err(err)
}
#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Snapshot {
    pub format: u32,
    pub vault: String,
    pub files: BTreeMap<String, String>,
    pub tombstones: BTreeSet<String>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Bundle {
    pub manifest: Snapshot,
    pub bytes: BTreeMap<String, String>,
}
impl Bundle {
    pub fn new(vault: &str, files: &Files, tombstones: BTreeSet<String>) -> Self {
        Self {
            manifest: Snapshot {
                format: 1,
                vault: vault.into(),
                files: files.iter().map(|(p, b)| (p.clone(), hash(b))).collect(),
                tombstones,
            },
            bytes: files
                .iter()
                .map(|(p, b)| (p.clone(), B64.encode(b)))
                .collect(),
        }
    }
    pub fn decode(&self) -> Res<Files> {
        if self.manifest.format != 1 {
            return Err("SYNC:unsupported_format".into());
        }
        let mut total = 0;
        let mut out = Files::new();
        let mut names = BTreeSet::new();
        for (p, h) in &self.manifest.files {
            safe_path(p)?;
            if !names.insert(p.to_ascii_lowercase()) {
                return Err("SYNC:path_collision".into());
            }
            if self.manifest.tombstones.contains(p) {
                return Err("SYNC:invalid_manifest".into());
            }
            let b = B64
                .decode(self.bytes.get(p).ok_or("SYNC:incomplete_snapshot")?)
                .map_err(err)?;
            total += b.len();
            if b.len() > MAX_FILE || total > MAX_SNAPSHOT {
                return Err("SYNC:too_large".into());
            }
            if &hash(&b) != h {
                return Err(format!("SYNC:hash_mismatch:{p}"));
            }
            validate(p, &b)?;
            out.insert(p.clone(), b);
        }
        for p in &self.manifest.tombstones {
            safe_path(p)?;
        }
        validate_references(&out)?;
        Ok(out)
    }
}
/// Explicit upload allowlist: no runtime, credentials, logs, temp files or arbitrary kv.
pub fn safe_path(p: &str) -> Res<()> {
    if p.contains('\\')
        || p.contains(':')
        || p.split('/')
            .any(|x| x.is_empty() || x == "." || x == ".." || x.starts_with('.'))
    {
        return Err("SYNC:unsafe_path".into());
    }
    if p.bytes()
        .any(|b| !b.is_ascii_alphanumeric() && !b"/_~.-".contains(&b))
    {
        return Err("SYNC:unsafe_path".into());
    }
    for part in p.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
            || part.ends_with('.')
        {
            return Err("SYNC:unsafe_path".into());
        }
    }
    let a: Vec<_> = p.split('/').collect();
    let allowed = match a.as_slice() {
        ["pages", f] => {
            f.ends_with(".json")
                && crate::vault::check_id(f.strip_suffix(".json").unwrap_or(f)).is_ok()
        }
        ["databases", kind, f] => {
            crate::database::KINDS.iter().any(|(_, d)| d == kind) && f.ends_with(".json")
        }
        ["files", prefix, f] => {
            let id = f.strip_suffix(".json").unwrap_or(f);
            id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) && *prefix == &id[..2]
        }
        ["kv", "settings.json" | "templates.json" | "tags.json" | "srs.json" | "reviewlog.json"
        | "savedSearches.json" | "tasksInbox.json" | "preferences.json" | "workspace.json"] => true,
        ["conflicts", f] => {
            f.ends_with(".json")
                && crate::vault::check_id(f.strip_suffix(".json").unwrap_or(f)).is_ok()
        }
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(format!("SYNC:unsafe_path:{p}"))
    }
}
pub fn validate(p: &str, bytes: &[u8]) -> Res<()> {
    if bytes.len() > MAX_FILE {
        return Err(format!("SYNC:too_large:{p}"));
    }
    if p.starts_with("files/") && !p.ends_with(".json") {
        if p.rsplit('/').next() != Some(hash(bytes).as_str()) {
            return Err(format!("SYNC:hash_mismatch:{p}"));
        }
    } else {
        let v: Value =
            serde_json::from_slice(bytes).map_err(|_| format!("SYNC:invalid_json:{p}"))?;
        if !v.is_object() && !p.starts_with("kv/") {
            return Err(format!("SYNC:invalid_entity:{p}"));
        }
        if p == "kv/preferences.json"
            && v.as_object().is_none_or(|o| {
                o.iter()
                    .any(|(k, v)| !preference_allowed(k) || (!v.is_string() && !v.is_null()))
            })
        {
            return Err("SYNC:invalid_preferences".into());
        }
        if p.starts_with("databases/") {
            let id = v["id"].as_str().ok_or("SYNC:invalid_record")?;
            if v["format"] != 1
                || p.rsplit('/').next()
                    != Some(format!("{}.json", crate::database::enc(id)?).as_str())
            {
                return Err(format!("SYNC:invalid_record:{p}"));
            }
        }
        if p.starts_with("pages/") {
            if v["id"].as_str()
                != p.strip_prefix("pages/")
                    .and_then(|s| s.strip_suffix(".json"))
                || !v["title"].is_string()
            {
                return Err(format!("SYNC:invalid_page:{p}"));
            }
            if v["content"].is_object() {
                validate_document(&v["content"])?;
            }
            if !v["content"].is_string() && v["content"]["type"] != "doc" && v["kind"] != "folder" {
                return Err(format!("SYNC:invalid_document:{p}"));
            }
        }
    }
    Ok(())
}
pub fn read(v: &Vault) -> Res<Files> {
    for p in [
        &v.root,
        &v.root.join(".noviq"),
        &v.root.join(".noviq/vault.json"),
    ] {
        if fs::symlink_metadata(p)
            .map_err(err)?
            .file_type()
            .is_symlink()
        {
            return Err("SYNC:symlink".into());
        }
    }
    let mut files = Files::new();
    let dead = tombstones(v)?;
    fn walk(
        root: &Path,
        dir: &Path,
        out: &mut Files,
        total: &mut usize,
        dead: &BTreeSet<String>,
    ) -> Res<()> {
        if !dir.exists() {
            return Ok(());
        }
        if fs::symlink_metadata(dir)
            .map_err(err)?
            .file_type()
            .is_symlink()
        {
            return Err("SYNC:symlink".into());
        }
        for e in fs::read_dir(dir).map_err(err)? {
            let e = e.map_err(err)?;
            let t = e.file_type().map_err(err)?;
            if t.is_symlink() {
                return Err("SYNC:symlink".into());
            }
            if t.is_dir() {
                walk(root, &e.path(), out, total, dead)?;
            } else {
                let p = e
                    .path()
                    .strip_prefix(root)
                    .map_err(err)?
                    .to_string_lossy()
                    .replace('\\', "/");
                if safe_path(&p).is_err() || dead.contains(&p) {
                    continue;
                }
                if e.metadata().map_err(err)?.len() > MAX_FILE as u64 {
                    return Err(format!("SYNC:too_large:{p}"));
                }
                let mut b = fs::read(e.path()).map_err(err)?;
                validate(&p, &b)?;
                if p.ends_with(".json") {
                    b = canonical(&serde_json::from_slice(&b).map_err(err)?)?;
                }
                *total += b.len();
                if *total > MAX_SNAPSHOT {
                    return Err("SYNC:too_large".into());
                }
                out.insert(p, b);
            }
        }
        Ok(())
    }
    let mut total = 0;
    for dir in ["pages", "files", "databases", "kv", "conflicts"] {
        walk(&v.root, &v.root.join(dir), &mut files, &mut total, &dead)?;
    }
    Ok(files)
}
/// Each metadata key merges independently; document content, arrays and database records remain indivisible.
fn merge_page(base: Option<&Vec<u8>>, local: &[u8], remote: &[u8]) -> Option<Vec<u8>> {
    let b: Value = serde_json::from_slice(base?).ok()?;
    let l: Value = serde_json::from_slice(local).ok()?;
    let r: Value = serde_json::from_slice(remote).ok()?;
    let keys: BTreeSet<_> = l
        .as_object()?
        .keys()
        .chain(r.as_object()?.keys())
        .chain(b.as_object()?.keys())
        .cloned()
        .collect();
    let mut out = serde_json::Map::new();
    for k in keys {
        let (bv, lv, rv) = (b.get(&k), l.get(&k), r.get(&k));
        let value = if lv == rv || rv == bv {
            lv
        } else if lv == bv {
            rv
        } else if k == "updatedAt" {
            if l[&k].as_f64()? > r[&k].as_f64()? {
                lv
            } else {
                rv
            }
        } else {
            return None;
        };
        if let Some(v) = value {
            out.insert(k, v.clone());
        }
    }
    canonical(&Value::Object(out)).ok()
}
pub fn reconcile(
    vault: &str,
    base: &Bundle,
    local_bundle: &Bundle,
    remote: &Bundle,
) -> Res<Bundle> {
    let local = local_bundle.decode()?;
    let b = base.decode()?;
    let r = remote.decode()?;
    let mut dead = BTreeSet::new();
    for path in base
        .manifest
        .tombstones
        .iter()
        .chain(remote.manifest.tombstones.iter())
        .chain(local_bundle.manifest.tombstones.iter())
        .collect::<BTreeSet<_>>()
    {
        let (b, l, r) = (
            base.manifest.tombstones.contains(path),
            local_bundle.manifest.tombstones.contains(path),
            remote.manifest.tombstones.contains(path),
        );
        let deleted = if l == r || r == b { l } else { r };
        if deleted {
            dead.insert(path.clone());
        }
    }
    // Disappearance alone is never proof of deletion. Only durable explicit tombstones propagate.
    let paths: BTreeSet<_> = b
        .keys()
        .chain(local.keys())
        .chain(r.keys())
        .cloned()
        .collect();
    let mut out = Files::new();
    for p in paths {
        let (bv, lv, rv) = (b.get(&p), local.get(&p), r.get(&p));
        if dead.contains(&p) {
            if p.starts_with("databases/") && (lv.is_some() && lv != bv || rv.is_some() && rv != bv)
            {
                let id = uuid::Uuid::new_v4().to_string();
                out.insert(format!("conflicts/{id}.json"),canonical(&json!({"id":id,"path":p,"createdAt":crate::vault::now_ms(),"deleted":true,"base":bv.map(|x|B64.encode(x)),"local":lv.map(|x|B64.encode(x)),"remote":rv.map(|x|B64.encode(x))}))?);
            }
            continue;
        }
        // Missing from an inventory without a tombstone is never permission to delete.
        let chosen = if lv == rv || rv == bv || rv.is_none() {
            lv.or(rv).cloned()
        } else if lv == bv || lv.is_none() {
            rv.cloned()
        } else if p.starts_with("pages/") || p.starts_with("kv/") {
            merge_page(bv, lv.unwrap(), rv.unwrap())
        } else {
            None
        };
        if let Some(v) = chosen {
            out.insert(p, v);
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            out.insert(format!("conflicts/{id}.json"), canonical(&json!({"id":id,"path":p,"createdAt":crate::vault::now_ms(),"base":bv.map(|x|B64.encode(x)),"local":lv.map(|x|B64.encode(x)),"remote":rv.map(|x|B64.encode(x))}))?);
            if let Some(v) = lv.or(rv) {
                out.insert(p, v.clone());
            }
        }
    }
    // A conflict must not offer a restore path for an entity permanently removed elsewhere.
    let obsolete: Vec<_> = out
        .iter()
        .filter_map(|(p, b)| {
            if !p.starts_with("conflicts/") {
                return None;
            }
            let v: Value = serde_json::from_slice(b).ok()?;
            v["path"]
                .as_str()
                .filter(|target| target.starts_with("pages/") && dead.contains(*target))
                .map(|_| p.clone())
        })
        .collect();
    for p in obsolete {
        out.remove(&p);
        dead.insert(p);
    }
    // An asset deletion cannot break an entity/conflict that remains in the agreed snapshot.
    for id in asset_ids(&out) {
        let path = format!("files/{}/{id}", &id[..2]);
        let meta = format!("{path}.json");
        if !out.contains_key(&path) {
            let bytes = local
                .get(&path)
                .or(r.get(&path))
                .or(b.get(&path))
                .ok_or_else(|| format!("SYNC:missing_attachment:{id}"))?;
            out.insert(path.clone(), bytes.clone());
        }
        if !out.contains_key(&meta) {
            let bytes = if let Some(bytes) = local.get(&meta).or(r.get(&meta)).or(b.get(&meta)) {
                bytes.clone()
            } else {
                canonical(
                    &json!({"id":id,"type":"application/octet-stream","size":out[&path].len(),"name":"","addedAt":0}),
                )?
            };
            out.insert(meta.clone(), bytes);
        }
        dead.remove(&path);
        dead.remove(&meta);
    }
    Ok(Bundle::new(vault, &out, dead))
}
#[derive(Serialize, Deserialize)]
struct Apply {
    before: Bundle,
    after: Bundle,
}
/// Durable redo journal. Call under the same vault lock used by all local writers.
pub fn apply(v: &Vault, before: &Bundle, after: &Bundle) -> Res<()> {
    if capture(v)?.manifest != before.manifest {
        return Err("SYNC:local_changed".into());
    }
    let journal = v.root.join(".noviq/snapshot-apply.json");
    write_atomic(
        &journal,
        &serde_json::to_vec(&Apply {
            before: before.clone(),
            after: after.clone(),
        })
        .map_err(err)?,
    )?;
    recover(v)
}
pub fn recover(v: &Vault) -> Res<()> {
    let p = v.root.join(".noviq/snapshot-apply.json");
    if !p.exists() {
        return Ok(());
    }
    let a: Apply = serde_json::from_slice(&fs::read(&p).map_err(err)?).map_err(err)?;
    if a.before.manifest.vault != v.id() || a.after.manifest.vault != v.id() {
        return Err("VAULT_MISMATCH".into());
    }
    let before = a.before.decode()?;
    let after = a.after.decode()?;
    // Validate every precondition before replaying any part of the journal.
    let current = read(v)?;
    for k in before.keys().chain(after.keys()).collect::<BTreeSet<_>>() {
        if current.get(k) != before.get(k) && current.get(k) != after.get(k) {
            return Err("SYNC:recovery_required".into());
        }
    }
    for (k, b) in &after {
        if current.get(k) != Some(b) {
            checked_parents(&v.root, k)?;
            write_atomic(&v.root.join(k), b)?;
        }
    }
    for k in before.keys().filter(|k| !after.contains_key(*k)) {
        checked_parents(&v.root, k)?;
        match fs::remove_file(v.root.join(k)) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(err(e)),
        }
    }
    if let Some(bytes) = after.get("kv/workspace.json") {
        let meta: Value = serde_json::from_slice(bytes).map_err(err)?;
        if let Some(name) = meta["name"].as_str() {
            v.rename(name)?;
        }
    }
    write_atomic(
        &v.root.join(".noviq/tombstones.json"),
        &serde_json::to_vec(&a.after.manifest.tombstones).map_err(err)?,
    )?;
    fs::remove_file(p).map_err(err)
}
pub fn checked_parents(root: &Path, p: &str) -> Res<()> {
    safe_path(p)?;
    let mut path = root.to_path_buf();
    for part in p.split('/') {
        path.push(part);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("SYNC:symlink".into());
        }
    }
    Ok(())
}
/// Full filesystem backup, including local autosave/database history; never uploads runtime or credentials.
pub fn backup(v: &Vault, dest: &Path) -> Res<()> {
    fn copy(root: &Path, dir: &Path, dest: &Path) -> Res<()> {
        if !dir.exists() {
            return Ok(());
        }
        for e in fs::read_dir(dir).map_err(err)? {
            let e = e.map_err(err)?;
            let p = e.path();
            let t = e.file_type().map_err(err)?;
            if t.is_symlink() {
                return Err("SYNC:symlink".into());
            }
            if t.is_dir() {
                copy(root, &p, dest)?;
            } else {
                let b = fs::read(&p).map_err(err)?;
                let target = dest.join(p.strip_prefix(root).map_err(err)?);
                write_atomic(&target, &b)?;
                if hash(&fs::read(target).map_err(err)?) != hash(&b) {
                    return Err("SYNC:backup_verification".into());
                }
            }
        }
        Ok(())
    }
    for d in [
        "pages",
        "files",
        "databases",
        "kv",
        "history",
        "conflicts",
        ".trash",
    ] {
        copy(&v.root, &v.root.join(d), dest)?;
    }
    write_atomic(
        &dest.join(".noviq/vault.json"),
        &fs::read(v.root.join(".noviq/vault.json")).map_err(err)?,
    )?;
    if v.root.join(".noviq/tombstones.json").exists() {
        write_atomic(
            &dest.join(".noviq/tombstones.json"),
            &fs::read(v.root.join(".noviq/tombstones.json")).map_err(err)?,
        )?;
    }
    write_atomic(
        &dest.join("BACKUP-COMPLETE.json"),
        &canonical(&json!({"format":1,"vault":v.id(),"createdAt":crate::vault::now_ms()}))?,
    )
}

pub fn capture(v: &Vault) -> Res<Bundle> {
    if fs::symlink_metadata(&v.root)
        .map_err(err)?
        .file_type()
        .is_symlink()
    {
        return Err("SYNC:symlink".into());
    }
    checked_parents(&v.root, "kv/workspace.json")?;
    let workspace = v.root.join("kv/workspace.json");
    let desired = canonical(&json!({"name":v.name()}))?;
    let existing = fs::read(&workspace)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if workspace.exists() && existing.is_none() {
        return Err("SYNC:invalid_workspace_metadata".into());
    }
    if existing.as_ref().and_then(|v| v["name"].as_str()) != Some(v.name().as_str()) {
        write_atomic(&workspace, &desired)?;
    }
    hydrate_assets(v)?;
    Ok(Bundle::new(&v.id(), &read(v)?, tombstones(v)?))
}
pub fn tombstone(v: &Vault, path: &str) -> Res<()> {
    safe_path(path)?;
    let mut dead = tombstones(v)?;
    dead.insert(path.into());
    let conflict_dir = v.root.join("conflicts");
    if conflict_dir.exists() {
        for e in fs::read_dir(&conflict_dir).map_err(err)? {
            let e = e.map_err(err)?;
            if e.file_type().map_err(err)?.is_symlink() {
                return Err("SYNC:symlink".into());
            }
            let b = fs::read(e.path()).map_err(err)?;
            let c: Value = serde_json::from_slice(&b).map_err(err)?;
            if c["path"].as_str() == Some(path) {
                let rel = format!("conflicts/{}", e.file_name().to_string_lossy());
                safe_path(&rel)?;
                dead.insert(rel);
                fs::remove_file(e.path()).map_err(err)?;
            }
        }
    }
    write_atomic(
        &v.root.join(".noviq/tombstones.json"),
        &serde_json::to_vec(&dead).map_err(err)?,
    )
}

pub fn tombstones(v: &Vault) -> Res<BTreeSet<String>> {
    match fs::read(v.root.join(".noviq/tombstones.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "SYNC:tombstones_corrupt".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(e) => Err(err(e)),
    }
}

pub fn restore_record(v: &Vault, path: &str) -> Res<()> {
    if !path.starts_with("databases/") {
        return Err("SYNC:permanently_deleted".into());
    }
    let mut dead = tombstones(v)?;
    if dead.remove(path) {
        write_atomic(
            &v.root.join(".noviq/tombstones.json"),
            &serde_json::to_vec(&dead).map_err(err)?,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn page(title: &str, body: &str) -> Vec<u8> {
        canonical(&json!({"id":"p","title":title,"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":body}]}]},"updatedAt":1,"tags":[],"database":{"sourceId":"source","values":{"x":1}}})).unwrap()
    }
    fn bundle(files: Files) -> Bundle {
        Bundle::new("v", &files, BTreeSet::new())
    }
    fn one(b: Vec<u8>) -> Bundle {
        bundle(BTreeMap::from([("pages/p.json".into(), b)]))
    }
    #[test]
    fn metadata_and_body_merge_independently() {
        let base = one(page("old", "body"));
        let local = one(page("renamed", "body"));
        let remote = one(page("old", "new body"));
        let out = reconcile("v", &base, &local, &remote)
            .unwrap()
            .decode()
            .unwrap();
        let p: Value = serde_json::from_slice(&out["pages/p.json"]).unwrap();
        assert_eq!(p["title"], "renamed");
        assert_eq!(p["content"]["content"][0]["content"][0]["text"], "new body");
        assert_eq!(p["database"]["values"]["x"], 1);
    }
    #[test]
    fn content_conflict_keeps_complete_three_versions() {
        let base = one(page("old", "base"));
        let local = one(page("old", "local"));
        let remote = one(page("old", "remote"));
        let out = reconcile("v", &base, &local, &remote)
            .unwrap()
            .decode()
            .unwrap();
        let c: Value = serde_json::from_slice(
            out.iter()
                .find(|(p, _)| p.starts_with("conflicts/"))
                .unwrap()
                .1,
        )
        .unwrap();
        for (side, bundle) in [("base", base), ("local", local), ("remote", remote)] {
            let bytes = B64.decode(c[side].as_str().unwrap()).unwrap();
            assert_eq!(bytes, bundle.decode().unwrap()["pages/p.json"]);
        }
    }
    #[test]
    fn absence_never_means_remote_delete() {
        let base = one(page("p", "base"));
        let missing = bundle(Files::new());
        assert!(reconcile("v", &base, &base, &missing)
            .unwrap()
            .manifest
            .files
            .contains_key("pages/p.json"));
        assert!(reconcile("v", &base, &missing, &base)
            .unwrap()
            .manifest
            .files
            .contains_key("pages/p.json"));
    }
    #[test]
    fn permanent_tombstone_blocks_offline_resurrection() {
        let base = one(page("p", "base"));
        let local = one(page("p", "offline edit"));
        let mut remote = bundle(Files::new());
        remote.manifest.tombstones.insert("pages/p.json".into());
        let merged = reconcile("v", &base, &local, &remote).unwrap();
        assert!(merged.decode().unwrap().is_empty());
        assert!(merged.manifest.tombstones.contains("pages/p.json"));
    }
    #[test]
    fn database_delete_edit_conflict_keeps_full_record_without_duplicate_id() {
        let p = "databases/sources/s.json";
        let b = canonical(&json!({"id":"s","format":1,"revision":1,"title":"base"})).unwrap();
        let l = canonical(&json!({"id":"s","format":1,"revision":2,"title":"edit"})).unwrap();
        let base = bundle(BTreeMap::from([(p.into(), b)]));
        let local = bundle(BTreeMap::from([(p.into(), l.clone())]));
        let mut remote = bundle(Files::new());
        remote.manifest.tombstones.insert(p.into());
        let out = reconcile("v", &base, &local, &remote)
            .unwrap()
            .decode()
            .unwrap();
        assert!(!out.contains_key(p));
        let c: Value = serde_json::from_slice(out.values().next().unwrap()).unwrap();
        assert_eq!(B64.decode(c["local"].as_str().unwrap()).unwrap(), l);
        assert_eq!(c["path"], p);
    }
    #[test]
    fn explicit_database_restore_can_clear_known_tombstone() {
        let p = "databases/sources/s.json";
        let mut base = bundle(Files::new());
        base.manifest.tombstones.insert(p.into());
        let local = bundle(BTreeMap::from([(
            p.into(),
            canonical(&json!({"id":"s","format":1,"revision":2})).unwrap(),
        )]));
        let merged = reconcile("v", &base, &local, &base).unwrap();
        assert!(merged.manifest.files.contains_key(p));
        assert!(!merged.manifest.tombstones.contains(p));
    }
    #[test]
    fn serializer_is_deterministic_and_layouts_are_lossless() {
        let a:Value=serde_json::from_str(r#"{"id":"p","title":"RTL","content":{"type":"doc","content":[{"type":"layoutGroup","attrs":{"widths":[40,60],"direction":"rtl"},"content":[{"type":"layoutColumn","content":[{"type":"paragraph"}]},{"type":"layoutColumn","content":[{"type":"paragraph"}]}]}]}}"#).unwrap();
        let bytes = canonical(&a).unwrap();
        validate("pages/p.json", &bytes).unwrap();
        assert_eq!(
            canonical(&serde_json::from_slice(&bytes).unwrap()).unwrap(),
            bytes
        );
    }
    #[test]
    fn hash_and_path_validation_fail_closed() {
        for p in [
            "../secrets",
            "pages/../account.json",
            "kv/token.json",
            "files/aa/not-a-hash",
            "pages/CON.json",
            "pages/a\\b.json",
            "databases/sources/a:secret.json",
        ] {
            assert!(safe_path(p).is_err(), "{p}");
        }
        let mut b = one(page("p", "body"));
        b.bytes.insert("pages/p.json".into(), B64.encode(b"{}"));
        assert!(b.decode().is_err());
        assert!(validate(
            "files/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            b"GIF89a"
        )
        .is_err());
    }
    fn vault() -> Vault {
        let root = std::env::temp_dir().join(format!("snapshot-test-{}", uuid::Uuid::new_v4()));
        Vault::create_with_id(root, "test", "v").unwrap()
    }
    #[test]
    fn apply_refuses_edit_during_network() {
        let v = vault();
        let before = capture(&v).unwrap();
        let after = one(page("remote", "body"));
        write_atomic(&v.root.join("pages/p.json"), &page("local", "body")).unwrap();
        assert_eq!(
            apply(&v, &before, &after).unwrap_err(),
            "SYNC:local_changed"
        );
        assert_eq!(read(&v).unwrap()["pages/p.json"], page("local", "body"));
        fs::remove_dir_all(v.root).unwrap();
    }
    #[test]
    fn journal_replays_partial_application_and_remains_on_newer_edits() {
        let v = vault();
        let before = capture(&v).unwrap();
        let after = one(page("remote", "body"));
        let p = v.root.join(".noviq/snapshot-apply.json");
        write_atomic(
            &p,
            &serde_json::to_vec(&Apply {
                before: before.clone(),
                after: after.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        recover(&v).unwrap();
        assert_eq!(read(&v).unwrap(), after.decode().unwrap());
        write_atomic(&p, &serde_json::to_vec(&Apply { before, after }).unwrap()).unwrap();
        write_atomic(&v.root.join("pages/p.json"), &page("new edit", "body")).unwrap();
        assert!(recover(&v).is_err());
        assert!(p.exists());
        fs::remove_dir_all(v.root).unwrap();
    }
    #[test]
    fn unreadable_json_is_not_a_missing_page() {
        let v = vault();
        write_atomic(&v.root.join("pages/p.json"), b"not json").unwrap();
        assert!(read(&v).is_err());
        assert!(v.pages_all().is_err());
        fs::remove_dir_all(v.root).unwrap();
    }
    #[test]
    fn stale_deleted_bytes_cannot_reappear_in_ui_or_snapshot() {
        let v = vault();
        write_atomic(&v.root.join("pages/p.json"), &page("old", "body")).unwrap();
        tombstone(&v, "pages/p.json").unwrap();
        assert!(v.pages_all().unwrap().is_empty());
        assert!(!capture(&v)
            .unwrap()
            .manifest
            .files
            .contains_key("pages/p.json"));
        fs::remove_dir_all(v.root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlink_root_is_rejected() {
        let v = vault();
        fs::remove_dir(v.root.join("files")).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), v.root.join("files")).unwrap();
        assert!(read(&v).is_err());
        fs::remove_dir_all(v.root).unwrap();
    }
}

fn validate_document(v: &Value) -> Res<()> {
    fn node(v: &Value, depth: usize, parent: &str) -> Res<()> {
        if depth > 128 || !v["type"].is_string() {
            return Err("SYNC:invalid_document".into());
        }
        let kind = v["type"].as_str().unwrap_or("");
        if let Some(c) = v.get("content") {
            let children = c.as_array().ok_or("SYNC:invalid_document")?;
            if kind == "layoutGroup" {
                if parent != "doc"
                    || ![2, 3].contains(&children.len())
                    || children.iter().any(|n| n["type"] != "layoutColumn")
                {
                    return Err("SYNC:invalid_layout".into());
                }
                if let Some(widths) = v["attrs"].get("widths").filter(|w| !w.is_null()) {
                    let widths = widths.as_array().ok_or("SYNC:invalid_layout")?;
                    if widths.len() != children.len()
                        || widths
                            .iter()
                            .any(|w| w.as_f64().is_none_or(|n| !n.is_finite() || n <= 0.0))
                    {
                        return Err("SYNC:invalid_layout".into());
                    }
                }
            }
            if kind == "layoutColumn" && parent != "layoutGroup" {
                return Err("SYNC:invalid_layout".into());
            }
            for child in children {
                node(child, depth + 1, kind)?;
            }
        }
        if let Some(marks) = v.get("marks") {
            if marks
                .as_array()
                .is_none_or(|m| m.iter().any(|m| !m["type"].is_string()))
            {
                return Err("SYNC:invalid_document".into());
            }
        }
        Ok(())
    }
    if v["type"] != "doc" {
        return Err("SYNC:invalid_document".into());
    }
    node(v, 0, "")
}

/// Explicit resolution never drops an edit made after the archived versions were captured.
pub fn resolve_conflict(v: &Vault, id: &str, choice: &str) -> Res<()> {
    crate::vault::check_id(id)?;
    if !["local", "remote", "base", "delete"].contains(&choice) {
        return Err("SYNC:invalid_choice".into());
    }
    let path = format!("conflicts/{id}.json");
    let before = capture(v)?;
    let mut files = before.decode()?;
    let conflict: Value =
        serde_json::from_slice(files.get(&path).ok_or("SYNC:conflict_missing")?).map_err(err)?;
    let target = conflict["path"].as_str().ok_or("SYNC:invalid_conflict")?;
    safe_path(target)?;
    if before.manifest.tombstones.contains(target) && target.starts_with("pages/") {
        return Err("SYNC:permanently_deleted".into());
    }
    let selected = if choice == "delete" {
        None
    } else {
        let bytes = B64
            .decode(
                conflict[choice]
                    .as_str()
                    .ok_or("SYNC:version_unavailable")?,
            )
            .map_err(err)?;
        validate(target, &bytes)?;
        Some(bytes)
    };
    if let Some(current) = files.get(target) {
        let normalized = |bytes: &[u8]| -> Vec<u8> {
            serde_json::from_slice::<Value>(bytes)
                .ok()
                .and_then(|v| canonical(&v).ok())
                .unwrap_or_else(|| bytes.to_vec())
        };
        let represented = ["local", "remote", "base"].iter().any(|side| {
            conflict[side]
                .as_str()
                .and_then(|b| B64.decode(b).ok())
                .is_some_and(|b| normalized(&b) == normalized(current))
        });
        if !represented && !(choice == "delete" && target.starts_with("pages/")) {
            let fresh = uuid::Uuid::new_v4().to_string();
            let archive = json!({"id":fresh,"path":target,"createdAt":crate::vault::now_ms(),"deleted":selected.is_none(),"base":conflict["local"],"local":B64.encode(current),"remote":selected.as_ref().map(|b|B64.encode(b))});
            files.insert(format!("conflicts/{fresh}.json"), canonical(&archive)?);
        }
    }
    let mut dead = before.manifest.tombstones.clone();
    if let Some(bytes) = selected {
        files.insert(target.into(), bytes);
        dead.remove(target);
    } else {
        files.remove(target);
        dead.insert(target.into());
    }
    files.remove(&path);
    dead.insert(path);
    apply(v, &before, &Bundle::new(&v.id(), &files, dead))
}

#[cfg(test)]
mod resolution_tests {
    use super::*;
    #[test]
    fn newer_full_entity_survives_explicit_resolution_and_id_is_unchanged() {
        let root = std::env::temp_dir().join(format!("resolve-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create_with_id(root, "test", "v").unwrap();
        let page = |title: &str| {
            canonical(&json!({"id":"p","title":title,"content":{"type":"doc","content":[]},"database":{"values":{"important":"kept"}}})).unwrap()
        };
        write_atomic(&v.root.join("pages/p.json"), &page("newer local edit")).unwrap();
        let c = json!({"id":"c","path":"pages/p.json","local":B64.encode(page("archived local")),"remote":B64.encode(page("remote")),"base":null});
        write_atomic(&v.root.join("conflicts/c.json"), &canonical(&c).unwrap()).unwrap();
        resolve_conflict(&v, "c", "remote").unwrap();
        let out = read(&v).unwrap();
        let current: Value = serde_json::from_slice(&out["pages/p.json"]).unwrap();
        assert_eq!(current["id"], "p");
        assert_eq!(current["title"], "remote");
        let archive: Value = serde_json::from_slice(
            out.iter()
                .find(|(p, _)| p.starts_with("conflicts/"))
                .unwrap()
                .1,
        )
        .unwrap();
        let preserved: Value =
            serde_json::from_slice(&B64.decode(archive["local"].as_str().unwrap()).unwrap())
                .unwrap();
        assert_eq!(preserved["title"], "newer local edit");
        assert_eq!(preserved["database"]["values"]["important"], "kept");
        fs::remove_dir_all(v.root).unwrap();
    }
}

fn preference_allowed(key: &str) -> bool {
    [
        "not.settings",
        "not.reader.cfg",
        "not.page.width",
        "not.sideW",
        "not.side",
        "not.panel.v2",
        "not.explorer.mode",
        "not.db.weekStart",
        "not.db.map",
        "not.db.gateway",
        "not.drawing.library",
    ]
    .contains(&key)
        || key.strip_prefix("db.personal.").is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
}
/// Compare-and-merge a settings cache write against the latest durable vault value.
/// The editor's settings cache is not permitted to blindly replace preferences received during HTTP work.
pub fn save_preferences(v: &Vault, base: &Value, next: &Value) -> Res<Value> {
    for value in [base, next] {
        if value.as_object().is_none_or(|o| {
            o.iter()
                .any(|(k, v)| !preference_allowed(k) || (!v.is_string() && !v.is_null()))
        }) {
            return Err("SYNC:invalid_preferences".into());
        }
    }
    let path = v.root.join("kv/preferences.json");
    checked_parents(&v.root, "kv/preferences.json")?;
    let remote: Value = match fs::read(&path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "SYNC:invalid_preferences")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(err(e)),
    };
    fn unpack(v: &Value) -> Value {
        if let Some(s) = v.as_str() {
            serde_json::from_str(s).unwrap_or_else(|_| v.clone())
        } else {
            v.clone()
        }
    }
    fn merge(b: &Value, l: &Value, r: &Value, conflict: &mut bool) -> Value {
        if l == r || b == r {
            return l.clone();
        }
        if b == l {
            return r.clone();
        }
        if let (Some(l), Some(r)) = (l.as_object(), r.as_object()) {
            let keys: BTreeSet<_> = l
                .keys()
                .chain(r.keys())
                .chain(b.as_object().into_iter().flat_map(|o| o.keys()))
                .cloned()
                .collect();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(
                    k.clone(),
                    merge(
                        &b[&k],
                        l.get(&k).unwrap_or(&Value::Null),
                        r.get(&k).unwrap_or(&Value::Null),
                        conflict,
                    ),
                );
            }
            return Value::Object(out);
        }
        *conflict = true;
        l.clone()
    }
    let mut conflict = false;
    let (Some(b), Some(l), Some(r)) = (base.as_object(), next.as_object(), remote.as_object())
    else {
        return Err("SYNC:invalid_preferences".into());
    };
    let keys: BTreeSet<_> = b.keys().chain(l.keys()).chain(r.keys()).cloned().collect();
    let mut out = serde_json::Map::new();
    for key in keys {
        let value = merge(
            &unpack(&base[&key]),
            &unpack(&next[&key]),
            &unpack(&remote[&key]),
            &mut conflict,
        );
        let encoded = if value.is_null() || value.is_string() {
            value
        } else {
            Value::String(serde_json::to_string(&value).map_err(err)?)
        };
        out.insert(key, encoded);
    }
    let merged = Value::Object(out);
    if conflict {
        let id = uuid::Uuid::new_v4().to_string();
        let c = json!({"id":id,"path":"kv/preferences.json","createdAt":crate::vault::now_ms(),"base":B64.encode(canonical(base)?),"local":B64.encode(canonical(next)?),"remote":B64.encode(canonical(&remote)?)});
        write_atomic(
            &v.root.join("conflicts").join(format!("{id}.json")),
            &canonical(&c)?,
        )?;
    }
    write_atomic(&path, &canonical(&merged)?)?;
    Ok(merged)
}

#[cfg(test)]
mod preference_tests {
    use super::*;
    #[test]
    fn settings_fields_merge_with_a_new_remote_preference_and_archive_same_field_conflicts() {
        let root = std::env::temp_dir().join(format!("preferences-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(root, "test").unwrap();
        let base = json!({"not.settings":"{\"theme\":\"light\",\"lang\":\"en\"}"});
        let remote = json!({"not.settings":"{\"theme\":\"light\",\"lang\":\"fa\"}"});
        write_atomic(
            &v.root.join("kv/preferences.json"),
            &canonical(&remote).unwrap(),
        )
        .unwrap();
        let local = json!({"not.settings":"{\"theme\":\"dark\",\"lang\":\"en\"}"});
        let merged = save_preferences(&v, &base, &local).unwrap();
        let prefs: Value = serde_json::from_str(merged["not.settings"].as_str().unwrap()).unwrap();
        assert_eq!(prefs["theme"], "dark");
        assert_eq!(prefs["lang"], "fa");
        let local = json!({"not.settings":"{\"theme\":\"system\",\"lang\":\"en\"}"});
        save_preferences(&v, &base, &local).unwrap();
        assert!(read(&v)
            .unwrap()
            .keys()
            .any(|p| p.starts_with("conflicts/")));
        fs::remove_dir_all(v.root).unwrap();
    }
}

/// Read/modify/write clients supply the value their edit started from. Durable remote changes are never blindly lost.
pub fn save_user_kv(v: &Vault, key: &str, base: &Value, next: &Value) -> Res<Value> {
    if ![
        "srs",
        "reviewlog",
        "savedSearches",
        "tasksInbox",
        "templates",
        "tags",
    ]
    .contains(&key)
    {
        return Err("SYNC:invalid_user_setting".into());
    }
    let relative = format!("kv/{key}.json");
    checked_parents(&v.root, &relative)?;
    let path = v.root.join(&relative);
    let remote: Value = match fs::read(&path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "STORAGE:unreadable_setting")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(err(e)),
    };
    let mut conflict = false;
    let merged = if next == &remote || base == &remote {
        next.clone()
    } else if base == next {
        remote.clone()
    } else if let (Some(local), Some(remote_map)) = (next.as_object(), remote.as_object()) {
        let mut map = serde_json::Map::new();
        let keys: BTreeSet<_> = local
            .keys()
            .chain(remote_map.keys())
            .chain(base.as_object().into_iter().flat_map(|b| b.keys()))
            .cloned()
            .collect();
        for k in keys {
            let (b, l, r) = (&base[&k], &next[&k], &remote[&k]);
            let value = if l == r || b == r {
                l
            } else if b == l {
                r
            } else {
                conflict = true;
                l
            };
            if !value.is_null() {
                map.insert(k, value.clone());
            }
        }
        Value::Object(map)
    } else {
        conflict = true;
        next.clone()
    };
    if conflict {
        let id = uuid::Uuid::new_v4().to_string();
        let c = json!({"id":id,"path":relative,"createdAt":crate::vault::now_ms(),"base":B64.encode(canonical(base)?),"local":B64.encode(canonical(next)?),"remote":B64.encode(canonical(&remote)?)});
        write_atomic(
            &v.root.join("conflicts").join(format!("{id}.json")),
            &canonical(&c)?,
        )?;
    }
    write_atomic(&path, &canonical(&merged)?)?;
    Ok(merged)
}

#[cfg(test)]
mod user_kv_tests {
    use super::*;
    #[test]
    fn stale_study_cache_keeps_other_device_records_and_same_card_versions() {
        let root = std::env::temp_dir().join(format!("userkv-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(root, "test").unwrap();
        let base = json!({"one":{"due":1}});
        let remote = json!({"one":{"due":1},"remote":{"due":20}});
        write_atomic(&v.root.join("kv/srs.json"), &canonical(&remote).unwrap()).unwrap();
        let next = json!({"one":{"due":10}});
        let merged = save_user_kv(&v, "srs", &base, &next).unwrap();
        assert_eq!(merged["one"]["due"], 10);
        assert_eq!(merged["remote"]["due"], 20);
        let newer = json!({"one":{"due":30}});
        let merged = save_user_kv(&v, "srs", &next, &newer).unwrap();
        assert_eq!(merged["remote"]["due"], 20);
        save_user_kv(&v, "srs", &base, &json!({"one":{"due":40}})).unwrap();
        assert!(read(&v)
            .unwrap()
            .keys()
            .any(|p| p.starts_with("conflicts/")));
        fs::remove_dir_all(v.root).unwrap();
    }
}

fn asset_ids(files: &Files) -> BTreeSet<String> {
    fn id(s: &str) -> bool {
        s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
    }
    fn visit(v: &Value, out: &mut BTreeSet<String>, depth: usize) {
        if depth > 128 {
            return;
        }
        match v {
            Value::String(s) => {
                for part in s.split("att:").skip(1) {
                    if let Some(prefix) = part.get(..64).filter(|s| id(s)) {
                        out.insert(prefix.into());
                    }
                }
            }
            Value::Array(values) => {
                for v in values {
                    visit(v, out, depth + 1)
                }
            }
            Value::Object(map) => {
                for (key, value) in map {
                    if ["scene", "preview", "file"].contains(&key.as_str()) {
                        if let Some(s) = value.as_str().filter(|s| id(s)) {
                            out.insert(s.into());
                        }
                    }
                    if key == "attachmentIds" {
                        if let Some(ids) = value.as_array() {
                            for s in ids.iter().filter_map(Value::as_str).filter(|s| id(s)) {
                                out.insert(s.into());
                            }
                        }
                    }
                    visit(value, out, depth + 1);
                }
            }
            _ => (),
        }
    }
    let mut out = BTreeSet::new();
    for (path, bytes) in files {
        if path.starts_with("files/") {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<Value>(bytes) {
            visit(&v, &mut out, 0);
            if path.starts_with("conflicts/") {
                for side in ["base", "local", "remote"] {
                    if let Some(b) = v[side].as_str().and_then(|s| B64.decode(s).ok()) {
                        if let Ok(value) = serde_json::from_slice::<Value>(&b) {
                            visit(&value, &mut out, 0);
                        }
                    }
                }
            }
        }
    }
    out
}
fn validate_references(files: &Files) -> Res<()> {
    for id in asset_ids(files) {
        if !files.contains_key(&format!("files/{}/{id}", &id[..2])) {
            return Err(format!("SYNC:missing_attachment:{id}"));
        }
    }
    Ok(())
}
pub fn restore_asset(v: &Vault, id: &str) -> Res<()> {
    let path = format!("files/{}/{id}", id.get(..2).ok_or("FILE:bad_id")?);
    safe_path(&path)?;
    let mut dead = tombstones(v)?;
    let removed = dead.remove(&path) | dead.remove(&format!("{path}.json"));
    if removed {
        write_atomic(
            &v.root.join(".noviq/tombstones.json"),
            &serde_json::to_vec(&dead).map_err(err)?,
        )?;
    }
    Ok(())
}
/// Old clients could have collected assets that are still referenced by drawings/database cells/history.
/// Recover referenced bytes from local file trash before establishing a new provider's snapshot.
fn hydrate_assets(v: &Vault) -> Res<()> {
    let files = read(v)?;
    for id in asset_ids(&files) {
        let relative = format!("files/{}/{id}", &id[..2]);
        if files.contains_key(&relative) && files.contains_key(&format!("{relative}.json")) {
            continue;
        }
        let source = if v.root.join(&relative).is_file() {
            v.root.join(&relative)
        } else {
            v.root.join(".trash/files").join(&id)
        };
        if fs::symlink_metadata(&source).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("SYNC:symlink".into());
        }
        let bytes = fs::read(source).map_err(|_| format!("SYNC:missing_attachment:{id}"))?;
        if hash(&bytes) != id {
            return Err("SYNC:hash_mismatch".into());
        }
        let mime = if bytes.starts_with(b"GIF8") {
            "image/gif"
        } else if bytes.starts_with(b"\x89PNG") {
            "image/png"
        } else if bytes.starts_with(b"\xff\xd8") {
            "image/jpeg"
        } else if bytes.starts_with(b"RIFF") {
            "image/webp"
        } else if bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") {
            "image/svg+xml"
        } else if serde_json::from_slice::<Value>(&bytes).is_ok() {
            "application/json"
        } else {
            "application/octet-stream"
        };
        v.file_put(&id, &bytes, mime, "", crate::vault::now_ms())?;
    }
    Ok(())
}

#[cfg(test)]
mod asset_tests {
    use super::*;
    #[test]
    fn gif_in_old_trash_is_recovered_for_drawing_and_database_references() {
        let root = std::env::temp_dir().join(format!("assets-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(root, "test").unwrap();
        let bytes = b"GIF89a\0animated\x21\xf9";
        let id = hash(bytes);
        write_atomic(&v.root.join(".trash/files").join(&id), bytes).unwrap();
        let page = json!({"id":"p","title":"drawing","content":{"type":"doc","content":[{"type":"drawing","attrs":{"scene":id,"preview":""}}]},"database":{"values":{"attachments":{"kind":"files","attachmentIds":[id]}}}});
        write_atomic(&v.root.join("pages/p.json"), &canonical(&page).unwrap()).unwrap();
        let b = capture(&v).unwrap();
        assert_eq!(
            b.decode().unwrap()[&format!("files/{}/{id}", &id[..2])],
            bytes
        );
        assert_eq!(v.file_get(&id).unwrap(), bytes);
        assert!(v.root.join(format!("files/{}/{id}", &id[..2])).is_file());
        fs::remove_dir_all(v.root).unwrap();
    }
    #[test]
    fn missing_referenced_attachment_rejects_a_complete_but_inconsistent_remote() {
        let page=canonical(&json!({"id":"p","title":"image","content":{"type":"doc","content":[{"type":"image","attrs":{"src":format!("att:{}","a".repeat(64))}}]}})).unwrap();
        let b = Bundle::new(
            "v",
            &BTreeMap::from([("pages/p.json".into(), page)]),
            BTreeSet::new(),
        );
        assert!(b
            .decode()
            .unwrap_err()
            .starts_with("SYNC:missing_attachment:"));
    }
}

#[cfg(test)]
mod asset_merge_tests {
    use super::*;
    #[test]
    fn deletion_of_an_asset_cannot_break_a_new_offline_reference() {
        let bytes = b"GIF89aanimated";
        let id = hash(bytes);
        let asset = format!("files/{}/{id}", &id[..2]);
        let meta = format!("{asset}.json");
        let page = |id: &str, src: &str| {
            canonical(&json!({"id":id,"title":"image","content":{"type":"doc","content":[{"type":"image","attrs":{"src":src}}]}})).unwrap()
        };
        let mut base_files = Files::from([
            ("pages/p.json".into(), page("p", &format!("att:{id}"))),
            (asset.clone(), bytes.to_vec()),
            (
                meta.clone(),
                canonical(&json!({"id":id,"type":"image/gif"})).unwrap(),
            ),
        ]);
        let base = Bundle::new("v", &base_files, BTreeSet::new());
        base_files.insert("pages/q.json".into(), page("q", &format!("att:{id}")));
        let local = Bundle::new("v", &base_files, BTreeSet::new());
        let remote = Bundle::new(
            "v",
            &Files::from([(
                "pages/p.json".into(),
                page("p", "https://example.com/image.png"),
            )]),
            BTreeSet::from([asset.clone(), meta]),
        );
        let merged = reconcile("v", &base, &local, &remote).unwrap();
        assert_eq!(merged.decode().unwrap()[&asset], bytes);
        assert!(!merged.manifest.tombstones.contains(&asset));
    }
}
