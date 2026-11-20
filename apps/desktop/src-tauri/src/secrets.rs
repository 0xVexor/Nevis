//! Where the device token lives (ADR-0006/0007): the OS keychain. JavaScript never receives it.
//! A file backend exists for automated runs only (`NEVIS_TEST_TOKEN_FILE`): an unsigned macOS build asks for the keychain
//! password again after every rebuild, and a prompt would hang a self-test. The real keychain is covered by the owner's checklist.
use std::path::PathBuf;

pub trait TokenStore: Send + Sync {
    fn get(&self, server: &str) -> Option<String>;
    fn set(&self, server: &str, token: &str) -> Result<(), String>;
    fn delete(&self, server: &str);
}

pub struct Keychain;
const SERVICE: &str = "app.nevis.desktop";

impl TokenStore for Keychain {
    fn get(&self, server: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, server).ok()?.get_password().ok()
    }
    fn set(&self, server: &str, token: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, server).map_err(|e| e.to_string())?.set_password(token).map_err(|e| e.to_string())
    }
    fn delete(&self, server: &str) {
        if let Ok(e) = keyring::Entry::new(SERVICE, server) { let _ = e.delete_credential(); }
    }
}

/// Test backend: one file, `<server>\t<token>` per line.
pub struct FileTokens(pub PathBuf);
impl FileTokens {
    fn load(&self) -> Vec<(String, String)> {
        std::fs::read_to_string(&self.0).unwrap_or_default().lines().filter_map(|l| l.split_once('\t').map(|(a, b)| (a.to_string(), b.to_string()))).collect()
    }
    fn save(&self, rows: &[(String, String)]) {
        let text: String = rows.iter().map(|(a, b)| format!("{a}\t{b}\n")).collect();
        let _ = std::fs::write(&self.0, text);
    }
}
impl TokenStore for FileTokens {
    fn get(&self, server: &str) -> Option<String> { self.load().into_iter().find(|(s, _)| s == server).map(|(_, t)| t) }
    fn set(&self, server: &str, token: &str) -> Result<(), String> {
        let mut rows: Vec<_> = self.load().into_iter().filter(|(s, _)| s != server).collect();
        rows.push((server.to_string(), token.to_string()));
        self.save(&rows);
        Ok(())
    }
    fn delete(&self, server: &str) {
        let rows: Vec<_> = self.load().into_iter().filter(|(s, _)| s != server).collect();
        self.save(&rows);
    }
}

pub fn from_env() -> Box<dyn TokenStore> {
    match std::env::var("NEVIS_TEST_TOKEN_FILE") {
        Ok(p) if !p.is_empty() => Box::new(FileTokens(PathBuf::from(p))),
        _ => Box::new(Keychain),
    }
}
