//! Verified portable vault backups. Restore into a new disconnected workspace (leaving the source intact) or into the open one.
use crate::vault::{err, sha256_hex as hash, write_atomic, Res, Vault};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, fs, path::Path};
/// The most a backup may hold in total.
const MAX_SNAPSHOT: usize = 512 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
pub struct File {
    data: String,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub created_at: i64,
    pub entries: BTreeMap<String, File>,
}
fn safe(p: &str) -> Res<()> {
    if p.contains('\\')
        || p.contains(':')
        || p.split('/')
            .any(|x| x.is_empty() || x == "." || x == ".." || x.ends_with(".tmp"))
    {
        return Err("BACKUP:unsafe_path".into());
    }
    if p == ".nevis/vault.json"
        || [
            "pages/",
            "files/",
            "databases/",
            "kv/",
            "history/",
            "conflicts/",
            ".trash/",
        ]
        .iter()
        .any(|r| p.starts_with(r))
    {
        Ok(())
    } else {
        Err("BACKUP:unsafe_path".into())
    }
}
/// Every file of the vault that belongs in a backup, by its path inside the vault.
fn collect(v: &Vault) -> Res<BTreeMap<String, Vec<u8>>> {
    fn walk(
        root: &Path,
        dir: &Path,
        entries: &mut BTreeMap<String, Vec<u8>>,
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
            return Err("BACKUP:symlink".into());
        }
        for e in fs::read_dir(dir).map_err(err)? {
            let e = e.map_err(err)?;
            let p = e.path();
            let t = e.file_type().map_err(err)?;
            if t.is_symlink() {
                return Err("BACKUP:symlink".into());
            }
            if t.is_dir() {
                walk(root, &p, entries, total)?;
            } else {
                let rel = p
                    .strip_prefix(root)
                    .map_err(err)?
                    .to_string_lossy()
                    .replace('\\', "/");
                safe(&rel)?;
                let bytes = fs::read(&p).map_err(err)?;
                *total += bytes.len();
                if *total > MAX_SNAPSHOT {
                    return Err("BACKUP:too_large".into());
                }
                entries.insert(rel, bytes);
            }
        }
        Ok(())
    }
    let mut entries = BTreeMap::new();
    let mut total = 0;
    for d in [
        "pages",
        "files",
        "databases",
        "kv",
        "history",
        "conflicts",
        ".trash",
    ] {
        walk(&v.root, &v.root.join(d), &mut entries, &mut total)?;
    }
    entries.insert(
        ".nevis/vault.json".into(),
        fs::read(v.root.join(".nevis/vault.json")).map_err(err)?,
    );
    Ok(entries)
}
pub fn export(v: &Vault) -> Res<Backup> {
    let entries = collect(v)?
        .into_iter()
        .map(|(p, bytes)| {
            let f = File {
                sha256: hash(&bytes),
                data: B64.encode(bytes),
            };
            (p, f)
        })
        .collect();
    Ok(Backup {
        format: "nevis-vault-backup".into(),
        version: 2,
        name: v.name(),
        created_at: crate::vault::now_ms(),
        entries,
    })
}
/// Reads and fully checks a backup: format, paths, hashes and JSON. Nothing is written. Returns its workspace name and files.
fn verified(raw: serde_json::Value) -> Res<(String, BTreeMap<String, Vec<u8>>)> {
    let b: Backup = serde_json::from_value(raw).map_err(|_| "BACKUP:invalid_format")?;
    let legacy = b.format == "noviq-vault-backup";
    let marker = if legacy { ".noviq/vault.json" } else { ".nevis/vault.json" };
    if (!legacy && b.format != "nevis-vault-backup")
        || b.version != 2
        || !b.entries.contains_key(marker)
        || (legacy && b.entries.contains_key(".nevis/vault.json"))
    {
        return Err("BACKUP:invalid_format".into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    for (p, f) in b.entries {
        if p == ".nevis/tombstones.json" || (legacy && p == ".noviq/tombstones.json") {
            continue; // backups of earlier versions hold a list of deletions that nothing reads any more
        }
        let p = if p == marker { ".nevis/vault.json".to_owned() } else { p };
        safe(&p)?;
        let bytes = B64.decode(f.data).map_err(|_| "BACKUP:invalid_bytes")?;
        total += bytes.len();
        if total > MAX_SNAPSHOT || hash(&bytes) != f.sha256 {
            return Err("BACKUP:verification_failed".into());
        }
        if p.ends_with(".json") {
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|_| "BACKUP:invalid_json")?;
        }
        files.insert(p, bytes);
    }
    Ok((b.name, files))
}

/// A folder name from a workspace name: no characters a file system refuses, and not one that already exists.
fn clean(name: &str) -> String {
    let base: String = name
        .trim()
        .chars()
        .filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control())
        .collect();
    if base.is_empty() || base == "." || base == ".." {
        "Restored".to_string()
    } else {
        base
    }
}
fn folder_for(parent: &Path, name: &str) -> String {
    let base = clean(name);
    let mut candidate = base.clone();
    let mut n = 2;
    while parent.join(&candidate).exists() {
        candidate = format!("{base} ({n})");
        n += 1;
    }
    candidate
}

/// Restores into a new workspace next to the current one, named `name` (or exactly as the backup's own). The source stays intact.
pub fn restore(parent: &Path, raw: serde_json::Value, name: Option<&str>) -> Res<Vault> {
    let (original, files) = verified(raw)?;
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&original)
        .to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let stage = parent.join(format!(".nevis-restore-{id}"));
    let target = parent.join(folder_for(parent, &name));
    fs::create_dir(&stage).map_err(err)?;
    for (p, bytes) in &files {
        let path = stage.join(p);
        write_atomic(&path, bytes)?;
        if hash(&fs::read(path).map_err(err)?) != hash(bytes) {
            return Err("BACKUP:verification_failed".into());
        }
    }
    write_atomic(
        &stage.join(".nevis/vault.json"),
        &serde_json::to_vec(&json!({"format":1,"id":id,"name":name})).map_err(err)?,
    )?;
    write_atomic(
        &stage.join("kv/workspace.json"),
        &serde_json::to_vec(&json!({"name":name})).map_err(err)?,
    )?;
    // The restored vault gets a fresh identity, so it never replaces the one it was made from.
    fs::rename(&stage, &target).map_err(err)?;
    Vault::open(target)
}

/// Restores into the open workspace: its pages, files, databases and history from the backup are written over the
/// workspace's own (a page with the same id is replaced by the backup's version). Nothing is deleted, and the
/// workspace's identity, settings and trash stay as they are. Returns how many files were written.
pub fn restore_into(v: &Vault, raw: serde_json::Value) -> Res<usize> {
    let (_, files) = verified(raw)?;
    let _guard = crate::vault::commit_lock(&v.root)?;
    let mut written = 0;
    for (p, bytes) in &files {
        if !["pages/", "files/", "databases/", "history/"]
            .iter()
            .any(|r| p.starts_with(r))
        {
            continue;
        }
        write_atomic(&v.root.join(p), bytes)?;
        written += 1;
    }
    Ok(written)
}

/// What a merge did, page by page.
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Merged {
    /// Pages that were not here.
    pub added: usize,
    /// Pages the backup had a newer version of; the version that was here went to the page's history.
    pub updated: usize,
    /// Pages left as they are: newer here, the same, or in the trash here.
    pub kept: usize,
    /// Images and other files that were not here.
    pub files: usize,
}

/// Brings a backup into the open workspace without replacing anything that is newer or only here. A page that is in both
/// keeps its newer version (database pages merge cell by cell) and the older one goes to the page's history. A page in this
/// workspace's trash stays there. Nothing is deleted. Files, database sources and history are added when they are missing.
pub fn restore_merge(v: &Vault, raw: serde_json::Value) -> Res<Merged> {
    let (_, files) = verified(raw)?;
    let _guard = crate::vault::commit_lock(&v.root)?;
    let stamp = |page: &serde_json::Value| page.get("updatedAt").and_then(|t| t.as_i64()).unwrap_or(0);
    let trashed = |page: &serde_json::Value| page.get("deletedAt").is_some_and(|d| !d.is_null());
    let to_history = |id: &str, old: &serde_json::Value, ts: i64| -> Res<()> {
        let snapshot = json!({"pageId": id, "ts": ts, "title": old.get("title").cloned().unwrap_or_default(), "content": old.get("content").cloned().unwrap_or_default()});
        write_atomic(&v.root.join("history").join(id).join(format!("{ts}.json")), &serde_json::to_vec(&snapshot).map_err(err)?)
    };
    let mut merged = Merged::default();
    let mut ts = crate::vault::now_ms();
    for (path, bytes) in &files {
        let dest = v.root.join(path);
        let page_id = path.strip_prefix("pages/").and_then(|n| n.strip_suffix(".json")).filter(|id| !id.contains('/'));
        if let Some(id) = page_id {
            let theirs: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "BACKUP:invalid_json")?;
            let Some(mine) = fs::read(&dest).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else {
                write_atomic(&dest, bytes)?;
                merged.added += 1;
                continue;
            };
            if mine == theirs || trashed(&mine) {
                merged.kept += 1;
                continue;
            }
            if mine.get("database").is_some() && theirs.get("database").is_some() {
                let (win, losers) = crate::database::merge::merge_pages(&theirs, &mine);
                if win == mine {
                    merged.kept += 1;
                    continue;
                }
                for loser in &losers {
                    ts += 1;
                    to_history(id, loser, ts)?;
                }
                write_atomic(&dest, win.to_string().as_bytes())?;
                merged.updated += 1;
            } else if stamp(&theirs) > stamp(&mine) {
                ts += 1;
                to_history(id, &mine, ts)?;
                write_atomic(&dest, bytes)?;
                merged.updated += 1;
            } else {
                merged.kept += 1;
            }
        } else if ["files/", "databases/", "history/"].iter().any(|r| path.starts_with(r)) && !dest.exists() {
            write_atomic(&dest, bytes)?;
            if path.starts_with("files/") && !path.ends_with(".json") {
                merged.files += 1;
            }
        }
    }
    Ok(merged)
}

// ───── folder backups ─────
// The vault's own files, unpacked into `<parent>/<workspace name> [<id>]/`, with `backup.json` listing every file's hash and
// what the backup holds. Only changed files are rewritten, so a folder kept in git changes by the pages that changed.

const FOLDER_FORMAT: &str = "nevis-folder-backup";
const MANIFEST: &str = "backup.json";

/// What a backup holds. `pages` includes the trashed ones and not the folders.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
pub struct Counts {
    pub pages: usize,
    pub folders: usize,
    pub trashed: usize,
    pub files: usize,
    pub databases: usize,
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    vault_id: String,
    name: String,
    created_at: i64,
    counts: Counts,
    entries: BTreeMap<String, String>,
}
#[derive(Serialize, Debug)]
pub struct FolderReport {
    pub path: String,
    pub counts: Counts,
    pub created_at: i64,
    pub written: usize,
    pub removed: usize,
}

fn count(entries: &BTreeMap<String, Vec<u8>>) -> Counts {
    let mut c = Counts::default();
    for (p, bytes) in entries {
        if let Some(name) = p.strip_prefix("pages/") {
            if name.contains('/') || !name.ends_with(".json") {
                continue;
            }
            let page: serde_json::Value = serde_json::from_slice(bytes).unwrap_or_default();
            if page.get("kind").and_then(|k| k.as_str()) == Some("folder") {
                c.folders += 1;
            } else {
                c.pages += 1;
            }
            if page.get("deletedAt").is_some_and(|d| !d.is_null()) {
                c.trashed += 1;
            }
        } else if p.starts_with("files/") && !p.ends_with(".json") && !p.ends_with(".DS_Store") {
            c.files += 1;
        } else if p.starts_with("databases/") {
            c.databases += 1;
        }
    }
    c
}
fn live(c: &Counts) -> usize {
    c.pages.saturating_sub(c.trashed)
}

/// Writes (or brings up to date) the backup folder of this workspace. A folder of several workspaces never mixes them: the
/// name carries the workspace id. Refuses when the workspace suddenly holds far fewer pages than its last backup, unless `force`.
pub fn export_folder(v: &Vault, parent: &Path, force: bool) -> Res<FolderReport> {
    let entries = collect(v)?;
    let counts = count(&entries);
    let id = v.id();
    let dir = parent.join(format!("{} [{}]", clean(&v.name()), &id[..id.len().min(8)]));
    let old: Option<Manifest> = fs::read(dir.join(MANIFEST))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(o) = &old {
        if !force && live(&o.counts) >= 10 && live(&counts) * 2 < live(&o.counts) {
            return Err("BACKUP:page_count_dropped".into());
        }
    }
    let hashes: BTreeMap<String, String> = entries.iter().map(|(p, b)| (p.clone(), hash(b))).collect();
    let mut written = 0;
    for (p, bytes) in &entries {
        let path = dir.join(p);
        // a file that is already right is left alone; one that was damaged on disk is written again
        if fs::read(&path).is_ok_and(|b| hash(&b) == hashes[p]) {
            continue;
        }
        write_atomic(&path, bytes)?;
        if hash(&fs::read(&path).map_err(err)?) != hashes[p] {
            return Err("BACKUP:verification_failed".into());
        }
        written += 1;
    }
    let mut removed = 0;
    if let Some(o) = &old {
        for p in o.entries.keys().filter(|p| !entries.contains_key(*p)) {
            if safe(p).is_ok() && fs::remove_file(dir.join(p)).is_ok() {
                removed += 1;
            }
        }
    }
    let created_at = crate::vault::now_ms();
    let manifest = Manifest {
        format: FOLDER_FORMAT.into(),
        version: 1,
        vault_id: id,
        name: v.name(),
        created_at,
        counts: counts.clone(),
        entries: hashes,
    };
    write_atomic(&dir.join(MANIFEST), &serde_json::to_vec(&manifest).map_err(err)?)?;
    if old.as_ref().is_some_and(|o| o.format == "noviq-folder-backup" && o.entries.contains_key(".noviq/vault.json")) {
        let legacy = dir.join(".noviq");
        if fs::symlink_metadata(&legacy).is_ok_and(|m| m.is_dir()) && fs::remove_file(legacy.join("vault.json")).is_ok() {
            removed += 1;
            let _ = fs::remove_dir(legacy);
        }
    }
    Ok(FolderReport { path: dir.to_string_lossy().into(), counts, created_at, written, removed })
}

/// Reads a backup folder and checks all of it (every file against its hash, and the counts against the manifest), without
/// writing anything. The result has the same shape as a single-file backup, so the restore code is the same.
pub fn read_folder(dir: &Path) -> Res<serde_json::Value> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(dir.join(MANIFEST)).map_err(|_| "BACKUP:invalid_format")?)
        .map_err(|_| "BACKUP:invalid_format")?;
    let legacy = manifest.format == "noviq-folder-backup";
    let marker = if legacy { ".noviq/vault.json" } else { ".nevis/vault.json" };
    if (!legacy && manifest.format != FOLDER_FORMAT)
        || manifest.version != 1
        || !manifest.entries.contains_key(marker)
        || (legacy && manifest.entries.contains_key(".nevis/vault.json"))
    {
        return Err("BACKUP:invalid_format".into());
    }
    let mut bytes = BTreeMap::new();
    let mut total = 0;
    for (p, sha) in &manifest.entries {
        safe(if p == marker { ".nevis/vault.json" } else { p })?;
        let b = fs::read(dir.join(p)).map_err(|_| "BACKUP:missing_file")?;
        total += b.len();
        if total > MAX_SNAPSHOT || hash(&b) != *sha {
            return Err("BACKUP:verification_failed".into());
        }
        bytes.insert(p.clone(), b);
    }
    if count(&bytes) != manifest.counts {
        return Err("BACKUP:verification_failed".into());
    }
    let entries = bytes
        .into_iter()
        .map(|(p, b)| {
            let f = File { sha256: manifest.entries[&p].clone(), data: B64.encode(b) };
            let p = if p == marker { ".nevis/vault.json".to_owned() } else { p };
            (p, f)
        })
        .collect();
    serde_json::to_value(Backup {
        format: "nevis-vault-backup".into(),
        version: 2,
        name: manifest.name,
        created_at: manifest.created_at,
        entries,
    })
    .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_workspace_metadata_and_restores_a_legacy_backup() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let root = parent.join("Original");
        let vault = Vault::create(root.clone(), "Original").unwrap();
        let id = vault.id();
        let mut backup = export(&vault).unwrap();
        backup.format = "noviq-vault-backup".into();
        let marker = backup.entries.remove(".nevis/vault.json").unwrap();
        backup.entries.insert(".noviq/vault.json".into(), marker);
        write_atomic(&root.join(".nevis/metadata-test"), b"preserved").unwrap();
        drop(vault);
        fs::rename(root.join(".nevis"), root.join(".noviq")).unwrap();

        let upgraded = Vault::open_as(root.clone(), &id).unwrap();
        assert_eq!(upgraded.id(), id);
        assert_eq!(fs::read(root.join(".nevis/metadata-test")).unwrap(), b"preserved");
        assert!(!root.join(".noviq").exists());

        let restored = restore(&parent, serde_json::to_value(backup).unwrap(), Some("Restored")).unwrap();
        assert!(restored.root.join(".nevis/vault.json").is_file());
        assert!(!restored.root.join(".noviq").exists());
        drop((upgraded, restored));
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn full_backup_roundtrip_keeps_records_history_settings_and_gif() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(parent.join("original"), "mine").unwrap();
        for (p, b) in [
            (
                "databases/sources/s.json",
                b"{\"id\":\"s\",\"format\":1}".as_slice(),
            ),
            ("history/records/source/s/1.json", b"{\"title\":\"old\"}"),
            ("kv/preferences.json", b"{\"theme\":\"dark\"}"),
            ("files/aa/animated", b"GIF89a\0\x21\xf9animated"),
        ] {
            write_atomic(&v.root.join(p), b).unwrap();
        }
        let backup = export(&v).unwrap();
        let restored = restore(&parent, serde_json::to_value(&backup).unwrap(), None).unwrap();
        assert_ne!(restored.id(), v.id());
        for p in backup
            .entries
            .keys()
            .filter(|p| *p != ".nevis/vault.json" && *p != "kv/workspace.json")
        {
            assert_eq!(
                fs::read(v.root.join(p)).unwrap(),
                fs::read(restored.root.join(p)).unwrap()
            );
        }
        assert!(v.root.exists());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn a_new_workspace_gets_the_given_name_or_the_backups_own_and_never_a_taken_folder() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(parent.join("original"), "Study notes").unwrap();
        let backup = serde_json::to_value(export(&v).unwrap()).unwrap();
        let own = restore(&parent, backup.clone(), None).unwrap();
        assert_eq!(own.name(), "Study notes");
        assert!(parent.join("Study notes").exists());
        let again = restore(&parent, backup.clone(), None).unwrap();
        assert_eq!(again.name(), "Study notes");
        assert!(parent.join("Study notes (2)").exists());
        let named = restore(&parent, backup, Some("  Work  ")).unwrap();
        assert_eq!(named.name(), "Work");
        assert!(parent.join("Work").exists());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn restoring_into_the_open_workspace_replaces_same_pages_and_keeps_everything_else() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(parent.join("here"), "mine").unwrap();
        let page = "0123456789abcdef0123456789abcdef";
        let other = "fedcba9876543210fedcba9876543210";
        write_atomic(&v.root.join(format!("pages/{page}.json")), b"{\"title\":\"old\"}").unwrap();
        write_atomic(&v.root.join("files/aa/pic"), b"picture").unwrap();
        let backup = serde_json::to_value(export(&v).unwrap()).unwrap();
        // the workspace moves on after the backup
        write_atomic(&v.root.join(format!("pages/{page}.json")), b"{\"title\":\"edited\"}").unwrap();
        write_atomic(&v.root.join(format!("pages/{other}.json")), b"{\"title\":\"new\"}").unwrap();
        write_atomic(&v.root.join("kv/preferences.json"), b"{\"theme\":\"dark\"}").unwrap();
        let id = v.id();
        let written = restore_into(&v, backup).unwrap();
        assert!(written >= 2);
        assert_eq!(fs::read(v.root.join(format!("pages/{page}.json"))).unwrap(), b"{\"title\":\"old\"}");
        assert_eq!(fs::read(v.root.join(format!("pages/{other}.json"))).unwrap(), b"{\"title\":\"new\"}");
        assert_eq!(fs::read(v.root.join("kv/preferences.json")).unwrap(), b"{\"theme\":\"dark\"}");
        assert_eq!(fs::read(v.root.join("files/aa/pic")).unwrap(), b"picture");
        assert_eq!(v.id(), id);
        fs::remove_dir_all(parent).unwrap();
    }
    fn page(v: &Vault, n: usize, extra: &str) {
        let id = format!("{n:032x}");
        let body = format!("{{\"id\":\"{id}\",\"title\":\"p{n}\"{extra}}}");
        write_atomic(&v.root.join(format!("pages/{id}.json")), body.as_bytes()).unwrap();
    }
    #[test]
    fn a_merge_adds_what_is_missing_keeps_what_is_newer_or_only_here_and_deletes_nothing() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let here = Vault::create(parent.join("here"), "mine").unwrap();
        let there = Vault::create(parent.join("there"), "other").unwrap();
        for (n, extra) in [(1, ",\"updatedAt\":10"), (2, ",\"updatedAt\":10"), (3, ",\"updatedAt\":50"), (4, ",\"updatedAt\":10,\"deletedAt\":7"), (6, ",\"updatedAt\":1")] {
            page(&here, n, extra);
        }
        for (n, extra) in [(1, ",\"updatedAt\":10"), (2, ",\"updatedAt\":20"), (3, ",\"updatedAt\":5"), (4, ",\"updatedAt\":99"), (5, ",\"updatedAt\":1")] {
            page(&there, n, extra);
        }
        write_atomic(&here.root.join("files/aa/own"), b"mine").unwrap();
        write_atomic(&there.root.join("files/bb/pic"), b"theirs").unwrap();
        write_atomic(&there.root.join("kv/preferences.json"), b"{\"theme\":\"dark\"}").unwrap();
        let backup = serde_json::to_value(export(&there).unwrap()).unwrap();
        let merged = restore_merge(&here, backup.clone()).unwrap();
        assert_eq!(merged, Merged { added: 1, updated: 1, kept: 3, files: 1 });
        let read = |n: usize| -> serde_json::Value { serde_json::from_slice(&fs::read(here.root.join(format!("pages/{n:032x}.json"))).unwrap()).unwrap() };
        assert_eq!(read(2)["updatedAt"], 20); // the backup's newer version won
        assert_eq!(fs::read_dir(here.root.join("history").join(format!("{:032x}", 2))).unwrap().count(), 1); // and the one that was here is in the history
        assert_eq!(read(3)["updatedAt"], 50); // newer here: kept
        assert_eq!(read(4)["deletedAt"], 7); // in the trash here: stays there
        assert_eq!(read(5)["title"], "p5"); // only in the backup: added
        assert_eq!(read(6)["title"], "p6"); // only here: untouched
        assert_eq!(fs::read(here.root.join("files/aa/own")).unwrap(), b"mine");
        assert_eq!(fs::read(here.root.join("files/bb/pic")).unwrap(), b"theirs");
        assert!(!here.root.join("kv/preferences.json").exists()); // settings stay as they are
        // doing it again changes nothing
        assert_eq!(restore_merge(&here, backup).unwrap(), Merged { added: 0, updated: 0, kept: 5, files: 0 });
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn a_folder_backup_keeps_the_tree_counts_and_files_and_restores_like_a_single_file() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(parent.join("work"), "Study notes").unwrap();
        page(&v, 1, ",\"kind\":\"folder\"");
        page(&v, 2, &format!(",\"parentId\":\"{:032x}\"", 1));
        page(&v, 3, ",\"deletedAt\":5");
        write_atomic(&v.root.join("files/aa/pic"), b"picture").unwrap();
        write_atomic(&v.root.join("kv/preferences.json"), b"{\"theme\":\"dark\"}").unwrap();
        let out = parent.join("backups");
        let r = export_folder(&v, &out, false).unwrap();
        assert_eq!(r.counts, Counts { pages: 2, folders: 1, trashed: 1, files: 1, databases: 0 });
        assert!(r.path.contains("Study notes ["));
        let restored = restore(&parent, read_folder(Path::new(&r.path)).unwrap(), Some("Copy")).unwrap();
        assert_eq!(fs::read(restored.root.join("files/aa/pic")).unwrap(), b"picture");
        assert_eq!(restored.pages_all().unwrap().len(), 3);
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn a_second_folder_backup_writes_only_what_changed_and_drops_what_is_gone() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(parent.join("work"), "mine").unwrap();
        page(&v, 1, "");
        page(&v, 2, "");
        let out = parent.join("backups");
        assert!(export_folder(&v, &out, false).unwrap().written >= 3);
        assert_eq!(export_folder(&v, &out, false).unwrap().written, 0);
        page(&v, 2, ",\"icon\":\"x\"");
        fs::remove_file(v.root.join(format!("pages/{:032x}.json", 1))).unwrap();
        let r = export_folder(&v, &out, false).unwrap();
        assert_eq!((r.written, r.removed), (1, 1));
        assert!(!Path::new(&r.path).join(format!("pages/{:032x}.json", 1)).exists());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn a_workspace_that_lost_most_of_its_pages_does_not_overwrite_its_backup() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(parent.join("work"), "mine").unwrap();
        for n in 1..=12 {
            page(&v, n, "");
        }
        let out = parent.join("backups");
        export_folder(&v, &out, false).unwrap();
        for n in 1..=8 {
            fs::remove_file(v.root.join(format!("pages/{n:032x}.json"))).unwrap();
        }
        assert_eq!(export_folder(&v, &out, false).unwrap_err(), "BACKUP:page_count_dropped");
        assert_eq!(export_folder(&v, &out, true).unwrap().counts.pages, 4);
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn a_damaged_or_missing_file_in_a_backup_folder_is_refused_not_half_read() {
        let parent = std::env::temp_dir().join(format!("portable-test-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(parent.join("work"), "mine").unwrap();
        page(&v, 1, "");
        let r = export_folder(&v, &parent.join("backups"), false).unwrap();
        let file = Path::new(&r.path).join(format!("pages/{:032x}.json", 1));
        fs::write(&file, b"{\"title\":\"tampered\"}").unwrap();
        assert_eq!(read_folder(Path::new(&r.path)).unwrap_err(), "BACKUP:verification_failed");
        fs::remove_file(&file).unwrap();
        assert_eq!(read_folder(Path::new(&r.path)).unwrap_err(), "BACKUP:missing_file");
        // the next backup of the workspace repairs the folder
        export_folder(&v, &parent.join("backups"), false).unwrap();
        assert!(read_folder(Path::new(&r.path)).is_ok());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn corrupted_bytes_and_traversal_fail_before_staging() {
        let parent = std::env::temp_dir();
        let mut b = Backup {
            format: "nevis-vault-backup".into(),
            version: 2,
            name: "test".into(),
            created_at: 0,
            entries: BTreeMap::new(),
        };
        b.entries.insert(
            ".nevis/vault.json".into(),
            File {
                data: B64.encode(b"{}"),
                sha256: "wrong".into(),
            },
        );
        assert!(restore(&parent, serde_json::to_value(&b).unwrap(), None).is_err());
        b.entries.insert(
            "../outside".into(),
            File {
                data: B64.encode(b"{}"),
                sha256: hash(b"{}"),
            },
        );
        assert!(restore(&parent, serde_json::to_value(&b).unwrap(), None).is_err());
    }
}
