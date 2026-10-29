//! Verified portable vault backups. Restore into a new disconnected workspace, leaving the source intact.
use crate::{
    sync::snapshot::{hash, MAX_SNAPSHOT},
    vault::{err, write_atomic, Res, Vault},
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, fs, path::Path};
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
        || p == ".noviq/tombstones.json"
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
    for p in [".noviq/vault.json", ".noviq/tombstones.json"] {
        let f = v.root.join(p);
        if f.exists() {
            let b = fs::read(f).map_err(err)?;
            entries.insert(
                p.into(),
                File {
                    sha256: hash(&b),
                    data: B64.encode(b),
                },
            );
        }
    }
    Ok(Backup {
        format: "noviq-vault-backup".into(),
        version: 2,
        name: v.name(),
        created_at: crate::vault::now_ms(),
        entries,
    })
}
pub fn restore(parent: &Path, raw: serde_json::Value) -> Res<Vault> {
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
    let id = uuid::Uuid::new_v4().to_string();
    let stage = parent.join(format!(".noviq-restore-{id}"));
    let target = parent.join(format!("Restored-{id}"));
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
        &serde_json::to_vec(&json!({"format":1,"id":id,"name":format!("{} (restored)",b.name)}))
            .map_err(err)?,
    )?;
    write_atomic(
        &stage.join("kv/workspace.json"),
        &serde_json::to_vec(&json!({"name":format!("{} (restored)",b.name)})).map_err(err)?,
    )?;
    // A fresh identity prevents this restored snapshot from overwriting an existing remote vault.
    fs::rename(&stage, &target).map_err(err)?;
    Vault::open(target)
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
        let restored = restore(&parent, serde_json::to_value(&backup).unwrap()).unwrap();
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
        assert!(restore(&parent, serde_json::to_value(&b).unwrap()).is_err());
        b.entries.insert(
            "../outside".into(),
            File {
                data: B64.encode(b"{}"),
                sha256: hash(b"{}"),
            },
        );
        assert!(restore(&parent, serde_json::to_value(&b).unwrap()).is_err());
    }
}
