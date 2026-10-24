//! The list of vaults known on this device (not synced) and which one is open. Lives in the app-data folder.

use crate::vault::{err, write_atomic, Res};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub path: String,
    /// keep this vault in sync with the signed-in Google account
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
}

fn file(app_data: &Path) -> PathBuf {
    app_data.join("config.json")
}

impl Registry {
    /// Reads config.json. The first version only had `{"vault": "<path>"}`; that vault is adopted as the first entry.
    pub fn load(app_data: &Path) -> Registry {
        let Some(raw) = std::fs::read(file(app_data)).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else {
            return Registry::default();
        };
        if let Ok(r) = serde_json::from_value::<Registry>(raw.clone()) {
            if raw.get("vaults").is_some() {
                return r;
            }
        }
        match raw.get("vault").and_then(|v| v.as_str()) {
            Some(p) if Path::new(p).join(".noviq/vault.json").exists() => {
                let v = crate::vault::Vault::open(PathBuf::from(p)).ok();
                match v {
                    Some(v) => Registry { current: Some(v.id()), vaults: vec![Entry { id: v.id(), name: v.name(), path: p.to_string(), sync: false }] },
                    None => Registry::default(),
                }
            }
            _ => Registry::default(),
        }
    }

    pub fn save(&self, app_data: &Path) -> Res<()> {
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
        let d = std::env::temp_dir().join(format!("noviq-reg-{}", crate::vault::now_ms()));
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
}
