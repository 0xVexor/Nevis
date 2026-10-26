//! The account of this device on the sync server: user name, which server, and the token of this device.
//! There is no e-mail address and no third party: an account is a user name, a password and a recovery key.
//! The device token is kept in the operating system's credential store (Windows Credential Manager / macOS Keychain);
//! the rest is in `account.json` in the app-data folder.

use super::hub::{solve_pow, Api};
use crate::vault::{err, write_atomic, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// NEVIS_SERVER selects the default server; NOVIQ_SERVER remains a compatible fallback.
/// A build environment that defines NOVIQ_SERVER as an empty string (an unset CI variable does that) means "no choice", not "no server".
pub const DEFAULT_SERVER: &str = match option_env!("NEVIS_SERVER") {
    Some(s) if !s.is_empty() => s,
    _ => match option_env!("NOVIQ_SERVER") {
        Some(s) if !s.is_empty() => s,
        _ => "https://sync.manaz.pro",
    },
};

const KEYRING_SERVICE: &str = "noviq";
const KEYRING_USER: &str = "device-token";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Account {
    pub server: String,
    pub username: String,
    pub user_id: String,
    pub device_id: String,
    /// only when no credential store is available
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
}

fn file(app_data: &Path) -> PathBuf {
    app_data.join("account.json")
}

pub fn load(app_data: &Path) -> Option<Account> {
    serde_json::from_slice(&std::fs::read(file(app_data)).ok()?).ok() // a file of the old Google sign-in has no `server`: not an account
}

pub fn token(app_data: &Path) -> Option<String> {
    let a = load(app_data)?;
    if !a.token.is_empty() {
        return Some(a.token);
    }
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?.get_password().ok()
}

fn store(app_data: &Path, mut a: Account, token: &str) -> Res<()> {
    let in_keyring = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).and_then(|e| e.set_password(token)).is_ok();
    a.token = if in_keyring { String::new() } else { token.to_string() };
    write_atomic(&file(app_data), &serde_json::to_vec(&a).map_err(err)?)
}

/// Forgets the account on this device. Vaults, files and sync bookkeeping stay.
pub fn clear(app_data: &Path) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = e.delete_credential();
    }
    let _ = std::fs::remove_file(file(app_data));
}

/// The leftovers of the Google sign-in of earlier versions: only when this app-data folder really holds that old
/// account file (it names an e-mail address and no server), so that nothing else in the credential store is touched.
pub fn forget_google(app_data: &Path) {
    let old = std::fs::read(file(app_data)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v| v.get("email").is_some() && v.get("server").is_none());
    if !old {
        return;
    }
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, "google-refresh-token") {
        let _ = e.delete_credential();
    }
    let _ = std::fs::remove_file(file(app_data));
}

/// `https://host`, or `http://` only for a server on this computer (development). Anything else is refused: a token must not travel in the clear.
pub fn normalize_server(s: &str) -> Res<String> {
    // nothing typed (or nothing known yet): the default server
    let s = Some(s.trim()).filter(|t| !t.is_empty()).unwrap_or(DEFAULT_SERVER).trim_end_matches('/');
    let s = if s.contains("://") { s.to_string() } else { format!("https://{s}") };
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://").filter(|r| ["localhost", "127.0.0.1", "[::1]"].iter().any(|h| r.starts_with(h)))).ok_or("HUB:insecure_server")?;
    if rest.is_empty() || rest.contains(char::is_whitespace) || rest.contains('?') || rest.contains('#') {
        return Err("HUB:bad_server".into());
    }
    let parsed = reqwest::Url::parse(&s).map_err(|_| "HUB:bad_server")?;
    if parsed.scheme() == "http" && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        return Err("HUB:insecure_server".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("HUB:bad_server".into());
    }
    Ok(s)
}

pub fn device_name() -> String {
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).or_else(|_| std::env::var("HOST")).unwrap_or_else(|_| "Nevis".to_string());
    format!("{host} ({})", std::env::consts::OS)
}

/// The signed-in account's API client, or `AUTH:signed_out`.
pub fn api(app_data: &Path) -> Res<Api> {
    let (a, t) = (load(app_data), token(app_data));
    match (a, t) {
        (Some(a), Some(t)) => Api::new(&a.server, Some(t)),
        _ => Err("AUTH:signed_out".into()),
    }
}

/// What the server says about itself: whether it takes new accounts, and whether they need an invite code.
pub fn health(server: &str) -> Res<Value> {
    let h = Api::new(&normalize_server(server)?, None)?.quick().get("/v1/health")?;
    // an address that answers, but is not a Nevis sync server (another app, a page of the hosting provider)
    if h["name"] != "noviq-sync" {
        return Err("HUB:not_noviq".into());
    }
    Ok(h)
}

fn work(api: &Api) -> Res<Value> {
    let ch = api.get("/v1/auth/challenge")?;
    let challenge = ch["challenge"].as_str().ok_or("HUB:bad_answer")?.to_string();
    let counter = solve_pow(&challenge, ch["bits"].as_u64().unwrap_or(0) as u32);
    Ok(json!({ "challenge": challenge, "counter": counter }))
}

fn merge(mut a: Value, b: Value) -> Value {
    if let (Some(x), Some(y)) = (a.as_object_mut(), b.as_object()) {
        for (k, v) in y {
            x.insert(k.clone(), v.clone());
        }
    }
    a
}

fn signed_in(app_data: &Path, server: &str, r: &Value) -> Res<()> {
    let account = Account {
        server: server.to_string(),
        username: r["user"]["username"].as_str().ok_or("HUB:bad_answer")?.to_string(),
        user_id: r["user"]["id"].as_str().unwrap_or("").to_string(),
        device_id: r["device"]["id"].as_str().unwrap_or("").to_string(),
        token: String::new(),
    };
    store(app_data, account, r["token"].as_str().ok_or("HUB:bad_answer")?)
}

/// Creates the account and signs in. Returns the recovery key, which is shown once and is the only way back in after a forgotten password.
pub fn register(app_data: &Path, server: &str, username: &str, password: &str, invite: &str) -> Res<String> {
    let server = normalize_server(server)?;
    let api = Api::new(&server, None)?;
    let body = merge(json!({ "username": username, "password": password, "invite": invite, "device_name": device_name() }), work(&api)?);
    let r = api.post("/v1/auth/register", &body)?;
    signed_in(app_data, &server, &r)?;
    Ok(r["recovery_key"].as_str().unwrap_or("").to_string())
}

pub fn login(app_data: &Path, server: &str, username: &str, password: &str) -> Res<()> {
    let server = normalize_server(server)?;
    let api = Api::new(&server, None)?;
    let r = api.post("/v1/auth/login", &json!({ "username": username, "password": password, "device_name": device_name() }))?;
    signed_in(app_data, &server, &r)
}

/// A new password with the recovery key. Signs in, logs every other device out, and returns the new recovery key.
pub fn recover(app_data: &Path, server: &str, username: &str, recovery_key: &str, new_password: &str) -> Res<String> {
    let server = normalize_server(server)?;
    let api = Api::new(&server, None)?;
    let body = merge(json!({ "username": username, "recovery_key": recovery_key, "new_password": new_password, "device_name": device_name() }), work(&api)?);
    let r = api.post("/v1/auth/recover", &body)?;
    signed_in(app_data, &server, &r)?;
    Ok(r["recovery_key"].as_str().unwrap_or("").to_string())
}

/// Signs out here: the token is revoked on the server (when it can be reached) and forgotten on this device either way.
pub fn logout(app_data: &Path) {
    if let Ok(api) = api(app_data) {
        let _ = api.quick().post("/v1/auth/logout", &json!({}));
    }
    clear(app_data);
}

pub fn info(app_data: &Path) -> Res<Value> {
    api(app_data)?.quick().get("/v1/account")
}

pub fn revoke_device(app_data: &Path, id: &str) -> Res<()> {
    let api = api(app_data)?;
    let url = api.url(&format!("/v1/devices/{id}"));
    api.send(|c| c.delete(&url)).map(|_| ())
}

pub fn change_password(app_data: &Path, old: &str, new: &str) -> Res<()> {
    api(app_data)?.post("/v1/auth/password", &json!({ "old_password": old, "new_password": new })).map(|_| ())
}

pub fn new_recovery_key(app_data: &Path, password: &str) -> Res<String> {
    let r = api(app_data)?.post("/v1/auth/recovery-key", &json!({ "password": password }))?;
    Ok(r["recovery_key"].as_str().unwrap_or("").to_string())
}

/// Asks the server to delete the account after a grace period; this device is signed out.
pub fn delete_account(app_data: &Path, password: &str) -> Res<i64> {
    let api = api(app_data)?;
    let url = api.url("/v1/account");
    let r: Value = api.send(|c| c.delete(&url).json(&json!({ "password": password })))?.json().map_err(err)?;
    clear(app_data);
    Ok(r["delete_after"].as_i64().unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn servers_are_https_unless_they_are_on_this_computer() {
        assert_eq!(normalize_server("sync.example.com").unwrap(), "https://sync.example.com");
        assert_eq!(normalize_server(" https://sync.example.com/ ").unwrap(), "https://sync.example.com");
        assert_eq!(normalize_server("http://localhost:3000").unwrap(), "http://localhost:3000");
        assert_eq!(normalize_server("http://127.0.0.1:3111/").unwrap(), "http://127.0.0.1:3111");
        assert!(normalize_server("http://sync.example.com").is_err());
        assert_eq!(normalize_server("").unwrap(), DEFAULT_SERVER);
        assert_eq!(normalize_server("   ").unwrap(), DEFAULT_SERVER);
        assert!(!DEFAULT_SERVER.is_empty());
        assert!(normalize_server("https://bad host").is_err());
        assert!(normalize_server("https://user:secret@sync.example.com").is_err());
        assert!(normalize_server("http://localhost.example.com").is_err());
    }

    #[test]
    fn an_old_google_account_file_is_not_an_account() {
        let dir = std::env::temp_dir().join(format!("noviq-acc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("account.json"), br#"{"email":"a@b.c","refresh":"x"}"#).unwrap();
        assert!(load(&dir).is_none());
        forget_google(&dir);
        assert!(!dir.join("account.json").exists());
        // a real account file is never taken for a leftover
        write_atomic(&dir.join("account.json"), br#"{"server":"https://s","username":"u","user_id":"1","device_id":"2"}"#).unwrap();
        forget_google(&dir);
        assert!(load(&dir).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
