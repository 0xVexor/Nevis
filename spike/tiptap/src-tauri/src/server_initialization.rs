//! Immutable, vault-local initialization bytes. Credentials are never stored here.
use crate::vault::{commit_lock, err, write_atomic, Res, Vault};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}};

const MAX_UPDATE: usize = 2 * 1024 * 1024;

fn record_path(root: &Path, vault_id: &str, account_id: &str, origin: &str, document_id: &str) -> Res<PathBuf> {
    if vault_id.is_empty() || vault_id.len() > 256 || account_id.is_empty() || account_id.len() > 256 {
        return Err("Invalid initialization scope".into());
    }
    if document_id.is_empty() || document_id.len() > 128 || !document_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("Invalid document ID".into());
    }
    let url = reqwest::Url::parse(origin).map_err(|_| "Invalid collaboration origin")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if !url.username().is_empty() || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local)) {
        return Err("Invalid collaboration origin".into());
    }
    let normalized = url.origin().ascii_serialization();
    let identity = serde_json::to_vec(&(vault_id, account_id, normalized, document_id)).map_err(err)?;
    let name = format!("{:x}.bin", Sha256::digest(identity));
    Ok(root.join(".nevis/server-initializations").join(name))
}

fn read(path: &Path) -> Res<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) if !bytes.is_empty() && bytes.len() <= MAX_UPDATE => Ok(Some(bytes)),
        Ok(_) => Err("Invalid saved initialization".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(err(error)),
    }
}

fn ensure_directory(root: &Path, dir: &Path) -> Res<()> {
    if !dir.exists() {
        fs::create_dir(dir).or_else(|error| if dir.is_dir() { Ok(()) } else { Err(error) }).map_err(err)?;
        #[cfg(unix)]
        fs::File::open(root.join(".nevis")).and_then(|f| f.sync_all()).map_err(err)?;
        #[cfg(not(unix))]
        let _ = root;
    }
    Ok(())
}

pub fn load(vault: &Vault, expected_vault_id: &str, account_id: &str, origin: &str, document_id: &str) -> Res<Option<Vec<u8>>> {
    if vault.id() != expected_vault_id { return Err("Initialization vault unavailable".into()); }
    let path = record_path(&vault.root, expected_vault_id, account_id, origin, document_id)?;
    let _lock = commit_lock(&vault.root)?;
    read(&path)
}

pub fn prepare(vault: &Vault, expected_vault_id: &str, account_id: &str, origin: &str, document_id: &str, bytes: &[u8], expected_page: &serde_json::Value) -> Res<Vec<u8>> {
    if vault.id() != expected_vault_id { return Err("Initialization vault unavailable".into()); }
    if bytes.is_empty() || bytes.len() > MAX_UPDATE { return Err("Invalid initialization size".into()); }
    if expected_page["id"].as_str() != Some(document_id) { return Err("Invalid initialization page".into()); }
    let path = record_path(&vault.root, expected_vault_id, account_id, origin, document_id)?;
    let _lock = commit_lock(&vault.root)?;
    let current = fs::read(vault.page_path(document_id)?).map_err(|_| "Initialization page unavailable")?;
    let current: serde_json::Value = serde_json::from_slice(&current).map_err(|_| "Initialization page unreadable")?;
    if &current != expected_page { return Err("Initialization page changed".into()); }
    if let Some(existing) = read(&path)? {
        if existing != bytes { return Err("Initialization already prepared with different bytes".into()); }
        return Ok(existing);
    }
    ensure_directory(&vault.root, path.parent().ok_or("Invalid initialization path")?)?;
    write_atomic(&path, bytes)?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_is_immutable_and_vault_bound() {
        let root = std::env::temp_dir().join(format!("nevis-initialization-{}", uuid::Uuid::new_v4()));
        let vault = Vault::create(root.clone(), "Test").unwrap();
        let id = vault.id();
        let origin = "https://sync.example";
        assert_eq!(load(&vault, &id, "account", origin, "page").unwrap(), None);
        let page = serde_json::json!({"id": "page", "content": "before"});
        write_atomic(&vault.page_path("page").unwrap(), page.to_string().as_bytes()).unwrap();
        assert!(prepare(&vault, &id, "account", origin, "page", &[1, 2], &serde_json::json!({"id":"page", "content":"stale"})).is_err());
        assert_eq!(prepare(&vault, &id, "account", origin, "page", &[1, 2], &page).unwrap(), vec![1, 2]);
        assert_eq!(prepare(&vault, &id, "account", "https://sync.example:443/", "page", &[1, 2], &page).unwrap(), vec![1, 2]);
        assert!(prepare(&vault, &id, "account", origin, "page", &[3], &page).is_err());
        assert_eq!(load(&vault, &id, "account", origin, "page").unwrap(), Some(vec![1, 2]));
        assert_eq!(load(&vault, &id, "other", origin, "page").unwrap(), None);
        assert!(load(&vault, "different", "account", origin, "page").is_err());
        assert!(prepare(&vault, &id, "account", "http://remote.example", "page", &[1], &page).is_err());
        drop(vault);
        fs::remove_dir_all(root).unwrap();
    }
}
