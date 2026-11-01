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
    if p == ".noviq/vault.json"
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
pub fn export(v: &Vault) -> Res<Backup> {
    fn walk(
        root: &Path,
        dir: &Path,
        entries: &mut BTreeMap<String, File>,
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
                entries.insert(
                    rel,
                    File {
                        sha256: hash(&bytes),
                        data: B64.encode(bytes),
                    },
                );
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
    let marker = fs::read(v.root.join(".noviq/vault.json")).map_err(err)?;
    entries.insert(
        ".noviq/vault.json".into(),
        File {
            sha256: hash(&marker),
            data: B64.encode(marker),
        },
    );
    Ok(Backup {
        format: "noviq-vault-backup".into(),
        version: 2,
        name: v.name(),
        created_at: crate::vault::now_ms(),
        entries,
    })
}
/// Reads and fully checks a backup: format, paths, hashes and JSON. Nothing is written. Returns its workspace name and files.
fn verified(raw: serde_json::Value) -> Res<(String, BTreeMap<String, Vec<u8>>)> {
    let b: Backup = serde_json::from_value(raw).map_err(|_| "BACKUP:invalid_format")?;
    if b.format != "noviq-vault-backup"
        || b.version != 2
        || !b.entries.contains_key(".noviq/vault.json")
    {
        return Err("BACKUP:invalid_format".into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    for (p, f) in b.entries {
        if p == ".noviq/tombstones.json" {
            continue; // backups of earlier versions hold a list of deletions that nothing reads any more
        }
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
fn folder_for(parent: &Path, name: &str) -> String {
    let base: String = name
        .trim()
        .chars()
        .filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control())
        .collect();
    let base = if base.is_empty() || base == "." || base == ".." {
        "Restored".to_string()
    } else {
        base
    };
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
    let stage = parent.join(format!(".noviq-restore-{id}"));
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
        &stage.join(".noviq/vault.json"),
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

#[cfg(test)]
mod tests {
    use super::*;
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
            .filter(|p| *p != ".noviq/vault.json" && *p != "kv/workspace.json")
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
    #[test]
    fn corrupted_bytes_and_traversal_fail_before_staging() {
        let parent = std::env::temp_dir();
        let mut b = Backup {
            format: "noviq-vault-backup".into(),
            version: 2,
            name: "test".into(),
            created_at: 0,
            entries: BTreeMap::new(),
        };
        b.entries.insert(
            ".noviq/vault.json".into(),
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
