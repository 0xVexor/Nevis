//! Everything that lets an AI client reach Nevis without the user copying a port and token each time:
//! the endpoint file the running app publishes, the stdio relay clients launch (`nevis --mcp-stdio`),
//! the saved "turn it back on at start" choice, and writers for the clients' own config files.
use crate::mcp::Policy;
use crate::vault::{err, write_atomic, Res};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const RELAY_FLAG: &str = "--mcp-stdio";
const SERVER_KEY: &str = "nevis";
const LAUNCH_WAIT: Duration = Duration::from_secs(25);
const PROTOCOL: &str = "2025-11-25";

// ───── files the app owns (per device, outside every vault) ─────

pub fn endpoint_path(app_data: &Path) -> PathBuf {
    app_data.join("mcp").join("endpoint.json")
}
/// The app's last handshake answers (`initialize`, `tools/list`), so a client can connect while Nevis is closed.
fn handshake_path(app_data: &Path) -> PathBuf {
    app_data.join("mcp").join("handshake.json")
}
fn autostart_path(app_data: &Path) -> PathBuf {
    app_data.join("mcp").join("autostart.json")
}

/// The port and token of the live connection. Only the signed-in OS user can read the app data folder; the file is removed
/// when the connection stops and rewritten with a fresh token on every start.
pub fn publish_endpoint(app_data: &Path, url: &str, token: &str, vault_id: &str) -> Res<()> {
    let path = endpoint_path(app_data);
    let bytes = serde_json::to_vec(&json!({ "url": url, "token": token, "vaultId": vault_id })).map_err(err)?;
    write_atomic(&path, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
pub fn clear_endpoint(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn read_autostart(app_data: &Path) -> HashMap<String, Policy> {
    std::fs::read(autostart_path(app_data))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn write_autostart(app_data: &Path, map: &HashMap<String, Policy>) -> Res<()> {
    write_atomic(&autostart_path(app_data), &serde_json::to_vec(map).map_err(err)?)
}
/// The scope to turn back on when this vault opens, if the user left the connection on.
pub fn autostart_get(app_data: &Path, vault_id: &str) -> Option<Policy> {
    read_autostart(app_data).remove(vault_id)
}
pub fn autostart_set(app_data: &Path, vault_id: &str, policy: &Policy) -> Res<()> {
    let mut map = read_autostart(app_data);
    map.insert(vault_id.to_string(), policy.clone());
    write_autostart(app_data, &map)
}
pub fn autostart_remove(app_data: &Path, vault_id: &str) -> Res<()> {
    let mut map = read_autostart(app_data);
    if map.remove(vault_id).is_some() {
        write_autostart(app_data, &map)?;
    }
    Ok(())
}

// ───── stdio relay ─────

/// Same folder Tauri uses for the app's data, so a relay started by an AI client finds the endpoint file.
fn default_app_data() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("NEVIS_APP_DATA") {
        return Some(PathBuf::from(dir));
    }
    const ID: &str = "com.vexor.nevis";
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join(ID))
    } else if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library").join("Application Support").join(ID))
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".local").join("share"))).map(|d| d.join(ID))
    }
}
fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

struct Endpoint {
    addr: String,
    token: String,
}
fn read_endpoint(app_data: &Path) -> Option<Endpoint> {
    let value: Value = serde_json::from_slice(&std::fs::read(endpoint_path(app_data)).ok()?).ok()?;
    let url = value.get("url")?.as_str()?;
    let token = value.get("token")?.as_str()?.to_string();
    let addr = url.strip_prefix("http://")?.strip_suffix("/mcp")?.to_string();
    Some(Endpoint { addr, token })
}
fn reachable(addr: &str) -> bool {
    addr.to_socket_addrs().ok().and_then(|mut a| a.next()).is_some_and(|a| TcpStream::connect_timeout(&a, Duration::from_millis(500)).is_ok())
}

struct Reply {
    status: u16,
    session: Option<String>,
    body: String,
}
fn post(endpoint: &Endpoint, session: Option<&str>, body: &str) -> Result<Reply, String> {
    let addr = endpoint.addr.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(40))).map_err(|e| e.to_string())?;
    let mut head = format!(
        "POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: {PROTOCOL}\r\nConnection: close\r\nContent-Length: {}\r\n",
        endpoint.addr,
        endpoint.token,
        body.len()
    );
    if let Some(id) = session {
        head.push_str(&format!("Mcp-Session-Id: {id}\r\n"));
    }
    head.push_str("\r\n");
    head.push_str(body);
    stream.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_reply(&raw)
}
fn parse_reply(raw: &[u8]) -> Result<Reply, String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("incomplete response")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.lines();
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).ok_or("bad status line")?;
    let header = |name: &str| lines.clone().find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()));
    let body_bytes = &raw[split + 4..];
    let body = if header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) { dechunk(body_bytes) } else { body_bytes.to_vec() };
    Ok(Reply { status, session: header("mcp-session-id"), body: String::from_utf8(body).map_err(|_| "response is not UTF-8")? })
}
fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = data.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&data[..line_end]).split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        data = &data[line_end + 2..];
        if size == 0 || data.len() < size {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
    out
}

/// Starts Nevis (once) when an AI client asks for it while it is closed, then waits for the connection to appear.
fn launch_and_wait(app_data: &Path) -> Option<Endpoint> {
    let exe = std::env::current_exe().ok()?;
    let mut command = std::process::Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    command.spawn().ok()?;
    let start = Instant::now();
    while start.elapsed() < LAUNCH_WAIT {
        std::thread::sleep(Duration::from_millis(400));
        if let Some(endpoint) = read_endpoint(app_data).filter(|e| reachable(&e.addr)) {
            std::thread::sleep(Duration::from_millis(600)); // let the window report ready
            return Some(endpoint);
        }
    }
    None
}

/// The server answers 429 when a client sends more than a few requests per second. Wait and try again instead of failing the call.
const RETRY_AFTER_BUSY_MS: [u64; 4] = [250, 500, 1000, 1000];

fn forward(endpoint: &Endpoint, session: Option<&str>, body: &str, waits: &[u64]) -> Result<Reply, String> {
    let mut reply = post(endpoint, session, body);
    for wait in waits {
        if !matches!(&reply, Ok(r) if r.status == 429) {
            break;
        }
        std::thread::sleep(Duration::from_millis(*wait));
        reply = post(endpoint, session, body);
    }
    reply
}

fn busy_error(id: &Value) -> String {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Nevis is busy with other requests. Wait a moment and try again."}}).to_string()
}

fn offline_error(id: &Value) -> String {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Nevis is not reachable. Open Nevis, go to Settings > AI connection and turn on 'Allow AI access'."}}).to_string()
}

fn read_handshake(app_data: &Path) -> Value {
    std::fs::read(handshake_path(app_data)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}
fn remember_handshake(app_data: &Path, method: &str, body: &str) {
    let Some(result) = serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("result").cloned()) else { return };
    let mut saved = read_handshake(app_data);
    if saved.get(method) != Some(&result) {
        saved[method] = result;
        let _ = serde_json::to_vec(&saved).map_err(err).and_then(|b| write_atomic(&handshake_path(app_data), &b));
    }
}

enum Offline {
    Answer(String),
    Quiet,
    Launch,
    Unavailable,
}

/// While Nevis is closed, the handshake, pings and the tool list are answered from what the app said last time, so a client
/// starting up does not open the app. Only a real request (a tool call) opens it; so does the tool list the very first time.
fn offline(method: &str, id: Option<&Value>, saved: &Value) -> Offline {
    let answer = |result: Value| id.map_or(Offline::Quiet, |id| Offline::Answer(json!({"jsonrpc":"2.0","id":id,"result":result}).to_string()));
    match method {
        "initialize" => answer(saved.get("initialize").cloned().unwrap_or_else(
            || json!({"protocolVersion":PROTOCOL,"serverInfo":{"name":"nevis-documents","version":"1.0.0"},"capabilities":{"tools":{"listChanged":false}}}),
        )),
        "ping" => answer(json!({})),
        "tools/list" => saved.get("tools/list").cloned().map_or(Offline::Launch, answer),
        _ if id.is_none() => Offline::Quiet,
        "tools/call" => Offline::Launch,
        _ => Offline::Unavailable,
    }
}

fn send(stdout: &mut std::io::Stdout, text: &str) -> bool {
    writeln!(stdout, "{text}").and_then(|_| stdout.flush()).is_ok()
}

/// `nevis --mcp-stdio`: newline-delimited JSON-RPC on stdin/stdout, forwarded to the live local connection.
pub fn run_stdio() -> i32 {
    let Some(app_data) = default_app_data() else {
        eprintln!("cannot find the Nevis data folder");
        return 1;
    };
    let (stdin, mut stdout) = (std::io::stdin(), std::io::stdout());
    // NEVIS_NO_LAUNCH keeps the relay from starting the app (tests, headless checks)
    let (mut session, mut launched) = (None::<String>, std::env::var_os("NEVIS_NO_LAUNCH").is_some());
    // the client's own initialize, replayed to an app run it has not met yet (opened later, or restarted); a run is known by its token
    let (mut hello, mut introduced) = (None::<String>, None::<String>);
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        // Windows PowerShell prefixes piped text with a UTF-8 byte order mark
        let line = line.trim_start_matches('\u{feff}').to_string();
        if line.trim().is_empty() {
            continue;
        }
        let message = serde_json::from_str::<Value>(&line).ok();
        let id = message.as_ref().and_then(|m| m.get("id").cloned());
        let method = message.as_ref().and_then(|m| m.get("method")).and_then(Value::as_str).unwrap_or("").to_string();
        if method == "initialize" {
            hello = Some(line.clone());
            introduced = None;
        }
        let mut endpoint = read_endpoint(&app_data).filter(|e| reachable(&e.addr));
        if endpoint.is_none() {
            match offline(&method, id.as_ref(), &read_handshake(&app_data)) {
                Offline::Answer(text) => {
                    if !send(&mut stdout, &text) {
                        break;
                    }
                    continue;
                }
                Offline::Quiet => continue,
                Offline::Launch if !launched => {
                    launched = true;
                    endpoint = launch_and_wait(&app_data);
                }
                Offline::Launch | Offline::Unavailable => {}
            }
        }
        if let (Some(e), Some(hello)) = (&endpoint, &hello) {
            if method != "initialize" && introduced.as_deref() != Some(e.token.as_str()) {
                if let Ok(r) = forward(e, None, hello, &RETRY_AFTER_BUSY_MS) {
                    session = r.session;
                }
                let _ = forward(e, session.as_deref(), &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(), &RETRY_AFTER_BUSY_MS);
                introduced = Some(e.token.clone());
            }
        }
        let token = endpoint.as_ref().map(|e| e.token.clone());
        let reply = endpoint.ok_or_else(|| "offline".to_string()).and_then(|e| forward(&e, session.as_deref(), &line, &RETRY_AFTER_BUSY_MS));
        let output = match reply {
            Ok(r) => {
                if r.session.is_some() {
                    session = r.session;
                }
                if r.status < 400 && (method == "initialize" || method == "tools/list") {
                    remember_handshake(&app_data, &method, &r.body);
                    if method == "initialize" {
                        introduced = token;
                    }
                }
                if r.body.trim().is_empty() { id.as_ref().filter(|_| r.status >= 400).map(|id| if r.status == 429 { busy_error(id) } else { offline_error(id) }) } else { Some(r.body.trim().to_string()) }
            }
            Err(_) => id.as_ref().map(offline_error),
        };
        if let Some(text) = output {
            if !send(&mut stdout, &text) {
                break;
            }
        }
    }
    0
}

// ───── one-click client setup ─────

pub fn client_config_path(client: &str) -> Res<PathBuf> {
    let home = home().ok_or("Cannot find your home folder")?;
    Ok(match client {
        "claude" => {
            if cfg!(windows) {
                PathBuf::from(std::env::var_os("APPDATA").ok_or("Cannot find AppData")?).join("Claude").join("claude_desktop_config.json")
            } else if cfg!(target_os = "macos") {
                home.join("Library").join("Application Support").join("Claude").join("claude_desktop_config.json")
            } else {
                home.join(".config").join("Claude").join("claude_desktop_config.json")
            }
        }
        "codex" => std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex")).join("config.toml"),
        "gemini" => home.join(".gemini").join("settings.json"),
        _ => return Err("Unknown AI app".into()),
    })
}

fn backup(path: &Path) {
    if path.exists() {
        let _ = std::fs::copy(path, path.with_extension("nevis-backup"));
    }
}

/// Adds (or refreshes) the `nevis` server in the client's own config file and leaves everything else in it alone.
pub fn install_client(client: &str, exe: &Path) -> Res<PathBuf> {
    let path = client_config_path(client)?;
    let command = exe.to_str().ok_or("Unsupported application path")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    if client == "codex" {
        let existing = if path.exists() { std::fs::read_to_string(&path).map_err(err)? } else { String::new() };
        backup(&path);
        write_atomic(&path, set_toml_server(&existing, command).as_bytes())?;
    } else {
        let mut root: Value = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path).map_err(err)?).map_err(|_| "The AI app's settings file is not valid JSON; fix or remove it first")?
        } else {
            json!({})
        };
        let servers = root.as_object_mut().ok_or("Unexpected settings file")?.entry("mcpServers").or_insert_with(|| json!({}));
        servers.as_object_mut().ok_or("Unexpected settings file")?.insert(SERVER_KEY.into(), json!({"command": command, "args": [RELAY_FLAG]}));
        backup(&path);
        write_atomic(&path, &serde_json::to_vec_pretty(&root).map_err(err)?)?;
    }
    Ok(path)
}

fn set_toml_server(existing: &str, command: &str) -> String {
    let header = format!("[mcp_servers.{SERVER_KEY}]");
    let block = format!("{header}\ncommand = '{}'\nargs = [\"{RELAY_FLAG}\"]\n", command.replace('\'', ""));
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == header {
            skipping = true;
            continue;
        }
        if skipping && trimmed.starts_with('[') {
            skipping = false;
        }
        if !skipping {
            out.push(line);
        }
    }
    let mut text = out.join("\n");
    while text.ends_with('\n') {
        text.pop();
    }
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    text + &block
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_entry_is_added_and_replaced_without_touching_the_rest() {
        let first = set_toml_server("model = \"x\"\n\n[mcp_servers.other]\ncommand = \"o\"\n", "C:\\Nevis\\nevis.exe");
        assert!(first.contains("model = \"x\"") && first.contains("[mcp_servers.other]\ncommand = \"o\""));
        assert!(first.contains("[mcp_servers.nevis]\ncommand = 'C:\\Nevis\\nevis.exe'\nargs = [\"--mcp-stdio\"]"));
        let second = set_toml_server(&first, "D:\\New\\nevis.exe");
        assert_eq!(second.matches("[mcp_servers.nevis]").count(), 1);
        assert!(second.contains("D:\\New\\nevis.exe") && !second.contains("C:\\Nevis"));
        assert!(second.contains("[mcp_servers.other]"));
    }

    #[test]
    fn a_closed_app_is_opened_only_by_a_tool_call() {
        let id = json!(1);
        let saved = json!({"initialize":{"protocolVersion":"x"},"tools/list":{"tools":[]}});
        let answered = |o: Offline| match o {
            Offline::Answer(text) => serde_json::from_str::<Value>(&text).unwrap()["result"].clone(),
            _ => panic!("expected an answer"),
        };
        assert_eq!(answered(offline("initialize", Some(&id), &saved)), json!({"protocolVersion":"x"}));
        assert_eq!(answered(offline("ping", Some(&id), &saved)), json!({}));
        assert_eq!(answered(offline("tools/list", Some(&id), &saved)), json!({"tools":[]}));
        assert!(matches!(offline("notifications/initialized", None, &saved), Offline::Quiet));
        assert!(matches!(offline("tools/call", Some(&id), &saved), Offline::Launch));
        assert!(matches!(offline("resources/list", Some(&id), &saved), Offline::Unavailable));
        // never connected before: the handshake still answers, the tool list has to come from the app
        assert_eq!(answered(offline("initialize", Some(&id), &json!({})))["protocolVersion"], PROTOCOL);
        assert!(matches!(offline("tools/list", Some(&id), &json!({})), Offline::Launch));
    }

    #[test]
    fn chunked_and_plain_replies_parse() {
        let plain = parse_reply(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nMcp-Session-Id: abc\r\n\r\n{}").unwrap();
        assert_eq!((plain.status, plain.body.as_str(), plain.session.as_deref()), (200, "{}", Some("abc")));
        let chunked = parse_reply(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n3\r\n\":1\r\n1\r\n}\r\n0\r\n\r\n").unwrap();
        assert_eq!(chunked.body, "{\"a\":1}");
    }

    #[test]
    fn relay_forwards_a_request_with_the_bearer_token_and_keeps_the_session_id() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let mut request = String::new();
            while !request.ends_with("}") {
                let n = stream.read(&mut buf).unwrap();
                request.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
            let body = "{\"ok\":true,\"n\":1}";
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: s1\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
            request
        });
        let endpoint = Endpoint { addr, token: "secret".into() };
        let reply = post(&endpoint, Some("prev"), "{\"id\":1}").unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /mcp HTTP/1.1") && request.contains("Authorization: Bearer secret") && request.contains("Mcp-Session-Id: prev") && request.ends_with("{\"id\":1}"));
        assert_eq!((reply.status, reply.session.as_deref()), (200, Some("s1")));
        assert!(reply.body.contains("\"ok\":true"));
    }

    #[test]
    fn relay_waits_and_retries_when_the_server_is_busy() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = std::thread::spawn(move || {
            let mut statuses = 0;
            for answer in ["HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n".to_string(), {
                let body = "{\"ok\":true}";
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
            }] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let mut request = String::new();
                while !request.ends_with("}") {
                    let n = stream.read(&mut buf).unwrap();
                    request.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
                stream.write_all(answer.as_bytes()).unwrap();
                statuses += 1;
            }
            statuses
        });
        let endpoint = Endpoint { addr, token: "secret".into() };
        let reply = forward(&endpoint, None, "{\"id\":1}", &[5, 5]).unwrap();
        assert_eq!(server.join().unwrap(), 2);
        assert_eq!(reply.status, 200);
        assert!(reply.body.contains("\"ok\":true"));
    }

    #[test]
    fn codex_install_writes_the_server_entry() {
        let dir = std::env::temp_dir().join(format!("nevis-relay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("CODEX_HOME", &dir);
        let path = install_client("codex", Path::new("/opt/nevis")).unwrap();
        assert!(std::fs::read_to_string(path).unwrap().contains("[mcp_servers.nevis]"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
