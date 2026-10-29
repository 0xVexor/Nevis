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
    if !r.stage.exists() && (r.complete || state.join("journal.json").exists()) {
        return Err(if r.complete {
            "DRIVE:download_target_missing"
        } else {
            "DRIVE:download_stage_missing"
        }
        .into());
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
        fs::remove_dir_all(&target).unwrap();
        assert_eq!(
            install(&state, &b, &root, "Notes", |_| panic!(
                "missing completed target must never be replaced by an empty vault"
            ))
            .unwrap_err(),
            "DRIVE:download_target_missing"
        );
        assert!(!target.exists());
        let lost_state = root.join("lost-state");
        assert_eq!(
            install(&lost_state, &b, &root, "Lost", |_| {
                write_atomic(&lost_state.join("journal.json"), b"{}")?;
                Err("DRIVE:network".into())
            })
            .unwrap_err(),
            "DRIVE:network"
        );
        let lost: Receipt =
            serde_json::from_slice(&fs::read(lost_state.join("download.json")).unwrap()).unwrap();
        fs::remove_dir_all(&lost.stage).unwrap();
        assert_eq!(
            install(&lost_state, &b, &root, "Lost", |_| panic!(
                "lost stage must not become local deletion input"
            ))
            .unwrap_err(),
            "DRIVE:download_stage_missing"
        );
        assert!(!lost.stage.exists());
        fs::remove_dir_all(root).unwrap();
    }
}

/// Allocate only a new user-selected local folder. Existing folders, even empty
/// ones, are never adopted or overwritten by the Drive create flow.
pub fn create_local(parent: &std::path::Path, name: &str) -> Res<crate::vault::Vault> {
    use std::path::Component;
    if !parent.is_absolute() || !parent.is_dir() {
        return Err("DRIVE:invalid_parent".into());
    }
    let mut parts = std::path::Path::new(name).components();
    if !matches!(parts.next(), Some(Component::Normal(_)))
        || parts.next().is_some()
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("DRIVE:invalid_workspace_name".into());
    }
    let target = parent.join(name);
    match std::fs::create_dir(&target) {
        Ok(()) => crate::vault::Vault::create(target, name),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("DRIVE:target_exists".into())
        }
        Err(error) => Err(crate::vault::err(error)),
    }
}
/// Publish only after local registration succeeds. A cloud error leaves the new
/// local workspace intact and registered for explicit retry/opening.
pub fn create_and_connect(
    parent: &std::path::Path,
    name: &str,
    activate: impl FnOnce(&str, &std::path::Path) -> Res<()>,
    connect: impl FnOnce(&str) -> Res<serde_json::Value>,
) -> Res<serde_json::Value> {
    let vault = create_local(parent, name)?;
    let id = vault.id();
    let path = vault.root.clone();
    drop(vault);
    activate(&id, &path)?;
    connect(&id)
}
#[cfg(test)]
mod create_tests {
    use super::*;
    #[test]
    fn cloud_setup_failure_keeps_registered_local_workspace_and_never_claims_success() {
        use std::cell::RefCell;
        let root = std::env::temp_dir().join(format!("nevis-drive-flow-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let registered = RefCell::new(None);
        let result = create_and_connect(
            &root,
            "Offline",
            |id, path| {
                assert!(path.join(".noviq/vault.json").exists());
                *registered.borrow_mut() = Some(id.to_string());
                Ok(())
            },
            |id| {
                assert_eq!(registered.borrow().as_deref(), Some(id));
                Err("DRIVE:network".into())
            },
        );
        assert_eq!(result.unwrap_err(), "DRIVE:network");
        let local = crate::vault::Vault::open(root.join("Offline")).unwrap();
        assert_eq!(registered.borrow().as_deref(), Some(local.id().as_str()));
        assert_eq!(local.name(), "Offline");
        drop(local);
        let result = create_and_connect(
            &root,
            "Registration failed",
            |_, _| Err("LOCAL:write_failed".into()),
            |_| panic!("cloud must not be contacted before registration"),
        );
        assert_eq!(result.unwrap_err(), "LOCAL:write_failed");
        assert!(root.join("Registration failed/.noviq/vault.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn new_drive_workspace_preserves_existing_targets_and_has_its_own_identity() {
        let root =
            std::env::temp_dir().join(format!("nevis-drive-create-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let a = create_local(&root, "First").unwrap();
        let b = create_local(&root, "Second").unwrap();
        assert_ne!(a.id(), b.id());
        assert_eq!(a.name(), "First");
        assert_eq!(
            create_local(&root, "First").err().unwrap(),
            "DRIVE:target_exists"
        );
        let unrelated = root.join("Unrelated");
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(unrelated.join("keep.txt"), b"keep").unwrap();
        assert_eq!(
            create_local(&root, "Unrelated").err().unwrap(),
            "DRIVE:target_exists"
        );
        assert_eq!(std::fs::read(unrelated.join("keep.txt")).unwrap(), b"keep");
        for name in ["../outside", "", ".", "/absolute", "nested/name"] {
            assert!(create_local(&root, name).is_err());
        }
        assert_eq!(
            create_local(std::path::Path::new("relative"), "Vault")
                .err()
                .unwrap(),
            "DRIVE:invalid_parent"
        );
        drop(a);
        drop(b);
        std::fs::remove_dir_all(root).unwrap();
    }
}
