//! Nevis desktop (ADR-0013): the web bundle in a Tauri 2 window, SQLite for the local store, the network and the device token in Rust.
pub mod blobs;
pub mod mirror;
pub mod net;
pub mod secrets;
pub mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::Notify;

use net::NetResponse;
use secrets::TokenStore;
use store::{Op, Read, Store};

/// Normal run, or one of the automated modes (each loads its own page of the web bundle and ends with `app_exit`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode { Normal, SelfTest, Bench, Typing, Sync, UiTest }
impl Mode {
    fn from_args() -> Mode {
        let a: Vec<String> = std::env::args().collect();
        if a.iter().any(|x| x == "--self-test") { Mode::SelfTest }
        else if a.iter().any(|x| x == "--bench") { Mode::Bench }
        else if a.iter().any(|x| x == "--typing") { Mode::Typing }
        else if a.iter().any(|x| x == "--sync") { Mode::Sync }
        else if a.iter().any(|x| x == "--ui-test") { Mode::UiTest }
        else { Mode::Normal }
    }
    fn name(self) -> &'static str { match self { Mode::Normal => "normal", Mode::SelfTest => "selftest", Mode::Bench => "bench", Mode::Typing => "typing", Mode::Sync => "sync", Mode::UiTest => "uitest" } }
    /// The real window close (with the flush) applies in a normal run and in the UI test, which drives the real UI.
    fn closes_with_flush(self) -> bool { matches!(self, Mode::Normal | Mode::UiTest) }
    fn page(self) -> &'static str { match self { Mode::Normal => "index.html", Mode::SelfTest => "desktop-selftest.html", Mode::Bench => "desktop-bench.html", Mode::Typing => "desktop-typing.html", Mode::Sync => "desktop-sync.html", Mode::UiTest => "index.html" } }
}

pub struct AppState {
    mode: Mode,
    data_dir: PathBuf,
    stores: Mutex<HashMap<String, Arc<Mutex<Store>>>>,
    server: Mutex<Option<String>>,
    tokens: Box<dyn TokenStore>,
    /// the token per server, read from the keychain ONCE (each read can be a password prompt on an unsigned build)
    token_cache: Mutex<HashMap<String, Option<String>>>,
    http: reqwest::Client,
    inflight: Mutex<HashMap<String, Arc<Notify>>>,
    flush_registered: Mutex<bool>,
    flush_done: Notify,
    blocked: Mutex<u32>,
}

impl AppState {
    fn server(&self) -> Result<String, String> { self.server.lock().unwrap().clone().ok_or_else(|| "no server address is set".to_string()) }

    fn store(&self, ws: &str) -> Result<Arc<Mutex<Store>>, String> {
        if ws.is_empty() || ws.len() > 64 || !ws.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("bad workspace id".into()); }
        let mut m = self.stores.lock().unwrap();
        if let Some(s) = m.get(ws) { return Ok(s.clone()); }
        std::fs::create_dir_all(&self.data_dir).map_err(|e| e.to_string())?;
        let s = Arc::new(Mutex::new(Store::open(&self.data_dir.join(format!("ws-{ws}.sqlite"))).map_err(|e| e.to_string())?));
        m.insert(ws.to_string(), s.clone());
        Ok(s)
    }

    fn token(&self, server: &str) -> Option<String> {
        self.token_cache.lock().unwrap().entry(server.to_string()).or_insert_with(|| self.tokens.get(server)).clone()
    }
    fn set_token(&self, server: &str, token: &str) -> Result<(), String> {
        self.tokens.set(server, token)?;
        self.token_cache.lock().unwrap().insert(server.to_string(), Some(token.to_string()));
        Ok(())
    }
    fn clear_token(&self, server: &str) {
        self.tokens.delete(server);
        self.token_cache.lock().unwrap().insert(server.to_string(), None);
    }

    fn config_path(&self) -> PathBuf { self.data_dir.join("config.json") }

    /// Rust's own calls (sign-in, sign-up) may use the token-issuing endpoints.
    async fn request_internal(&self, method: &str, path: &str, body: Option<String>) -> Result<NetResponse, String> {
        net::check_path_inside_v1(path)?;
        self.send(method, path, body, None).await
    }

    async fn request(&self, method: &str, path: &str, body: Option<String>, id: Option<String>) -> Result<NetResponse, String> {
        net::check_path(path)?;
        self.send(method, path, body, id).await
    }

    async fn send(&self, method: &str, path: &str, body: Option<String>, id: Option<String>) -> Result<NetResponse, String> {
        let server = self.server()?;
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "bad method".to_string())?;
        if !matches!(m, reqwest::Method::GET | reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::DELETE | reqwest::Method::PATCH) { return Err("bad method".into()); }
        let mut rq = self.http.request(m, format!("{server}{path}")).header("Nevis-Proto", "1");
        if let Some(t) = self.token(&server) { rq = rq.bearer_auth(t); }
        if let Some(b) = body { rq = rq.header("Content-Type", "application/json").body(b); }
        let cancel = Arc::new(Notify::new());
        if let Some(i) = &id { self.inflight.lock().unwrap().insert(i.clone(), cancel.clone()); }
        let run = async {
            let res = rq.send().await.map_err(|_| "unreachable".to_string())?;
            let status = res.status().as_u16();
            let text = res.text().await.map_err(|_| "unreachable".to_string())?;
            Ok::<_, String>(NetResponse { status, text })
        };
        let out = tokio::select! { r = run => r, _ = cancel.notified() => Err("aborted".to_string()) };
        if let Some(i) = &id { self.inflight.lock().unwrap().remove(i); }
        out
    }

    /// A request with a raw (binary) body and the answer's status, headers and bytes: for attachments. The path rules are the same as
    /// for every other request; JavaScript still never sees the token.
    async fn raw_request(&self, method: &str, path: &str, body: Option<Vec<u8>>, range: Option<String>) -> Result<(u16, reqwest::header::HeaderMap, Vec<u8>), String> {
        net::check_path(path)?;
        let server = self.server()?;
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "bad method".to_string())?;
        let mut rq = self.http.request(m, format!("{server}{path}")).header("Nevis-Proto", "1");
        if let Some(t) = self.token(&server) { rq = rq.bearer_auth(t); }
        if let Some(r) = range { rq = rq.header("Range", r); }
        if let Some(b) = body { rq = rq.header("Content-Type", "application/octet-stream").body(b); }
        let res = rq.send().await.map_err(|_| "unreachable".to_string())?;
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let bytes = res.bytes().await.map_err(|_| "unreachable".to_string())?.to_vec();
        Ok((status, headers, bytes))
    }

    /// A response for JavaScript: refuse it if it holds the token.
    fn deliver(&self, r: NetResponse) -> Result<NetResponse, String> {
        let server = self.server()?;
        if let Err(e) = net::guard(self.token(&server).as_deref(), &r.text) { *self.blocked.lock().unwrap() += 1; return Err(e); }
        Ok(r)
    }
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> Value {
    let server = state.server.lock().unwrap().clone();
    let signed_in = server.as_ref().map_or(false, |s| state.token(s).is_some());
    json!({ "mode": state.mode.name(), "dataDir": state.data_dir.to_string_lossy(), "server": server, "hasToken": signed_in, "blocked": *state.blocked.lock().unwrap(),
        "env": { "user": std::env::var("NEVIS_USER").ok(), "ws": std::env::var("NEVIS_WS").ok(), "phase": std::env::var("NEVIS_PHASE").ok() },
        "verify": std::env::var("NEVIS_VERIFY").map_or(false, |v| v == "1"), "benchSeconds": std::env::var("NEVIS_BENCH_SECONDS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(60) })
}

#[tauri::command]
fn server_set(state: State<'_, AppState>, url: String) -> Result<String, String> {
    let u = net::check_server(&url)?;
    std::fs::create_dir_all(&state.data_dir).map_err(|e| e.to_string())?;
    std::fs::write(state.config_path(), json!({ "server": u }).to_string()).map_err(|e| e.to_string())?;
    *state.server.lock().unwrap() = Some(u.clone());
    Ok(u)
}

#[tauri::command]
async fn store_commit(state: State<'_, AppState>, ws: String, ops: Vec<Op>) -> Result<(), String> {
    let s = state.store(&ws)?;
    tauri::async_runtime::spawn_blocking(move || s.lock().unwrap().commit(&ops).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn store_read(state: State<'_, AppState>, ws: String, req: Read) -> Result<Value, String> {
    let s = state.store(&ws)?;
    tauri::async_runtime::spawn_blocking(move || s.lock().unwrap().read(&req).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn net_request(state: State<'_, AppState>, method: String, path: String, body: Option<String>, request_id: Option<String>) -> Result<NetResponse, String> {
    let r = state.request(&method, &path, body, request_id).await?;
    state.deliver(r)
}

// ---- attachments (ROADMAP M9). Bytes cross the IPC as RAW bodies and responses (no base64, no JSON) ----

fn header(req: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string).ok_or_else(|| format!("missing header {name}"))
}
fn raw_body(req: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match req.body() { tauri::ipc::InvokeBody::Raw(b) => Ok(b.clone()), _ => Err("expected a raw body".into()) }
}

/// Stores a file: the bytes (headers: ws, hash, mime, remote) are checked against the hash, written whole, THEN the row is inserted.
#[tauri::command]
async fn blob_put(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let (ws, hash, mime) = (header(&request, "ws")?, header(&request, "hash")?, blobs::clean_mime(&header(&request, "mime").unwrap_or_default()));
    let remote = header(&request, "remote").map(|v| v == "1").unwrap_or(false);
    let bytes = raw_body(&request)?;
    let s = state.store(&ws)?;
    let dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        blobs::write_file(&dir, &ws, &hash, &bytes).map_err(|e| e.message())?;
        s.lock().unwrap().blob_insert(&hash, bytes.len() as i64, &mime, remote).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

/// The bytes of a file, or the error `not_found`.
#[tauri::command]
async fn blob_get(state: State<'_, AppState>, ws: String, hash: String) -> Result<tauri::ipc::Response, String> {
    state.store(&ws)?; // validates the workspace id
    let dir = state.data_dir.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || blobs::read_file(&dir, &ws, &hash)).await.map_err(|e| e.to_string())?;
    bytes.map(tauri::ipc::Response::new).ok_or_else(|| "not_found".to_string())
}

#[tauri::command]
async fn blob_meta(state: State<'_, AppState>, ws: String, hash: String) -> Result<Value, String> {
    if !blobs::valid_hash(&hash) { return Err("bad attachment name".into()); }
    let s = state.store(&ws)?;
    tauri::async_runtime::spawn_blocking(move || s.lock().unwrap().blob_meta(&hash).map(|r| r.unwrap_or(Value::Null)).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn blob_list(state: State<'_, AppState>, ws: String, pending: bool) -> Result<Value, String> {
    let s = state.store(&ws)?;
    tauri::async_runtime::spawn_blocking(move || s.lock().unwrap().blob_list(pending).map(Value::Array).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn blob_set(state: State<'_, AppState>, ws: String, hash: String, remote: Option<bool>, failed: Option<String>) -> Result<(), String> {
    if !blobs::valid_hash(&hash) { return Err("bad attachment name".into()); }
    let s = state.store(&ws)?;
    tauri::async_runtime::spawn_blocking(move || s.lock().unwrap().blob_set(&hash, remote, failed.as_deref()).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

/// Removes the row first, then the file (a crash in between leaves a file nobody names, never a row without bytes).
#[tauri::command]
async fn blob_delete(state: State<'_, AppState>, ws: String, hash: String) -> Result<(), String> {
    if !blobs::valid_hash(&hash) { return Err("bad attachment name".into()); }
    let s = state.store(&ws)?;
    let dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || { s.lock().unwrap().blob_remove(&hash).map_err(|e| e.to_string())?; blobs::remove_file(&dir, &ws, &hash); Ok(()) }).await.map_err(|e| e.to_string())?
}

/// HEAD of a file on the server: `{status, size, received}` (size from `Nevis-Size`, received from `Nevis-Received`).
#[tauri::command]
async fn blob_head(state: State<'_, AppState>, ws: String, hash: String) -> Result<Value, String> {
    state.store(&ws)?;
    if !blobs::valid_hash(&hash) { return Err("bad attachment name".into()); }
    let (status, h, _) = state.raw_request("HEAD", &format!("/v1/ws/{ws}/blobs/{hash}"), None, None).await?;
    let num = |n: &str| h.get(n).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    Ok(json!({ "status": status, "size": num("nevis-size"), "received": num("nevis-received") }))
}

/// One piece of an upload (headers: ws, hash, offset, total; the body is the piece). The answer is the server's JSON.
#[tauri::command]
async fn blob_put_piece(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<NetResponse, String> {
    let (ws, hash) = (header(&request, "ws")?, header(&request, "hash")?);
    let (offset, total): (u64, u64) = (header(&request, "offset")?.parse().map_err(|_| "bad offset")?, header(&request, "total")?.parse().map_err(|_| "bad total")?);
    state.store(&ws)?;
    if !blobs::valid_hash(&hash) { return Err("bad attachment name".into()); }
    let (status, _, bytes) = state.raw_request("PUT", &format!("/v1/ws/{ws}/blobs/{hash}?offset={offset}&total={total}"), Some(raw_body(&request)?), None).await?;
    state.deliver(NetResponse { status, text: String::from_utf8_lossy(&bytes).to_string() })
}

/// A byte range of a file on the server. The answer is raw bytes: `status` (u16 BE), the file's total size (u64 BE), then the body (the
/// bytes of the range, or the server's JSON error).
#[tauri::command]
async fn blob_get_range(state: State<'_, AppState>, ws: String, hash: String, start: u64, end: u64) -> Result<tauri::ipc::Response, String> {
    state.store(&ws)?;
    if !blobs::valid_hash(&hash) { return Err("bad attachment name".into()); }
    let (status, h, body) = state.raw_request("GET", &format!("/v1/ws/{ws}/blobs/{hash}"), None, Some(format!("bytes={start}-{end}"))).await?;
    let total = h.get("content-range").and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit('/').next()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(body.len() as u64);
    let mut out = Vec::with_capacity(10 + body.len());
    out.extend_from_slice(&status.to_be_bytes());
    out.extend_from_slice(&total.to_be_bytes());
    out.extend_from_slice(&body);
    Ok(tauri::ipc::Response::new(out))
}

/// Writes the Markdown mirror (see mirror.rs): returns `{written, skipped, removed}`.
#[tauri::command]
async fn mirror_sync(dir: String, files: Vec<(String, String)>, remove: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || mirror::sync(std::path::Path::new(&dir), &files, &remove).map(|o| json!({ "written": o.written, "skipped": o.skipped, "removed": o.removed }))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn net_cancel(state: State<'_, AppState>, request_id: String) {
    if let Some(n) = state.inflight.lock().unwrap().get(&request_id) { n.notify_one(); }
}

/// Sign in or sign up AS A DEVICE: the token goes to the keychain, JavaScript gets the rest of the response.
async fn device_auth(state: &AppState, path: &str, mut body: Value) -> Result<NetResponse, String> {
    body["client"] = json!("device");
    let r = state.request_internal("POST", path, Some(body.to_string())).await?;
    if r.status != 200 { return state.deliver(r); }
    let (token, rest) = net::strip_token(&r.text);
    let token = token.ok_or("the server sent no device token")?;
    state.set_token(&state.server()?, &token)?;
    state.deliver(NetResponse { status: r.status, text: rest })
}

#[tauri::command]
async fn auth_signin(state: State<'_, AppState>, username: String, password: String, device_name: String) -> Result<NetResponse, String> {
    device_auth(&state, "/v1/auth/signin", json!({ "username": username, "password": password, "deviceName": device_name })).await
}

#[tauri::command]
async fn auth_signup(state: State<'_, AppState>, username: String, password: String, device_name: String, invite: Option<String>, challenge: String, counter: u64) -> Result<NetResponse, String> {
    device_auth(&state, "/v1/auth/signup", json!({ "username": username, "password": password, "deviceName": device_name, "invite": invite, "challenge": challenge, "counter": counter })).await
}

#[tauri::command]
async fn auth_signout(state: State<'_, AppState>) -> Result<(), String> {
    let server = state.server()?;
    let _ = state.request("POST", "/v1/auth/signout", None, None).await; // best effort: the token is dropped locally either way
    state.clear_token(&server);
    Ok(())
}

/// The page tells Rust it listens for `nevis://flush` (so the window close waits for it); `flush_done` ends the wait.
#[tauri::command]
fn flush_ready(state: State<'_, AppState>) { *state.flush_registered.lock().unwrap() = true; }
#[tauri::command]
fn flush_done(state: State<'_, AppState>) { state.flush_done.notify_one(); }

/// The typing test reports each key on stdout so the parent process knows how far it got when it kills us.
#[tauri::command]
fn app_log(state: State<'_, AppState>, line: String) {
    if state.mode != Mode::Normal { println!("{line}"); }
}

/// `--ui-test` only: close the window the way the ✕ button does (CloseRequested fires, the flush runs).
#[tauri::command]
fn ui_close(window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    if state.mode != Mode::UiTest { return Err("only in --ui-test".into()); }
    window.close().map_err(|e| e.to_string())
}

/// Automated modes end here: print the report, exit with the code.
#[tauri::command]
fn app_exit(state: State<'_, AppState>, code: i32, report: String) {
    if state.mode == Mode::Normal { return; }
    println!("{report}");
    std::process::exit(code);
}

pub fn run() {
    let mode = Mode::from_args();
    let data_dir = std::env::var("NEVIS_DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        // the app data dir of the identifier (macOS: ~/Library/Application Support/app.nevis.desktop)
        dirs_data().join("app.nevis.desktop")
    });
    let server = std::env::var("NEVIS_SERVER").ok().and_then(|u| net::check_server(&u).ok()).or_else(|| {
        let text = std::fs::read_to_string(data_dir.join("config.json")).ok()?;
        net::check_server(serde_json::from_str::<Value>(&text).ok()?.get("server")?.as_str()?).ok()
    });
    let state = AppState {
        mode, data_dir, stores: Mutex::new(HashMap::new()), server: Mutex::new(server), tokens: secrets::from_env(), token_cache: Mutex::new(HashMap::new()),
        http: reqwest::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client"),
        inflight: Mutex::new(HashMap::new()), flush_registered: Mutex::new(false), flush_done: Notify::new(), blocked: Mutex::new(0),
    };
    tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            let mut w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(mode.page().into()))
                .title("Nevis").inner_size(1100.0, 760.0).use_https_scheme(true); // fixed for ever (ADR-0013 §2)
            if mode == Mode::UiTest {
                // the driver exists only in this mode; its settings come from the environment of the test run
                let cfg = std::env::var("NEVIS_UI_CFG").unwrap_or_else(|_| "{}".into());
                w = w.initialization_script(include_str!("ui_driver.js").replace("__CFG__", &cfg));
            }
            w.build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if !state.mode.closes_with_flush() || !*state.flush_registered.lock().unwrap() { return; }
                // Ask the page to write what it holds and push the outbox, then close: at most 5 s (ADR-0007 §7).
                api.prevent_close();
                let w = window.clone();
                let _ = w.emit("nevis://flush", ());
                tauri::async_runtime::spawn(async move {
                    let state = w.state::<AppState>();
                    let _ = tokio::time::timeout(Duration::from_secs(5), state.flush_done.notified()).await;
                    let _ = w.destroy();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![app_info, server_set, store_commit, store_read, net_request, net_cancel, mirror_sync, blob_put, blob_get, blob_meta, blob_list, blob_set, blob_delete, blob_head, blob_put_piece, blob_get_range, auth_signin, auth_signup, auth_signout, flush_ready, flush_done, app_log, ui_close, app_exit])
        .run(tauri::generate_context!())
        .expect("error while running Nevis");
}

fn dirs_data() -> PathBuf {
    if cfg!(target_os = "macos") { PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support") }
    else if cfg!(target_os = "windows") { PathBuf::from(std::env::var("APPDATA").unwrap_or_default()) }
    else { std::env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/share")) }
}
