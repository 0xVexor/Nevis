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

#[cfg(test)]
mod tests {
    use super::*;

    /// The REAL keychain (keyring 4 under its default `v1` feature). Ignored by default: the first run on a Mac may ask for
    /// permission. Run once by hand: `cargo test -- --ignored keychain`.
    #[test]
    #[ignore]
    fn keychain_set_get_delete_round_trip() {
        let k = Keychain;
        let server = format!("http://nevis-test-{}.invalid", std::process::id());
        assert_eq!(k.get(&server), None);
        k.set(&server, "tok-123").expect("set");
        assert_eq!(k.get(&server).as_deref(), Some("tok-123"), "get returned nothing right after set: every restart would sign the user out");
        k.delete(&server);
        assert_eq!(k.get(&server), None);
    }

    #[test]
    fn file_backend_round_trip() {
        let p = std::env::temp_dir().join(format!("nevis-tokens-{}", std::process::id()));
        let f = FileTokens(p.clone());
        f.set("http://a", "1").unwrap(); f.set("http://b", "2").unwrap(); f.set("http://a", "3").unwrap();
        assert_eq!(f.get("http://a").as_deref(), Some("3"));
        f.delete("http://a");
        assert_eq!((f.get("http://a"), f.get("http://b").as_deref()), (None, Some("2")));
        std::fs::remove_file(p).ok();
    }
}
