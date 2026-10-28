//! Desktop PKCE: system browser, bounded loopback callback, secure storage only.
use crate::vault::{now_ms, Res};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
const SCOPE: &str = "openid email https://www.googleapis.com/auth/drive.file";
struct Flow {
    listener: TcpListener,
    verifier: String,
    state: String,
    redirect: String,
    deadline: Instant,
    generation: u64,
}
static FLOW: Mutex<Option<Flow>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);
#[derive(Serialize, Deserialize, Clone)]
struct Credential {
    access: String,
    refresh: String,
    expires: i64,
    subject: String,
    email: String,
}
pub fn client_id() -> &'static str {
    option_env!("NEVIS_GOOGLE_CLIENT_ID").unwrap_or("")
}
fn entry() -> Res<keyring::Entry> {
    let service =
        option_env!("NEVIS_GOOGLE_CREDENTIAL_SERVICE").unwrap_or(if cfg!(debug_assertions) {
            "nevis.drive.preview.v1"
        } else {
            "nevis.drive.release.v1"
        });
    keyring::Entry::new(service, "google-oauth")
        .map_err(|_| "DRIVE:secure_storage_unavailable".into())
}
fn load() -> Res<Credential> {
    let s = entry()?
        .get_password()
        .map_err(|_| "DRIVE:sign_in_required")?;
    serde_json::from_str(&s).map_err(|_| "DRIVE:credential_corrupt".into())
}
fn save(c: &Credential) -> Res<()> {
    entry()?
        .set_password(&serde_json::to_string(c).map_err(|_| "DRIVE:credential_encoding")?)
        .map_err(|_| "DRIVE:secure_storage_unavailable".into())
}
pub fn status() -> Value {
    match load() {
        Ok(c) => {
            json!({"signedIn":true,"subject":c.subject,"email":c.email,"configured":!client_id().is_empty()})
        }
        Err(_) => json!({"signedIn":false,"configured":!client_id().is_empty()}),
    }
}
pub fn subject() -> Res<String> {
    Ok(load()?.subject)
}
pub fn disconnect() -> Res<()> {
    cancel();
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("DRIVE:secure_storage_unavailable".into()),
    }
}
pub fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut f) = FLOW.lock() {
        *f = None;
    }
}
pub fn begin() -> Res<Value> {
    if client_id().is_empty() {
        return Err("DRIVE:oauth_not_configured".into());
    }
    // Exercise credential-store access before launching the browser; no plaintext fallback.
    let key = entry()?;
    match key.get_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => (),
        Err(_) => return Err("DRIVE:secure_storage_unavailable".into()),
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "DRIVE:loopback_unavailable")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "DRIVE:loopback_unavailable")?;
    let redirect = format!(
        "http://127.0.0.1:{}/oauth2/callback",
        listener
            .local_addr()
            .map_err(|_| "DRIVE:loopback_unavailable")?
            .port()
    );
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let state = uuid::Uuid::new_v4().to_string();
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id()),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", SCOPE),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("state", state.as_str()),
        ("code_challenge_method", "S256"),
        (
            "code_challenge",
            URL_SAFE_NO_PAD
                .encode(Sha256::digest(verifier.as_bytes()))
                .as_str(),
        ),
    ]);
    *FLOW.lock().map_err(|_| "DRIVE:auth_lock")? = Some(Flow {
        listener,
        verifier,
        state,
        redirect,
        deadline: Instant::now() + Duration::from_secs(300),
        generation: GENERATION.fetch_add(1, Ordering::SeqCst) + 1,
    });
    if let Err(e) = open(url.as_str()) {
        cancel();
        return Err(e);
    }
    Ok(json!({"waiting":true,"expiresIn":300}))
}
fn open(url: &str) -> Res<()> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result
        .map(|_| ())
        .map_err(|_| "DRIVE:browser_unavailable".into())
}
fn http() -> Res<reqwest::blocking::Client> {
    super::transport::http()
}
fn token_response(r: reqwest::blocking::Response) -> Res<Value> {
    if !r.status().is_success() {
        return Err("DRIVE:sign_in_required".into());
    }
    super::transport::json_response(r, 64 * 1024)
}
fn expiry(token: &Value, now: i64) -> Res<i64> {
    token["expires_in"]
        .as_i64()
        .filter(|n| *n > 0 && *n <= 86_400)
        .and_then(|n| n.checked_mul(1000))
        .and_then(|n| now.checked_add(n))
        .ok_or("DRIVE:invalid_token_response".into())
}
fn callback(request: &[u8], expected: &str) -> Res<std::collections::BTreeMap<String, String>> {
    let line = std::str::from_utf8(request)
        .ok()
        .and_then(|s| s.lines().next())
        .ok_or("DRIVE:invalid_callback")?;
    let target = line
        .strip_prefix("GET ")
        .and_then(|s| s.strip_suffix(" HTTP/1.1"))
        .filter(|s| s.starts_with('/'))
        .ok_or("DRIVE:invalid_callback")?;
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "DRIVE:invalid_callback")?;
    if url.path() != "/oauth2/callback" || url.fragment().is_some() {
        return Err("DRIVE:invalid_callback".into());
    }
    let mut q = std::collections::BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if q.insert(key.into_owned(), value.into_owned()).is_some() {
            return Err("DRIVE:invalid_callback".into());
        }
    }
    if q.get("state").map(String::as_str) != Some(expected)
        || (q.contains_key("code") == q.contains_key("error"))
    {
        return Err("DRIVE:invalid_callback".into());
    }
    if q.get("code")
        .is_some_and(|c| c.is_empty() || c.len() > 4096)
    {
        return Err("DRIVE:invalid_callback".into());
    }
    Ok(q)
}
pub fn poll() -> Res<Value> {
    let mut guard = FLOW.lock().map_err(|_| "DRIVE:auth_lock")?;
    let f = guard.as_ref().ok_or("DRIVE:no_sign_in_pending")?;
    if Instant::now() >= f.deadline {
        *guard = None;
        return Err("DRIVE:oauth_timeout".into());
    }
    let (mut stream, _) = match f.listener.accept() {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(json!({"waiting":true})),
        Err(_) => return Err("DRIVE:loopback_unavailable".into()),
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "DRIVE:loopback_unavailable")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "DRIVE:loopback_unavailable")?;
    let mut request = [0u8; 8192];
    let n = stream
        .read(&mut request)
        .map_err(|_| "DRIVE:invalid_callback")?;
    let q = match callback(&request[..n], &f.state) {
        Ok(q) => q,
        Err(_) => {
            let _ = stream.write_all(
                b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return Ok(json!({"waiting":true}));
        }
    };
    let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 36\r\nConnection: close\r\n\r\nReturn to Nevis to finish signing in.");
    let f = guard.take().unwrap();
    drop(guard);
    if q.contains_key("error") {
        return Err("DRIVE:oauth_cancelled".into());
    }
    let code = q.get("code").ok_or("DRIVE:invalid_callback")?;
    let r = http()?
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id()),
            ("code", code),
            ("code_verifier", f.verifier.as_str()),
            ("redirect_uri", f.redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .map_err(|_| "DRIVE:network")?;
    let t = token_response(r)?;
    let access = t["access_token"]
        .as_str()
        .ok_or("DRIVE:invalid_token_response")?;
    let user = http()?
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(access)
        .send()
        .map_err(|_| "DRIVE:network")?;
    if !user.status().is_success() {
        return Err("DRIVE:identity_unavailable".into());
    }
    let user = super::transport::json_response(user, 64 * 1024)?;
    let c = Credential {
        access: access.into(),
        refresh: t["refresh_token"]
            .as_str()
            .ok_or("DRIVE:refresh_token_missing")?
            .into(),
        expires: expiry(&t, now_ms())?,
        subject: user["sub"]
            .as_str()
            .ok_or("DRIVE:identity_unavailable")?
            .into(),
        email: user["email"].as_str().unwrap_or("").into(),
    };
    if GENERATION.load(Ordering::SeqCst) != f.generation {
        return Err("DRIVE:oauth_cancelled".into());
    }
    if c.subject.is_empty()
        || c.subject.len() > 255
        || !c
            .subject
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("DRIVE:identity_unavailable".into());
    }
    save(&c)?;
    Ok(status())
}
/// Caller holds provider operation mutex: all token refreshes are serialized.
pub fn access(force: bool) -> Res<String> {
    let mut c = load()?;
    if force || now_ms() + 60_000 >= c.expires {
        let r = http()?
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("client_id", client_id()),
                ("refresh_token", c.refresh.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .map_err(|_| "DRIVE:network")?;
        let t = token_response(r)?;
        c.access = t["access_token"]
            .as_str()
            .ok_or("DRIVE:invalid_token_response")?
            .into();
        c.expires = expiry(&t, now_ms())?;
        if let Some(refresh) = t["refresh_token"].as_str() {
            c.refresh = refresh.into();
        }
        save(&c)?;
    }
    Ok(c.access)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_rejects_wrong_state_path_duplicates_and_error_with_code() {
        for target in [
            "/wrong?state=s&code=x",
            "/oauth2/callback?state=wrong&code=x",
            "/oauth2/callback?state=s&state=s&code=x",
            "/oauth2/callback?state=s&error=denied&code=x",
            "/oauth2/callback?state=s&code=",
        ] {
            assert!(callback(format!("GET {target} HTTP/1.1\r\n\r\n").as_bytes(), "s").is_err());
        }
        assert_eq!(
            callback(
                b"GET /oauth2/callback?state=s&code=secret HTTP/1.1\r\n\r\n",
                "s"
            )
            .unwrap()["code"],
            "secret"
        );
        assert!(callback(
            b"GET /oauth2/callback?state=s&error=access_denied HTTP/1.1\r\n\r\n",
            "s"
        )
        .unwrap()
        .contains_key("error"));
    }
    #[test]
    fn pkce_uses_s256_rfc7636_vector_and_bounded_expiry() {
        let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(
            expiry(&json!({"expires_in":3600}), 1000).unwrap(),
            3_601_000
        );
        for seconds in [-1, 0, i64::MAX] {
            assert!(expiry(&json!({"expires_in":seconds}), 1000).is_err());
        }
        assert!(expiry(&json!({"expires_in":3600}), i64::MAX).is_err());
    }
}
