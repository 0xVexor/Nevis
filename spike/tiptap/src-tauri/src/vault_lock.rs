//! A live Vault owns an OS lock. Same-process readers/workers share the handle,
//! while another application process receives VAULT_IN_USE before native writes.
use crate::vault::{err, Res};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    sync::{Arc, Mutex, OnceLock, Weak},
};
pub struct Guard {
    _file: File,
    identity: same_file::Handle,
}
static LOCKS: OnceLock<Mutex<Vec<Weak<Guard>>>> = OnceLock::new();
pub fn acquire(root: &Path) -> Res<Arc<Guard>> {
    for p in [
        root.to_path_buf(),
        root.join(".noviq"),
        root.join(".noviq/vault-write.lock"),
    ] {
        if fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("STORAGE:symlink".into());
        }
    }
    if !root.is_dir() || !root.join(".noviq").is_dir() {
        return Err("VAULT_MISSING".into());
    }
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(vec![]))
        .lock()
        .map_err(err)?;
    locks.retain(|w| w.strong_count() > 0);
    let path = root.join(".noviq/vault-write.lock");
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|_| "VAULT_LOCK_UNAVAILABLE")?;
    let identity = same_file::Handle::from_path(&path).map_err(|_| "VAULT_LOCK_UNAVAILABLE")?;
    for weak in locks.iter() {
        if let Some(lock) = weak.upgrade() {
            if lock.identity == identity {
                return Ok(lock);
            }
        }
    }
    file.try_lock().map_err(|e| match e {
        fs::TryLockError::WouldBlock => "VAULT_IN_USE".to_string(),
        fs::TryLockError::Error(_) => "VAULT_LOCK_UNAVAILABLE".to_string(),
    })?;
    let held = same_file::Handle::from_file(file.try_clone().map_err(err)?).map_err(err)?;
    if held != identity {
        return Err("VAULT_LOCK_LOST".into());
    }
    let guard = Arc::new(Guard {
        _file: file,
        identity: held,
    });
    locks.push(Arc::downgrade(&guard));
    Ok(guard)
}
impl Guard {
    pub fn check(&self, root: &Path) -> Res<()> {
        let path = root.join(".noviq/vault-write.lock");
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("VAULT_LOCK_LOST".into());
        }
        let current = same_file::Handle::from_path(&path).map_err(|_| "VAULT_LOCK_LOST")?;
        if current != self.identity {
            return Err("VAULT_LOCK_LOST".into());
        }
        Ok(())
    }
}
