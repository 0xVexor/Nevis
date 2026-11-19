//! The list of vaults known on this device (not synced) and which one is open. Lives in the app-data folder.

use crate::vault::{err, write_atomic, Res};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub path: String,
    /// keep this vault in sync with the sync server of the signed-in account
    #[serde(default)]
    pub sync: bool,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Registry {
    #[serde(default)]
    pub vaults: Vec<Entry>,
    /// id of the vault that is open; None = show the vault picker
    #[serde(default)]
    pub current: Option<String>,
    /// config.json exists but could not be read or parsed; saving would overwrite the real list, so it is refused
    #[serde(skip)]
    unreadable: bool,
}

/// Error code the UI shows when the workspace list could not be read.
pub const UNREADABLE: &str = "REGISTRY:unreadable";

fn file(app_data: &Path) -> PathBuf {
    app_data.join("config.json")
}

impl Registry {
    /// Reads config.json. A missing file is an empty registry; a file that cannot be read or parsed is kept
    /// (a timestamped copy is written next to it) and the registry refuses to save.
    /// The first version only had `{"vault": "<path>"}`; that vault is adopted as the first entry.
    pub fn load(app_data: &Path) -> Registry {
        let path = file(app_data);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Registry::default(),
            Err(e) => {
                eprintln!("cannot read {}: {e}", path.display());
                return Registry::broken();
            }
        };
        let Some(raw) = serde_json::from_slice::<serde_json::Value>(&bytes).ok().filter(|v| v.is_object()) else {
            return Registry::broken_backup(&path, &bytes);
        };
        if let Ok(r) = serde_json::from_value::<Registry>(raw.clone()) {
            if raw.get("vaults").is_some() {
                return r;
            }
        } else if raw.get("vaults").is_some() {
            return Registry::broken_backup(&path, &bytes);
        }
        match raw.get("vault").and_then(|v| v.as_str()) {
            Some(p) if crate::vault::marker_path(Path::new(p)).exists() => {
                let v = crate::vault::Vault::open(PathBuf::from(p)).ok();
                match v {
                    Some(v) => Registry { current: Some(v.id()), vaults: vec![Entry { id: v.id(), name: v.name(), path: p.to_string(), sync: false }], ..Registry::default() },
                    None => Registry::default(),
                }
            }
            _ => Registry::default(),
        }
    }

    fn broken() -> Registry {
        Registry { unreadable: true, ..Registry::default() }
    }

    fn broken_backup(path: &Path, bytes: &[u8]) -> Registry {
        let copy = path.with_file_name(format!("config.json.corrupt-{}", crate::vault::now_ms()));
        if let Err(e) = std::fs::write(&copy, bytes) {
            eprintln!("cannot back up the unreadable {}: {e}", path.display());
        }
        Registry::broken()
    }

    pub fn is_unreadable(&self) -> bool {
        self.unreadable
    }

    pub fn save(&self, app_data: &Path) -> Res<()> {
        if self.unreadable {
            return Err(UNREADABLE.into());
        }
        write_atomic(&file(app_data), &serde_json::to_vec(self).map_err(err)?)
    }

    pub fn find(&self, id: &str) -> Option<&Entry> {
        self.vaults.iter().find(|e| e.id == id)
    }

    /// Adds or updates (same id) an entry.
    pub fn add(&mut self, e: Entry) {
        match self.vaults.iter_mut().find(|x| x.id == e.id) {
            Some(x) => *x = e,
            None => self.vaults.push(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adopts_the_old_single_vault_config() {
        let d = std::env::temp_dir().join(format!("nevis-reg-{}", crate::vault::now_ms()));
        let vault = d.join("MyVault");
        let v = crate::vault::Vault::create(vault.clone(), "Mine").unwrap();
        write_atomic(&d.join("config.json"), serde_json::json!({ "vault": vault.to_string_lossy() }).to_string().as_bytes()).unwrap();
        let r = Registry::load(&d);
        assert_eq!(r.vaults.len(), 1);
        assert_eq!(r.vaults[0].name, "Mine");
        assert_eq!(r.current.as_deref(), Some(v.id().as_str()));
        r.save(&d).unwrap();
        assert_eq!(Registry::load(&d).vaults, r.vaults); // the new format round-trips
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nevis-reg-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_missing_file_is_an_empty_registry_that_saves() {
        let d = tmp("missing");
        let r = Registry::load(&d);
        assert!(!r.is_unreadable() && r.vaults.is_empty());
        r.save(&d).unwrap();
    }

    #[test]
    fn an_unparsable_file_is_kept_backed_up_and_never_overwritten() {
        for (i, bad) in ["{ not json", "[]", r#"{"vaults": 5}"#].iter().enumerate() {
            let d = tmp(&format!("bad{i}"));
            std::fs::write(d.join("config.json"), bad).unwrap();
            let r = Registry::load(&d);
            assert!(r.is_unreadable());
            assert_eq!(r.save(&d).unwrap_err(), UNREADABLE);
            assert_eq!(std::fs::read_to_string(d.join("config.json")).unwrap(), *bad);
            let copies: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("config.json.corrupt-")).collect();
            assert_eq!(copies.len(), 1);
            assert_eq!(std::fs::read_to_string(copies[0].path()).unwrap(), *bad);
        }
    }

    #[test]
    fn a_config_that_cannot_be_read_refuses_to_save() {
        let d = tmp("dir");
        std::fs::create_dir(d.join("config.json")).unwrap(); // reading a directory fails with something other than NotFound
        let r = Registry::load(&d);
        assert!(r.is_unreadable());
        assert_eq!(r.save(&d).unwrap_err(), UNREADABLE);
    }
}
