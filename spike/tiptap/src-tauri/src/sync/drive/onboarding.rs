//! Durable new-folder installation. Interrupted downloads resume their owned staging folder.
use super::{core::bytes, Binding};
use crate::vault::{err, write_atomic, Res, Vault};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    vault: String,
    folder: String,
    target: PathBuf,
    stage: PathBuf,
    token: String,
    complete: bool,
}
fn owned(v: &Vault, token: &str) -> Res<()> {
    let expected = bytes(&json!({"token":token,"vaultId":v.id()}))?;
    if fs::read(v.root.join(".noviq/drive-download-receipt.json"))
        .map_err(|_| "DRIVE:download_ownership_missing")?
        != expected
    {
        return Err("DRIVE:download_ownership_mismatch".into());
    }
    Ok(())
}
pub fn install(
    state: &Path,
    b: &Binding,
    parent: &Path,
    name: &str,
    mut populate: impl FnMut(&Vault) -> Res<()>,
) -> Res<PathBuf> {
    let receipt_path = state.join("download.json");
    let target = parent.join(name);
    let mut r: Receipt = match fs::read(&receipt_path) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|_| "DRIVE:download_receipt_corrupt")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if target.exists() {
                return Err("DRIVE:target_exists".into());
            }
            let r = Receipt {
                schema_version: 1,
                vault: b.vault_id.clone(),
                folder: b.folder_id.clone(),
                target: target.clone(),
                stage: parent.join(format!(".nevis-drive-stage-{}", uuid::Uuid::new_v4())),
                token: uuid::Uuid::new_v4().to_string(),
                complete: false,
            };
            write_atomic(&receipt_path, &bytes(&r)?)?;
            r
        }
        Err(e) => return Err(err(e)),
    };
    if r.schema_version != 1
        || r.vault != b.vault_id
        || r.folder != b.folder_id
        || r.target != target
        || r.stage.parent() != Some(parent)
        || !r
            .stage
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(".nevis-drive-stage-"))
        || uuid::Uuid::parse_str(&r.token).is_err()
    {
        return Err("DRIVE:download_recovery_pending".into());
    }
    if r.target.exists() {
        if !r.complete || r.stage.exists() {
            return Err("DRIVE:target_exists".into());
        }
        let v = Vault::open_as(r.target.clone(), &r.vault)?;
        owned(&v, &r.token)?;
        return Ok(r.target);
    }
    let v = if r.stage.exists() {
        Vault::open_as(r.stage.clone(), &r.vault)?
    } else {
        Vault::create_with_id(r.stage.clone(), name, &r.vault)?
    };
    let marker = v.root.join(".noviq/drive-download-receipt.json");
    if marker.exists() {
        owned(&v, &r.token)?;
    } else {
        write_atomic(
            &marker,
            &bytes(&json!({"token":r.token,"vaultId":r.vault}))?,
        )?;
    }
    if !r.complete {
        populate(&v)?;
        v.fence_drive()?;
        r.complete = true;
        write_atomic(&receipt_path, &bytes(&r)?)?;
    }
    v.ensure_exclusive()?;
    drop(v); // Windows must release handles before moving the directory.
    fs::rename(&r.stage, &r.target).map_err(err)?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(err)?;
    let v = Vault::open_as(r.target.clone(), &r.vault)?;
    owned(&v, &r.token)?;
    Ok(r.target)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_stage_resumes_without_replacing_an_existing_target() {
        let root = std::env::temp_dir().join(format!("nevis-download-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let b = Binding {
            schema_version: 1,
            subject: "s".into(),
            root_id: "root".into(),
            vault_id: uuid::Uuid::new_v4().to_string(),
            folder_id: "folder".into(),
            objects_id: "objects".into(),
            streams_id: "streams".into(),
            checkpoints_id: "checkpoints".into(),
            backup: String::new(),
            paused: false,
        };
        let state = root.join("state");
        assert_eq!(
            install(&state, &b, &root, "Notes", |v| {
                write_atomic(&v.root.join("kv/settings.json"), b"{\"local\":true}")?;
                Err("DRIVE:network".into())
            })
            .unwrap_err(),
            "DRIVE:network"
        );
        let target = install(&state, &b, &root, "Notes", |v| {
            assert_eq!(
                fs::read(v.root.join("kv/settings.json")).unwrap(),
                b"{\"local\":true}"
            );
            Ok(())
        })
        .unwrap();
        assert!(Vault::open_as(target.clone(), &b.vault_id)
            .unwrap()
            .requires_drive());
        assert_eq!(
            install(&state, &b, &root, "Notes", |_| panic!(
                "completed stage must not repopulate"
            ))
            .unwrap(),
            target
        );
        assert_eq!(
            install(&root.join("other"), &b, &root, "Notes", |_| Ok(())).unwrap_err(),
            "DRIVE:target_exists"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
