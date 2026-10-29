//! Native HTTPS transport and secret-free diagnostics. Never retry a mutating request after an unknown outcome.
use crate::vault::Res;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    error::Error,
    time::{Duration, Instant},
};

pub fn client() -> Res<Client> {
    Client::builder()
        .use_rustls_tls()
        .user_agent("Noviq-personal-vaults/1")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "GITHUB:network_client_config".into())
}
pub fn failure(error: &reqwest::Error, expected_host: &str, phase: &str) -> String {
    let mut text = String::new();
    let mut os = None;
    let mut source = error.source();
    while let Some(e) = source {
        text.push_str(&e.to_string().to_lowercase());
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            os = io.raw_os_error();
        }
        source = e.source();
    }
    let code = if error.is_timeout() {
        "network_timeout"
    } else if text.contains("certificate") || text.contains("tls") || text.contains("ssl") {
        "network_tls"
    } else if text.contains("proxy") || text.contains("tunnel") || text.contains("socks") {
        "network_proxy"
    } else if text.contains("dns") || text.contains("lookup") || text.contains("resolve host") {
        "network_dns"
    } else if error.is_connect() {
        "network_connect"
    } else {
        "network"
    };
    let host = error
        .url()
        .and_then(|u| u.host_str())
        .filter(|h| ["github.com", "api.github.com", "codeload.github.com"].contains(h))
        .unwrap_or(expected_host);
    // Do not include request URLs, proxy credentials, headers, response bodies or arbitrary source strings.
    format!(
        "GITHUB:{code}:host={host};phase={phase};os={}",
        os.map_or_else(|| "none".into(), |n| n.to_string())
    )
}
pub fn diagnostics() -> Value {
    let client = match client() {
        Ok(c) => c,
        Err(e) => return json!({"error":e}),
    };
    let mut checks = vec![];
    for (host, url) in [
        ("github.com", "https://github.com/login/device"),
        ("api.github.com", "https://api.github.com/rate_limit"),
        ("codeload.github.com", "https://codeload.github.com/"),
    ] {
        let started = Instant::now();
        let result = client.get(url).timeout(Duration::from_secs(10)).send();
        checks.push(match result{Ok(r)=>json!({"host":host,"reachable":true,"httpStatus":r.status().as_u16(),"elapsedMs":started.elapsed().as_millis()}),Err(e)=>json!({"host":host,"reachable":false,"error":failure(&e,host,"diagnostic"),"elapsedMs":started.elapsed().as_millis()})});
    }
    json!({"systemProxySupport":true,"systemCertificateRoots":true,"certificateValidation":true,"checks":checks})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_error_has_category_but_never_url_or_secret() {
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let e = Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!(
                "http://127.0.0.1:{port}/private?access_token=never-print-me"
            ))
            .send()
            .unwrap_err();
        let message = failure(&e, "api.github.com", "account_profile");
        assert!(message.starts_with("GITHUB:network_connect:"));
        assert!(message.contains("host=api.github.com"));
        assert!(!message.contains("never-print-me"));
        assert!(!message.contains("127.0.0.1"));
        assert!(!message.contains("private"));
    }
}
