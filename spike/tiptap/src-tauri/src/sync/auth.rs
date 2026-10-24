//! Google sign-in for the desktop app: OAuth 2.0 authorization-code flow with PKCE and a loopback redirect
//! (the recommended flow for installed apps). Only the `drive.appdata` scope is requested: the app can see
//! its own hidden folder in the user's Drive and nothing else.
//!
//! The refresh token goes to the OS credential store (Windows Credential Manager / macOS Keychain);
//! the e-mail address is kept in `account.json` for display.

use crate::vault::{err, now_ms, write_atomic, Res};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata openid email";
const KEYRING_SERVICE: &str = "noviq";
const KEYRING_USER: &str = "google-refresh-token";

#[derive(Clone)]
pub struct Creds {
    pub client_id: String,
    pub client_secret: String,
}

/// The OAuth client belongs to the app, not to the user: compiled in (NOVIQ_GOOGLE_CLIENT_ID / _SECRET at build time)
/// or read from `google-oauth.json` in the app-data folder. For a desktop client Google does not treat the secret as confidential.
pub fn creds(app_data: &Path) -> Option<Creds> {
    if let (Some(id), Some(secret)) = (option_env!("NOVIQ_GOOGLE_CLIENT_ID"), option_env!("NOVIQ_GOOGLE_CLIENT_SECRET")) {
        return Some(Creds { client_id: id.into(), client_secret: secret.into() });
    }
    let v: Value = serde_json::from_slice(&std::fs::read(app_data.join("google-oauth.json")).ok()?).ok()?;
    // accept Google's downloaded file ({"installed": {...}}) as well as the flat form
    let v = v.get("installed").cloned().unwrap_or(v);
    Some(Creds { client_id: v.get("client_id")?.as_str()?.into(), client_secret: v.get("client_secret")?.as_str()?.into() })
}

fn account_file(app_data: &Path) -> PathBuf {
    app_data.join("account.json")
}

pub fn email(app_data: &Path) -> Option<String> {
    let v: Value = serde_json::from_slice(&std::fs::read(account_file(app_data)).ok()?).ok()?;
    v.get("email")?.as_str().map(String::from)
}

fn store_refresh(app_data: &Path, token: &str, email: &str) -> Res<()> {
    let in_keyring = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).and_then(|e| e.set_password(token)).is_ok();
    let mut acc = serde_json::json!({ "email": email });
    if !in_keyring {
        acc["refresh"] = token.into(); // no credential store available: keep it in the app-data folder
    }
    write_atomic(&account_file(app_data), acc.to_string().as_bytes())
}

fn load_refresh(app_data: &Path) -> Option<String> {
    if let Some(t) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).and_then(|e| e.get_password()).ok() {
        return Some(t);
    }
    let v: Value = serde_json::from_slice(&std::fs::read(account_file(app_data)).ok()?).ok()?;
    v.get("refresh")?.as_str().map(String::from)
}

pub fn logout(app_data: &Path) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = e.delete_credential();
    }
    let _ = std::fs::remove_file(account_file(app_data));
}

fn http() -> Res<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build().map_err(err)
}

fn random_url_safe(n: usize) -> String {
    let mut bytes = vec![];
    while bytes.len() < n {
        bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    B64.encode(&bytes[..n])
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'?'));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(s: &str) -> String {
    s.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-._~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect()
}

/// Waits for Google to redirect the browser to us and returns the `code`.
fn wait_for_code(listener: TcpListener, state: &str) -> Res<String> {
    listener.set_nonblocking(true).map_err(err)?;
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        let Ok((mut s, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(100));
            continue;
        };
        s.set_nonblocking(false).ok();
        s.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let mut buf = [0u8; 4096];
        let n = s.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let query = req.lines().next().and_then(|l| l.split(' ').nth(1)).and_then(|p| p.split_once('?')).map(|x| x.1.to_string()).unwrap_or_default();
        let param = |k: &str| query.split('&').find_map(|kv| kv.strip_prefix(&format!("{k}="))).map(percent_decode);
        let reply = |s: &mut std::net::TcpStream, body: &str| {
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
        };
        if let Some(e) = param("error") {
            reply(&mut s, "<html><body style='font-family:sans-serif;text-align:center;margin-top:20vh'>Sign-in cancelled. You can close this tab.</body></html>");
            return Err(format!("sign-in failed: {e}"));
        }
        match (param("code"), param("state")) {
            (Some(code), Some(st)) if st == state => {
                reply(&mut s, "<html><body style='font-family:sans-serif;text-align:center;margin-top:20vh'><h2>Noviq</h2>Signed in. You can close this tab and return to the app.</body></html>");
                return Ok(code);
            }
            _ => reply(&mut s, "<html><body></body></html>"), // favicon and other stray requests
        }
    }
    Err("sign-in timed out".into())
}

/// Opens the browser, lets the user sign in, stores the refresh token and returns the account's e-mail.
pub fn login(c: &Creds, app_data: &Path) -> Res<String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(err)?.port());
    let verifier = random_url_safe(48);
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_url_safe(16);
    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&access_type=offline&prompt=consent",
        percent_encode(&c.client_id),
        percent_encode(&redirect),
        percent_encode(SCOPE)
    );
    open::that(&url).map_err(|e| format!("cannot open the browser: {e}"))?;
    let code = wait_for_code(listener, &state)?;
    let r: Value = http()?
        .post(TOKEN_URL)
        .form(&[
            ("client_id", c.client_id.as_str()),
            ("client_secret", c.client_secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .map_err(err)?
        .json()
        .map_err(err)?;
    let refresh = r.get("refresh_token").and_then(Value::as_str).ok_or_else(|| format!("no refresh token: {r}"))?;
    let email = r
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(|t| t.split('.').nth(1))
        .and_then(|p| B64.decode(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("email").and_then(Value::as_str).map(String::from))
        .unwrap_or_default();
    store_refresh(app_data, refresh, &email)?;
    Ok(email)
}

/// Hands out access tokens, refreshing them shortly before they expire.
pub struct Session {
    creds: Creds,
    app_data: PathBuf,
    token: String,
    expires_at: i64,
}

impl Session {
    pub fn new(creds: Creds, app_data: &Path) -> Session {
        Session { creds, app_data: app_data.to_path_buf(), token: String::new(), expires_at: 0 }
    }

    pub fn invalidate(&mut self) {
        self.expires_at = 0;
    }

    pub fn token(&mut self) -> Res<String> {
        if now_ms() < self.expires_at - 60_000 && !self.token.is_empty() {
            return Ok(self.token.clone());
        }
        let refresh = load_refresh(&self.app_data).ok_or("not signed in")?;
        let r: Value = http()?
            .post(TOKEN_URL)
            .form(&[
                ("client_id", self.creds.client_id.as_str()),
                ("client_secret", self.creds.client_secret.as_str()),
                ("refresh_token", refresh.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .map_err(err)?
            .json()
            .map_err(err)?;
        let t = r.get("access_token").and_then(Value::as_str).ok_or_else(|| format!("token refresh failed: {r}"))?;
        self.token = t.to_string();
        self.expires_at = now_ms() + r.get("expires_in").and_then(Value::as_i64).unwrap_or(3000) * 1000;
        Ok(self.token.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_codec_roundtrip() {
        let s = "http://127.0.0.1:5555/a b&c=é";
        assert_eq!(percent_decode(&percent_encode(s)), s);
        assert_eq!(percent_decode("4%2F0Abc%3D"), "4/0Abc=");
    }

    #[test]
    fn pkce_challenge_matches_the_rfc_example() {
        // RFC 7636 appendix B
        let c = B64.encode(Sha256::digest(b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        assert_eq!(c, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
