//! Drive-only filesystem boundary. Media is spooled by hash; JSON remains bounded and validated.
use super::{
    core::bytes,
    snapshot::{self, Bundle, Files},
};
use crate::vault::{err, write_atomic, Res, Vault};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
#[derive(Clone, PartialEq)]
struct Stamp {
    len: u64,
    modified: std::time::SystemTime,
    created: Option<std::time::SystemTime>,
    identity: Option<(u64, u64)>,
}
fn stamp(path: &Path) -> Res<Stamp> {
    let m = fs::symlink_metadata(path).map_err(err)?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err("SYNC:symlink".into());
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        Some((m.dev(), m.ino()))
    };
    #[cfg(not(unix))]
    let identity = None;
    Ok(Stamp {
        len: m.len(),
        modified: m.modified().map_err(err)?,
        created: m.created().ok(),
        identity,
    })
}
struct Verified {
    stamp: Stamp,
    digest: String,
    at: std::time::Instant,
}
static VERIFIED: std::sync::OnceLock<std::sync::Mutex<BTreeMap<PathBuf, Verified>>> =
    std::sync::OnceLock::new();
fn remember(path: &Path, stamp: Stamp, digest: String) {
    if let Ok(mut cache) = VERIFIED.get_or_init(Default::default).lock() {
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(
            path.to_path_buf(),
            Verified {
                stamp,
                digest,
                at: std::time::Instant::now(),
            },
        );
    }
}
/// Local immutable-cache acceleration only. Incoming network bytes are always hashed independently.
/// Metadata-preserving malicious local writes require an explicit deep check; this is not a local-author signature.
pub fn clear_verification_cache() {
    if let Ok(mut cache) = VERIFIED.get_or_init(Default::default).lock() {
        cache.clear();
    }
}
pub fn file_hash(path: &Path) -> Res<String> {
    let before = stamp(path)?;
    if let Ok(cache) = VERIFIED.get_or_init(Default::default).lock() {
        if let Some(verified) = cache.get(path) {
            if verified.stamp == before
                && verified.at.elapsed() < std::time::Duration::from_secs(24 * 3600)
            {
                return Ok(verified.digest.clone());
            }
        }
    }
    let mut file = fs::File::open(path).map_err(err)?;
    let mut h = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        h.update(&buffer[..n]);
    }
    let after = stamp(path)?;
    if after != before {
        return Err("DRIVE:source_changed".into());
    }
    let digest = format!("{:x}", h.finalize());
    remember(path, after, digest.clone());
    Ok(digest)
}
/// Verified fsync + atomic rename, with at most 64 KiB of media in the copy buffer.
pub fn copy_verified(source: &Path, target: &Path, expected: &str) -> Res<()> {
    if file_hash(source)? != expected {
        return Err("DRIVE:integrity".into());
    }
    let parent = target.parent().ok_or("DRIVE:invalid_path")?;
    fs::create_dir_all(parent).map_err(err)?;
    let temp = parent.join(format!(".drive-copy-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut input = fs::File::open(source).map_err(err)?;
        let mut output = fs::File::create(&temp).map_err(err)?;
        let mut h = Sha256::new();
        let mut buf = [0; 64 * 1024];
        loop {
            let n = input.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n]).map_err(err)?;
            h.update(&buf[..n]);
        }
        if format!("{:x}", h.finalize()) != expected {
            return Err("DRIVE:source_changed".into());
        }
        output.sync_all().map_err(err)?;
        drop(output);
        fs::rename(&temp, target).map_err(err)?;
        remember(target, stamp(target)?, expected.to_string());
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(err)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn mime_type(path: &Path) -> Res<&'static str> {
    let mut file = fs::File::open(path).map_err(err)?;
    let mut prefix = [0; 512];
    let n = file.read(&mut prefix).map_err(err)?;
    let p = &prefix[..n];
    Ok(if p.starts_with(b"GIF8") {
        "image/gif"
    } else if p.starts_with(b"\x89PNG") {
        "image/png"
    } else if p.starts_with(b"\xff\xd8") {
        "image/jpeg"
    } else if p.starts_with(b"RIFF") {
        "image/webp"
    } else if p.starts_with(b"<svg") || p.starts_with(b"<?xml") {
        "image/svg+xml"
    } else if p.starts_with(b"{") || p.starts_with(b"[") {
        "application/json"
    } else {
        "application/octet-stream"
    })
}
fn scan(v: &Vault, cache: &Path, validate: bool) -> Res<Bundle> {
    v.ensure_exclusive()?;
    fn walk(
        v: &Vault,
        dir: &Path,
        cache: &Path,
        files: &mut Files,
        sources: &mut BTreeMap<String, PathBuf>,
        hashes: &mut BTreeMap<String, String>,
        dead: &BTreeSet<String>,
        total: &mut usize,
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
            let path = e.path();
            let kind = e.file_type().map_err(err)?;
            if kind.is_symlink() {
                return Err("SYNC:symlink".into());
            }
            if kind.is_dir() {
                walk(v, &path, cache, files, sources, hashes, dead, total)?;
                continue;
            }
            let rel = path
                .strip_prefix(&v.root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/");
            if snapshot::safe_path(&rel).is_err() || dead.contains(&rel) {
                continue;
            }
            if rel.starts_with("files/") && !rel.ends_with(".json") {
                let h = file_hash(&path)?;
                let filename = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or("FILE:bad_id")?;
                if h != filename {
                    return Err("DRIVE:integrity".into());
                }
                let destination = cache.join(&h);
                if !destination.exists() {
                    copy_verified(&path, &destination, &h)?;
                } else if file_hash(&destination)? != h {
                    return Err("DRIVE:integrity".into());
                }
                hashes.insert(rel.clone(), h);
                sources.insert(rel, destination);
            } else {
                if e.metadata().map_err(err)?.len() > snapshot::MAX_FILE as u64 {
                    return Err("SYNC:too_large".into());
                }
                let raw = fs::read(&path).map_err(err)?;
                snapshot::validate(&rel, &raw)?;
                let canonical =
                    snapshot::canonical(&serde_json::from_slice::<Value>(&raw).map_err(err)?)?;
                *total += canonical.len();
                if *total > snapshot::MAX_SNAPSHOT {
                    return Err("SYNC:too_large".into());
                }
                files.insert(rel, canonical);
            }
        }
        Ok(())
    }
    let dead = snapshot::tombstones(v)?;
    let mut files = Files::new();
    let mut sources = BTreeMap::new();
    let mut hashes = BTreeMap::new();
    let mut total = 0;
    for kind in ["pages", "files", "databases", "kv", "conflicts"] {
        walk(
            v,
            &v.root.join(kind),
            cache,
            &mut files,
            &mut sources,
            &mut hashes,
            &dead,
            &mut total,
        )?;
    }
    // Recover old referenced assets from the local trash without loading their bodies.
    let mut repaired = false;
    for id in if validate {
        snapshot::asset_ids(&files)
    } else {
        BTreeSet::new()
    } {
        let rel = format!("files/{}/{id}", &id[..2]);
        if !sources.contains_key(&rel) {
            let source = v.root.join(".trash/files").join(&id);
            if !source.is_file() {
                return Err(format!("SYNC:missing_attachment:{id}"));
            }
            snapshot::checked_parents(&v.root, &rel)?;
            copy_verified(&source, &v.root.join(&rel), &id)?;
            snapshot::restore_asset(v, &id)?;
            repaired = true;
        }
        let metadata = format!("{rel}.json");
        if !files.contains_key(&metadata) {
            write_atomic(
                &v.root.join(&metadata),
                &bytes(
                    &json!({"id":id,"type":mime_type(&v.root.join(&rel))?,"size":fs::metadata(v.root.join(&rel)).map_err(err)?.len(),"name":"","addedAt":0}),
                )?,
            )?;
            repaired = true;
        }
    }
    if repaired {
        return scan(v, cache, validate);
    }
    let mut bundle = Bundle::new(&v.id(), &files, dead);
    bundle.sources = sources;
    bundle.manifest.files.extend(hashes);
    if validate {
        bundle.decode_metadata()?;
        super::database::validate(&files)?;
    }
    Ok(bundle)
}
pub fn capture(v: &Vault, state: &Path) -> Res<Bundle> {
    v.ensure_exclusive()?;
    recover(v, state)?;
    let workspace = v.root.join("kv/workspace.json");
    snapshot::checked_parents(&v.root, "kv/workspace.json")?;
    if workspace.exists() {
        let raw: Value = serde_json::from_slice(&fs::read(&workspace).map_err(err)?)
            .map_err(|_| "SYNC:invalid_workspace_metadata")?;
        if raw["name"] != v.name() {
            write_atomic(&workspace, &snapshot::canonical(&json!({"name":v.name()}))?)?;
        }
    } else {
        write_atomic(&workspace, &snapshot::canonical(&json!({"name":v.name()}))?)?;
    }
    scan(v, &state.join("journal.objects"), true)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Apply {
    before: Bundle,
    after: Bundle,
}
fn hydrate(mut b: Bundle, cache: &Path) -> Res<Bundle> {
    for (p, h) in &b.manifest.files {
        if !super::core::valid_hash(h) {
            return Err("DRIVE:invalid_hash".into());
        }
        if !b.bytes.contains_key(p) {
            b.sources.insert(p.clone(), cache.join(h));
        }
    }
    b.decode_metadata()?;
    Ok(b)
}
fn semantic_files(bundle: &Bundle) -> Res<BTreeMap<String, String>> {
    use base64::Engine;
    let mut files = bundle.manifest.files.clone();
    for (path, h) in &bundle.manifest.files {
        if !path.ends_with(".json") {
            continue;
        }
        let data = if let Some(encoded) = bundle.bytes.get(path) {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(err)?
        } else {
            fs::read(bundle.sources.get(path).ok_or("DRIVE:missing_dependency")?).map_err(err)?
        };
        if snapshot::hash(&data) != *h {
            return Err("DRIVE:integrity".into());
        }
        snapshot::validate(path, &data)?;
        let value: Value = serde_json::from_slice(&data).map_err(err)?;
        files.insert(path.clone(), snapshot::hash(&snapshot::canonical(&value)?));
    }
    Ok(files)
}
pub fn apply(v: &Vault, state: &Path, before: &Bundle, after: &Bundle) -> Res<()> {
    let current = scan(v, &state.join("journal.objects"), true)?;
    if current.manifest.files != semantic_files(before)?
        || current.manifest.tombstones != before.manifest.tombstones
        || current.manifest.vault != before.manifest.vault
    {
        return Err("SYNC:local_changed".into());
    }
    after.decode_metadata()?;
    // Journal only hashes and JSON; media paths are re-derived from this installation's trusted cache.
    for (p, source) in &after.sources {
        let h = after.manifest.files.get(p).ok_or("DRIVE:integrity")?;
        let target = state.join("journal.objects").join(h);
        if source != &target {
            copy_verified(source, &target, h)?;
        }
    }
    write_atomic(
        &v.root.join(".noviq/drive-apply.json"),
        &bytes(&Apply {
            before: before.clone(),
            after: after.clone(),
        })?,
    )?;
    recover(v, state)
}
pub fn recover(v: &Vault, state: &Path) -> Res<()> {
    let path = v.root.join(".noviq/drive-apply.json");
    let data = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    v.ensure_exclusive()?;
    let receipt: Apply =
        serde_json::from_slice(&data).map_err(|_| "DRIVE:apply_receipt_corrupt")?;
    if receipt.before.manifest.vault != v.id() || receipt.after.manifest.vault != v.id() {
        return Err("VAULT_MISMATCH".into());
    }
    let cache = state.join("journal.objects");
    let after = hydrate(receipt.after, &cache)?;
    let json = after.decode_metadata()?;
    super::database::validate(&json)?;
    let current = scan(v, &cache, false)?;
    let before_files = semantic_files(&receipt.before)?;
    let after_files = semantic_files(&after)?;
    for p in before_files
        .keys()
        .chain(after_files.keys())
        .collect::<BTreeSet<_>>()
    {
        let h = current.manifest.files.get(p);
        if h != before_files.get(p) && h != after_files.get(p) {
            return Err("SYNC:recovery_required".into());
        }
    }
    for (p, h) in &after.manifest.files {
        if current.manifest.files.get(p) == after_files.get(p) {
            continue;
        }
        snapshot::checked_parents(&v.root, p)?;
        if let Some(source) = after.sources.get(p) {
            copy_verified(source, &v.root.join(p), h)?;
        } else {
            write_atomic(
                &v.root.join(p),
                json.get(p).ok_or("DRIVE:missing_dependency")?,
            )?;
        }
    }
    for p in receipt
        .before
        .manifest
        .files
        .keys()
        .filter(|p| !after.manifest.files.contains_key(*p))
    {
        snapshot::checked_parents(&v.root, p)?;
        match fs::remove_file(v.root.join(p)) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(err(e)),
        }
    }
    if let Some(data) = json.get("kv/workspace.json") {
        let value: Value = serde_json::from_slice(data).map_err(err)?;
        if let Some(name) = value["name"].as_str() {
            v.rename(name)?;
        }
    }
    write_atomic(
        &v.root.join(".noviq/tombstones.json"),
        &bytes(&after.manifest.tombstones)?,
    )?;
    fs::remove_file(path).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_apply_redoes_media_without_serializing_source_paths() {
        let root =
            std::env::temp_dir().join(format!("nevis-stream-recovery-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(root.join("vault"), "Test").unwrap();
        let state = root.join("state");
        let id = v.id();
        let page = format!("pages/{id}.json");
        let old = json!({"id":id,"title":"before","content":{"type":"doc","content":[]}});
        write_atomic(&v.root.join(&page), &bytes(&old).unwrap()).unwrap();
        let before = capture(&v, &state).unwrap();
        let media = b"GIF89a recovered";
        let h = snapshot::hash(media);
        let cache = state.join("journal.objects").join(&h);
        write_atomic(&cache, media).unwrap();
        let rel = format!("files/{}/{h}", &h[..2]);
        let next = json!({"id":id,"title":"after","content":{"type":"doc","content":[{"type":"image","attrs":{"src":format!("att:{h}"),"stableBlockId":"image"}}]}});
        let mut files = before.decode_metadata().unwrap();
        files.insert(page.clone(), bytes(&next).unwrap());
        files.insert(
            format!("{rel}.json"),
            bytes(&json!({"id":h,"type":"image/gif","size":media.len(),"name":"","addedAt":0}))
                .unwrap(),
        );
        let mut after = Bundle::new(&id, &files, BTreeSet::new());
        after.sources.insert(rel.clone(), cache.clone());
        after.manifest.files.insert(rel.clone(), h.clone());
        after.decode_metadata().unwrap();
        let encoded = bytes(&Apply {
            before: before.clone(),
            after: after.clone(),
        })
        .unwrap();
        assert!(!String::from_utf8_lossy(&encoded).contains(cache.to_str().unwrap()));
        write_atomic(&v.root.join(".noviq/drive-apply.json"), &encoded).unwrap();
        write_atomic(&v.root.join(&page), &bytes(&next).unwrap()).unwrap();
        recover(&v, &state).unwrap();
        assert_eq!(fs::read(v.root.join(&rel)).unwrap(), media);
        assert_eq!(
            capture(&v, &state).unwrap().manifest.files,
            semantic_files(&after).unwrap()
        );
        assert!(!v.root.join(".noviq/drive-apply.json").exists());
        drop(v);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_apply_preserves_an_unexpected_third_local_version() {
        let root =
            std::env::temp_dir().join(format!("nevis-stream-third-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(root.join("vault"), "Test").unwrap();
        let state = root.join("state");
        let page = format!("pages/{}.json", v.id());
        let initial = json!({"id":v.id(),"title":"before","content":{"type":"doc","content":[]}});
        write_atomic(&v.root.join(&page), &bytes(&initial).unwrap()).unwrap();
        let before = capture(&v, &state).unwrap();
        let mut files = before.decode_metadata().unwrap();
        let mut next = initial.clone();
        next["title"] = json!("after");
        files.insert(page.clone(), bytes(&next).unwrap());
        let after = Bundle::new(&v.id(), &files, BTreeSet::new());
        write_atomic(
            &v.root.join(".noviq/drive-apply.json"),
            &bytes(&Apply { before, after }).unwrap(),
        )
        .unwrap();
        let mut third = initial;
        third["title"] = json!("third external edit");
        let third = bytes(&third).unwrap();
        write_atomic(&v.root.join(&page), &third).unwrap();
        assert_eq!(recover(&v, &state).unwrap_err(), "SYNC:recovery_required");
        assert_eq!(fs::read(v.root.join(&page)).unwrap(), third);
        assert!(v.root.join(".noviq/drive-apply.json").exists());
        drop(v);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod verification_tests {
    use super::*;
    #[test]
    fn cached_hash_invalidates_after_atomic_replacement_and_deep_check_is_available() {
        let root = std::env::temp_dir().join(format!("nevis-hash-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("object");
        write_atomic(&path, b"first").unwrap();
        assert_eq!(file_hash(&path).unwrap(), snapshot::hash(b"first"));
        write_atomic(&path, b"other").unwrap();
        assert_eq!(file_hash(&path).unwrap(), snapshot::hash(b"other"));
        clear_verification_cache();
        assert_eq!(file_hash(&path).unwrap(), snapshot::hash(b"other"));
        fs::remove_dir_all(root).unwrap();
    }
}
