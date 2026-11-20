//! The network of the desktop app (ADR-0007): requests are made HERE, with the device token from the keychain added here.
//! JavaScript names a path under `/v1/` and a body. It cannot choose the host, cannot send its own `Authorization`, and never
//! sees the token: not in a request, not in a response (`strip_token` for sign-in, `guard` as a last line for everything).
use crate::secrets::TokenStore;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug)]
pub struct NetResponse { pub status: u16, pub text: String }

/// Only `/v1/...`, no way out of that prefix.
pub fn check_path(path: &str) -> Result<(), String> {
    let ok = path.starts_with("/v1/") && !path.contains("..") && !path.contains('\\') && !path.contains("//") && !path.contains('@') && !path.chars().any(|c| c.is_control() || c == ' ');
    if ok { Ok(()) } else { Err(format!("path not allowed: {path}")) }
}

pub fn check_server(url: &str) -> Result<String, String> {
    let u = url.trim().trim_end_matches('/');
    let rest = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).ok_or("the server address must start with http:// or https://")?;
    if rest.is_empty() || rest.contains('/') || rest.contains('@') || rest.contains('?') || rest.contains('#') || rest.contains(' ') { return Err("the server address is not valid".into()); }
    Ok(u.to_string())
}

/// A response JSON without the `token` of a sign-in/sign-up: it goes to the keychain, not to JavaScript.
pub fn strip_token(text: &str) -> (Option<String>, String) {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(mut m)) => {
            let t = m.remove("token").and_then(|v| v.as_str().map(str::to_string));
            (t, Value::Object(m).to_string())
        }
        _ => (None, text.to_string()),
    }
}

/// Refuses to hand JavaScript anything that contains the current token.
pub fn guard(tokens: &dyn TokenStore, server: &str, out: &str) -> Result<(), String> {
    match tokens.get(server) {
        Some(t) if !t.is_empty() && out.contains(&t) => Err("blocked: the response contained the device token".into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::FileTokens;

    #[test]
    fn paths_stay_under_v1() {
        assert!(check_path("/v1/ws").is_ok());
        assert!(check_path("/v1/ws/abc/ops?after=0&limit=1&wait=25").is_ok());
        for bad in ["/other", "v1/ws", "/v1/../x", "//evil.com/v1/", "/v1/@evil.com", "/v1/a b", "http://evil.com/v1/x", "/v1/a\\b"] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn server_is_an_origin_only() {
        assert_eq!(check_server("http://localhost:8788/").unwrap(), "http://localhost:8788");
        assert!(check_server("localhost:8788").is_err());
        assert!(check_server("https://u:p@evil.com").is_err());
        assert!(check_server("https://a.com/path").is_err());
    }
    #[test]
    fn the_token_is_taken_out_of_a_sign_in_response() {
        let (t, rest) = strip_token(r#"{"token":"SECRET-123","account":{"username":"a"},"recoveryKey":"k"}"#);
        assert_eq!(t.as_deref(), Some("SECRET-123"));
        assert!(!rest.contains("SECRET-123") && rest.contains("recoveryKey"));
    }
    #[test]
    fn the_guard_blocks_a_response_containing_the_token() {
        let p = std::env::temp_dir().join(format!("nevis-tok-{}", std::process::id()));
        let tokens = FileTokens(p.clone());
        tokens.set("http://s", "SECRET-123").unwrap();
        assert!(guard(&tokens, "http://s", r#"{"x":"SECRET-123"}"#).is_err());
        assert!(guard(&tokens, "http://s", r#"{"x":"fine"}"#).is_ok());
        tokens.delete("http://s");
        std::fs::remove_file(p).ok();
    }
}
