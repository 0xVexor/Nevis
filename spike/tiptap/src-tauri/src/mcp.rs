//! Opt-in, authenticated loopback transport. Document behavior stays in the webview TypeScript service.
use crate::vault::{err, Res};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    Request, Response, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    convert::Infallible,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

const VERSION: &str = "2025-11-25";
const MAX_REQUEST: usize = 266_240;
const MAX_RESPONSE: usize = 262_144;
const MAX_PENDING: usize = 8;
const DEADLINE: Duration = Duration::from_secs(20);
const KEYRING: &str = "com.vexor.noviq.mcp";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub whole_vault: bool,
    pub root_ids: Vec<String>,
    pub excluded_ids: Vec<String>,
    pub allow_writes: bool,
}
impl Policy {
    fn valid(&self) -> bool {
        (!self.allow_writes || cfg!(feature = "mcp-write-acceptance"))
            && (self.whole_vault || !self.root_ids.is_empty())
            && [&self.root_ids, &self.excluded_ids].iter().all(|ids| {
                ids.len() <= 100
                    && ids.iter().all(|id| crate::vault::check_id(id).is_ok())
                    && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len()
            })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    #[serde(default)]
    pub writes_available: bool,
    pub grant_id: String,
    pub revision: String,
    pub vault_id: String,
    pub policy: Policy,
}
struct Session {
    connection: Connection,
    token: String,
    endpoint: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteAdmission {
    pub request_id: String,
    pub revision: String,
}
pub struct WritePermit<'a> {
    _guard: std::sync::MutexGuard<'a, Inner>,
}
struct Pending {
    expires_at: Instant,
    sender: oneshot::Sender<Value>,
    rpc_id: Value,
    revision: String,
}
#[derive(Default)]
struct Inner {
    session: Option<Session>,
    ready: Option<(String, String, Instant)>,
    pending: HashMap<String, Pending>,
    rate: Option<(Instant, usize)>,
}
type SendEvent = Arc<dyn Fn(&str, Value) -> Res<()> + Send + Sync>;
type CurrentVault = Arc<dyn Fn() -> Option<String> + Send + Sync>;
pub struct Host {
    inner: Mutex<Inner>,
    bridge: Mutex<Option<(SendEvent, CurrentVault)>>,
    deadline: Duration,
}
impl Default for Host {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            bridge: Mutex::new(None),
            deadline: DEADLINE,
        }
    }
}
impl Host {
    pub fn set_bridge(&self, send: SendEvent, current: CurrentVault) {
        *self.bridge.lock().unwrap() = Some((send, current));
    }
    fn emit(&self, event: &str, payload: Value) -> Res<()> {
        let send = self
            .bridge
            .lock()
            .map_err(err)?
            .as_ref()
            .map(|b| b.0.clone())
            .ok_or("App unavailable")?;
        send(event, payload)
    }
    fn active(&self, revision: &str) -> bool {
        let current = self
            .bridge
            .lock()
            .ok()
            .and_then(|b| b.as_ref().map(|b| b.1.clone()))
            .and_then(|current| current());
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        inner.session.as_ref().is_some_and(|session| {
            session.connection.revision == revision
                && current.as_deref() == Some(&session.connection.vault_id)
                && inner.ready.as_ref().is_some_and(|(_, vault, at)| {
                    vault == &session.connection.vault_id && at.elapsed() < Duration::from_secs(10)
                })
        })
    }
    pub fn ready(&self, vault: &str, owner: &str) -> Res<()> {
        crate::vault::check_id(owner)?;
        let changed = self
            .inner
            .lock()
            .map_err(err)?
            .ready
            .as_ref()
            .is_some_and(|(previous, id, _)| previous != owner || id != vault);
        if changed {
            self.stop();
        }
        self.inner.lock().map_err(err)?.ready =
            Some((owner.to_string(), vault.to_string(), Instant::now()));
        Ok(())
    }
    pub fn status(&self) -> Res<Value> {
        let inner = self.inner.lock().map_err(err)?;
        Ok(
            json!({"active":inner.session.is_some(),"endpoint":inner.session.as_ref().map(|s| &s.endpoint),
            "connection":inner.session.as_ref().map(|s| &s.connection),"ready":inner.ready.as_ref().is_some_and(|(_, _, at)| at.elapsed() < Duration::from_secs(10)),
            "pending":inner.pending.len(),"writesAvailable":cfg!(feature = "mcp-write-acceptance")}),
        )
    }
    fn revoke(&self) -> Option<Session> {
        if let Ok(mut inner) = self.inner.lock() {
            let session = inner.session.take();
            for (_, pending) in inner.pending.drain() {
                let _ = pending
                    .sender
                    .send(rpc_error(pending.rpc_id, -32000, "App unavailable"));
            }
            session
        } else {
            None
        }
    }
    pub fn stop(&self) {
        let session = self.revoke();
        let revoked = session.as_ref().map(|s| s.connection.revision.clone());
        if let Some(session) = session {
            if let Ok(entry) = keyring::Entry::new(KEYRING, &session.connection.grant_id) {
                let _ = entry.delete_credential();
            }
        }
        let _ = self.emit("mcp-state", json!({"active":false,"revision":revoked}));
    }
    pub fn enable(self: &Arc<Self>, app_data: &Path, vault_id: &str, policy: Policy) -> Res<Value> {
        // keyring defaults to a mock backend on targets without a selected native provider.
        if !cfg!(any(target_os = "macos", target_os = "windows")) {
            return Err("Operating system credential store unavailable on this platform".into());
        }
        if !policy.valid() {
            return Err("Invalid connection scope".into());
        }
        {
            let inner = self.inner.lock().map_err(err)?;
            if !inner
                .ready
                .as_ref()
                .is_some_and(|(_, id, at)| id == vault_id && at.elapsed() < Duration::from_secs(10))
            {
                return Err("App unavailable".into());
            }
        }
        self.stop();
        let file = config_path(app_data, vault_id);
        let grant_id = if file.exists() {
            let prior: Connection = serde_json::from_slice(&fs::read(&file).map_err(err)?)
                .map_err(|_| "Invalid connection configuration")?;
            crate::vault::check_id(&prior.grant_id)?;
            if prior.vault_id != vault_id {
                return Err("Connection vault changed".into());
            }
            prior.grant_id
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let connection = Connection {
            writes_available: cfg!(feature = "mcp-write-acceptance"),
            grant_id,
            revision: uuid::Uuid::new_v4().to_string(),
            vault_id: vault_id.to_string(),
            policy,
        };
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(err)?;
        listener.set_nonblocking(true).map_err(err)?;
        let endpoint = format!("http://{}/mcp", listener.local_addr().map_err(err)?);
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        keyring::Entry::new(KEYRING, &connection.grant_id)
            .and_then(|entry| entry.set_password(&token))
            .map_err(|_| "Operating system credential store unavailable")?;
        if crate::vault::write_atomic(&file, &serde_json::to_vec(&connection).map_err(err)?)
            .is_err()
        {
            if let Ok(entry) = keyring::Entry::new(KEYRING, &connection.grant_id) {
                let _ = entry.delete_credential();
            }
            return Err("Cannot save connection configuration".into());
        }
        let revision = connection.revision.clone();
        self.inner.lock().map_err(err)?.session = Some(Session {
            connection,
            token,
            endpoint,
        });
        let host = self.clone();
        std::thread::spawn(move || {
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                runtime.block_on(serve(listener, host, revision));
            }
        });
        self.status()
    }
    /// Called with the vault OS lock held, immediately before the durable prepare.
    /// Keep the session lock until prepare completes so revoke/cancel linearize on either side of admission.
    pub fn write_guard(
        &self,
        vault_id: &str,
        admission: &WriteAdmission,
        root: &Path,
        record: &Value,
    ) -> Res<WritePermit<'_>> {
        let inner = self.inner.lock().map_err(err)?;
        let session = inner.session.as_ref().ok_or("Connection revoked")?;
        if session.connection.vault_id != vault_id
            || session.connection.revision != admission.revision
            || !session.connection.policy.allow_writes
            || record["scopeId"] != session.connection.grant_id
            || !inner
                .ready
                .as_ref()
                .is_some_and(|(_, id, at)| id == vault_id && at.elapsed() < Duration::from_secs(10))
            || !inner
                .pending
                .get(&admission.request_id)
                .is_some_and(|pending| {
                    pending.revision == admission.revision && Instant::now() < pending.expires_at
                })
        {
            return Err("Write admission access denied".into());
        }
        let connection = session.connection.clone();
        drop(inner); // scanning holds the vault lock, but must not delay cancellation or heartbeat
        let mut pages = HashMap::<String, Value>::new();
        for entry in fs::read_dir(root.join("pages")).map_err(err)? {
            let path = entry.map_err(err)?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let page: Value = serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
            let id = page["id"].as_str().ok_or("Write admission access denied")?;
            pages.insert(id.to_owned(), page);
        }
        let policy = &connection.policy;
        let can_read = |id: &str| scope_allows(policy, &pages, id);
        let can_create = |parent: &Value| {
            if parent.is_null() {
                policy.whole_vault
            } else {
                parent.as_str().is_some_and(can_read)
            }
        };
        let before = &record["before"];
        let after = &record["after"];
        if if before.is_null() {
            !can_create(&after["parentId"])
        } else {
            !before["id"].as_str().is_some_and(can_read)
                || (before["parentId"] != after["parentId"] && !can_create(&after["parentId"]))
        } {
            return Err("Write admission access denied".into());
        }
        fn links(node: &Value, result: &mut std::collections::HashSet<String>) {
            if node["type"] == "pageLink" {
                if let Some(id) = node["attrs"]["id"].as_str() {
                    result.insert(id.to_owned());
                }
            }
            if let Some(children) = node["content"].as_array() {
                for child in children {
                    links(child, result);
                }
            }
        }
        let mut previous = std::collections::HashSet::new();
        links(&before["content"], &mut previous);
        let mut next = std::collections::HashSet::new();
        links(&after["content"], &mut next);
        if next.difference(&previous).any(|id| !can_read(id)) {
            return Err("Write admission access denied".into());
        }
        let inner = self.inner.lock().map_err(err)?;
        if !inner.session.as_ref().is_some_and(|s| {
            s.connection.revision == admission.revision && s.connection.vault_id == vault_id
        }) || !inner
            .pending
            .get(&admission.request_id)
            .is_some_and(|p| p.revision == admission.revision && Instant::now() < p.expires_at)
            || !inner
                .ready
                .as_ref()
                .is_some_and(|(_, id, at)| id == vault_id && at.elapsed() < Duration::from_secs(10))
        {
            return Err("Write admission access denied".into());
        }
        Ok(WritePermit { _guard: inner })
    }
    pub fn credential(&self) -> Res<String> {
        let inner = self.inner.lock().map_err(err)?;
        let session = inner.session.as_ref().ok_or("Connection disabled")?;
        // Explicit local UI action only. Never expose credentials in status or protocol responses.
        keyring::Entry::new(KEYRING, &session.connection.grant_id)
            .and_then(|entry| entry.get_password())
            .map_err(|_| "Operating system credential store unavailable".into())
    }
    pub fn reply(&self, request_id: &str, revision: &str, result: Value) -> Res<()> {
        if result.to_string().len() > MAX_RESPONSE {
            return Err("Response limit exceeded".into());
        }
        let mut inner = self.inner.lock().map_err(err)?;
        if !inner
            .session
            .as_ref()
            .is_some_and(|s| s.connection.revision == revision)
        {
            return Err("Connection revoked".into());
        }
        if !inner
            .pending
            .get(request_id)
            .is_some_and(|p| p.revision == revision)
        {
            return Err("Request expired".into());
        }
        let pending = inner.pending.remove(request_id).ok_or("Request expired")?;
        if !result.is_null() && (result["id"] != pending.rpc_id || result["jsonrpc"] != "2.0") {
            return Err("Invalid response identity".into());
        }
        pending
            .sender
            .send(result)
            .map_err(|_| "Request expired".into())
    }
}
fn scope_allows(policy: &Policy, pages: &HashMap<String, Value>, id: &str) -> bool {
    let mut current = Some(id);
    let mut seen = std::collections::HashSet::new();
    let mut selected = policy.whole_vault;
    while let Some(id) = current {
        if !seen.insert(id)
            || seen.len() > 128
            || policy.excluded_ids.iter().any(|excluded| excluded == id)
        {
            return false;
        }
        let Some(page) = pages.get(id) else {
            return false;
        };
        if policy.root_ids.iter().any(|root| root == id) {
            selected = true;
        }
        current = match page.get("parentId") {
            Some(Value::Null) => None,
            Some(Value::String(id)) => Some(id),
            _ => return false,
        };
    }
    selected
}
fn config_path(base: &Path, vault_id: &str) -> PathBuf {
    base.join("mcp")
        .join(format!("{:x}.json", Sha256::digest(vault_id.as_bytes())))
}
fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn response(status: StatusCode, body: Value) -> Response<Full<Bytes>> {
    let bytes = if body.is_null() {
        Vec::new()
    } else {
        body.to_string().into_bytes()
    };
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Full::new(Bytes::from(bytes)))
        .unwrap()
}
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |value, (a, b)| value | (a ^ b))
            == 0
}
fn authenticate<B>(
    request: &Request<B>,
    host: &Host,
    revision: &str,
) -> Result<Connection, StatusCode> {
    let inner = host
        .inner
        .lock()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let session = inner
        .session
        .as_ref()
        .filter(|s| s.connection.revision == revision)
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    if request.headers().contains_key("origin") {
        return Err(StatusCode::FORBIDDEN);
    }
    let expected_host = session
        .endpoint
        .trim_start_matches("http://")
        .trim_end_matches("/mcp");
    if request.headers().get_all("host").iter().count() != 1
        || request.headers().get("host").and_then(|v| v.to_str().ok()) != Some(expected_host)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    if request.headers().get_all("authorization").iter().count() != 1
        || !request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .is_some_and(|token| same_secret(token, &session.token))
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(session.connection.clone())
}
async fn handle(
    request: Request<Incoming>,
    host: Arc<Host>,
    revision: String,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let connection = match authenticate(&request, &host, &revision) {
        Ok(connection) => connection,
        Err(status) => return Ok(response(status, Value::Null)),
    };
    if !host.active(&revision) {
        return Ok(response(
            StatusCode::SERVICE_UNAVAILABLE,
            rpc_error(Value::Null, -32000, "App unavailable"),
        ));
    }
    if request.uri().path() != "/mcp" || request.uri().query().is_some() {
        return Ok(response(StatusCode::NOT_FOUND, Value::Null));
    }
    if request.method() != hyper::Method::POST {
        return Ok(response(StatusCode::METHOD_NOT_ALLOWED, Value::Null));
    }
    if request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or("").trim())
        != Some("application/json")
        || request.headers().contains_key("content-encoding")
    {
        return Ok(response(StatusCode::UNSUPPORTED_MEDIA_TYPE, Value::Null));
    }
    let accept = request
        .headers()
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return Ok(response(StatusCode::NOT_ACCEPTABLE, Value::Null));
    }
    let version = request
        .headers()
        .get("mcp-protocol-version")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let bytes = match tokio::time::timeout(
        Duration::from_secs(5),
        Limited::new(request.into_body(), MAX_REQUEST).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        _ => return Ok(response(StatusCode::PAYLOAD_TOO_LARGE, Value::Null)),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => {
            return Ok(response(
                StatusCode::BAD_REQUEST,
                rpc_error(Value::Null, -32700, "Parse error"),
            ))
        }
    };
    if body.get("method").and_then(Value::as_str) != Some("initialize")
        && version.as_deref() != Some(VERSION)
    {
        return Ok(response(StatusCode::BAD_REQUEST, Value::Null));
    }
    if body["jsonrpc"] == "2.0"
        && body.get("id").is_none()
        && body["method"] == "notifications/cancelled"
        && (body["params"]["requestId"].is_string() || body["params"]["requestId"].is_i64())
    {
        let rpc_id = &body["params"]["requestId"];
        let mut inner = host.inner.lock().unwrap();
        let ids: Vec<_> = inner
            .pending
            .iter()
            .filter(|(_, p)| p.revision == revision && &p.rpc_id == rpc_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(pending) = inner.pending.remove(id) {
                let _ = pending
                    .sender
                    .send(rpc_error(pending.rpc_id, -32800, "Request cancelled"));
            }
        }
        drop(inner);
        for id in ids {
            let _ = host.emit("mcp-cancel", json!({"requestId":id}));
        }
        return Ok(response(StatusCode::ACCEPTED, Value::Null));
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut inner = host.inner.lock().unwrap();
        if !inner
            .session
            .as_ref()
            .is_some_and(|s| s.connection.revision == revision)
        {
            return Ok(response(StatusCode::SERVICE_UNAVAILABLE, Value::Null));
        }
        if inner
            .rate
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(1))
        {
            inner.rate = Some((Instant::now(), 0));
        }
        if inner.pending.len() >= MAX_PENDING || inner.rate.as_ref().unwrap().1 >= 16 {
            return Ok(response(StatusCode::TOO_MANY_REQUESTS, Value::Null));
        }
        inner.rate.as_mut().unwrap().1 += 1;
        inner.pending.insert(
            request_id.clone(),
            Pending {
                expires_at: Instant::now() + host.deadline,
                sender,
                rpc_id: body.get("id").cloned().unwrap_or(Value::Null),
                revision: revision.clone(),
            },
        );
    }
    let expires_at = crate::vault::now_ms() + host.deadline.as_millis() as i64;
    if host.emit("mcp-request", json!({"requestId":request_id,"connection":connection,"message":body,"expiresAt":expires_at})).is_err() {
        host.inner.lock().unwrap().pending.remove(&request_id);
        return Ok(response(StatusCode::SERVICE_UNAVAILABLE, rpc_error(body.get("id").cloned().unwrap_or(Value::Null), -32000, "App unavailable")));
    }
    let result = tokio::time::timeout(host.deadline, receiver).await;
    host.inner.lock().unwrap().pending.remove(&request_id);
    if !host.active(&revision) {
        return Ok(response(
            StatusCode::SERVICE_UNAVAILABLE,
            rpc_error(
                body.get("id").cloned().unwrap_or(Value::Null),
                -32000,
                "App unavailable",
            ),
        ));
    }
    match result {
        Ok(Ok(value)) => Ok(response(
            if value.is_null() {
                StatusCode::ACCEPTED
            } else {
                StatusCode::OK
            },
            value,
        )),
        _ => {
            let _ = host.emit("mcp-cancel", json!({"requestId":request_id}));
            Ok(response(
                StatusCode::GATEWAY_TIMEOUT,
                rpc_error(
                    body.get("id").cloned().unwrap_or(Value::Null),
                    -32000,
                    "App unavailable",
                ),
            ))
        }
    }
}
async fn serve(listener: TcpListener, host: Arc<Host>, revision: String) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        return;
    };
    let sockets = Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        if !host.inner.lock().ok().is_some_and(|inner| {
            inner
                .session
                .as_ref()
                .is_some_and(|s| s.connection.revision == revision)
        }) {
            break;
        }
        if let Ok(Ok((socket, peer))) =
            tokio::time::timeout(Duration::from_millis(200), listener.accept()).await
        {
            if !peer.ip().is_loopback() {
                continue;
            }
            let Ok(permit) = sockets.clone().try_acquire_owned() else {
                continue;
            };
            let host = host.clone();
            let revision = revision.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let service = hyper::service::service_fn(move |request| {
                    handle(request, host.clone(), revision.clone())
                });
                let io = hyper_util::rt::TokioIo::new(socket);
                let connection = hyper::server::conn::http1::Builder::new()
                    .keep_alive(false)
                    .max_buf_size(16_384)
                    .serve_connection(io, service);
                let _ = tokio::time::timeout(Duration::from_secs(27), connection).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::blocking::Client;
    const TOKEN: &str = "fixture-secret";
    fn fixture(
        reply: bool,
        deadline: Duration,
    ) -> (
        Arc<Host>,
        String,
        std::thread::JoinHandle<()>,
        std::sync::mpsc::Receiver<Value>,
    ) {
        let host = Arc::new(Host {
            deadline,
            ..Host::default()
        });
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let connection = Connection {
            writes_available: cfg!(feature = "mcp-write-acceptance"),
            grant_id: uuid::Uuid::new_v4().to_string(),
            revision: "revision".into(),
            vault_id: "vault".into(),
            policy: Policy {
                whole_vault: true,
                root_ids: vec![],
                excluded_ids: vec![],
                allow_writes: false,
            },
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        let weak = Arc::downgrade(&host);
        host.set_bridge(Arc::new(move |event, payload| {
            if event == "mcp-request" {
                sender.send(payload.clone()).unwrap();
                if reply { weak.upgrade().unwrap().reply(payload["requestId"].as_str().unwrap(), "revision", json!({"jsonrpc":"2.0","id":payload["message"]["id"],"result":{"fixture":true}}))?; }
            }
            Ok(())
        }), Arc::new(|| Some("vault".into())));
        {
            let mut inner = host.inner.lock().unwrap();
            inner.ready = Some(("owner".into(), "vault".into(), Instant::now()));
            inner.session = Some(Session {
                connection,
                token: TOKEN.into(),
                endpoint: endpoint.clone(),
            });
        }
        let serving = host.clone();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(serve(listener, serving, "revision".into()))
        });
        (host, endpoint, thread, receiver)
    }
    fn post(client: &Client, url: &str, value: Value) -> reqwest::blocking::RequestBuilder {
        client
            .post(url)
            .bearer_auth(TOKEN)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", VERSION)
            .json(&value)
    }
    #[test]
    fn loopback_roundtrip_guards_bounds_status_and_revocation() {
        let (host, url, server, events) = fixture(true, Duration::from_secs(2));
        let client = Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let body = json!({"jsonrpc":"2.0","id":1,"method":"ping"});
        let response = post(&client, &url, body.clone()).send().unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.json::<Value>().unwrap()["result"]["fixture"], true);
        let event = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(!event.to_string().contains(TOKEN));
        assert!(!host.status().unwrap().to_string().contains(TOKEN));
        assert_eq!(client.post(&url).json(&body).send().unwrap().status(), 401);
        assert_eq!(
            post(&client, &url, body.clone())
                .header("Origin", "https://evil.example")
                .send()
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            post(&client, &url, body.clone())
                .header("Host", "localhost")
                .send()
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client.get(&url).bearer_auth(TOKEN).send().unwrap().status(),
            405
        );
        assert_eq!(
            post(&client, &url.replace("/mcp", "/other"), body.clone())
                .send()
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            post(&client, &url, body.clone())
                .headers(reqwest::header::HeaderMap::from_iter([(
                    reqwest::header::HeaderName::from_static("mcp-protocol-version"),
                    reqwest::header::HeaderValue::from_static("wrong")
                )]))
                .send()
                .unwrap()
                .status(),
            400
        );
        assert_eq!(
            post(&client, &url, body.clone())
                .headers(reqwest::header::HeaderMap::from_iter([(
                    reqwest::header::ACCEPT,
                    reqwest::header::HeaderValue::from_static("application/json")
                )]))
                .send()
                .unwrap()
                .status(),
            406
        );
        assert_eq!(
            post(&client, &url, body.clone())
                .headers(reqwest::header::HeaderMap::from_iter([(
                    reqwest::header::CONTENT_TYPE,
                    reqwest::header::HeaderValue::from_static("text/plain")
                )]))
                .send()
                .unwrap()
                .status(),
            415
        );
        assert_eq!(
            post(&client, &url, body)
                .body("x".repeat(MAX_REQUEST + 1))
                .send()
                .unwrap()
                .status(),
            413
        );
        let mut policy = Policy {
            whole_vault: true,
            root_ids: vec![],
            excluded_ids: vec![],
            allow_writes: false,
        };
        assert!(policy.valid());
        policy.allow_writes = true;
        assert_eq!(policy.valid(), cfg!(feature = "mcp-write-acceptance"));
        policy.whole_vault = false;
        assert!(!policy.valid());
        {
            let mut inner = host.inner.lock().unwrap();
            for i in 0..MAX_PENDING {
                let (sender, _) = oneshot::channel();
                inner.pending.insert(
                    format!("quota-{i}"),
                    Pending {
                        expires_at: Instant::now() + Duration::from_secs(2),
                        sender,
                        rpc_id: json!(i),
                        revision: "revision".into(),
                    },
                );
            }
        }
        assert_eq!(
            post(
                &client,
                &url,
                json!({"jsonrpc":"2.0","id":99,"method":"ping"})
            )
            .send()
            .unwrap()
            .status(),
            429
        );
        host.inner.lock().unwrap().pending.clear();
        host.inner.lock().unwrap().rate = Some((Instant::now(), 16));
        assert_eq!(
            post(
                &client,
                &url,
                json!({"jsonrpc":"2.0","id":100,"method":"ping"})
            )
            .send()
            .unwrap()
            .status(),
            429
        );
        host.revoke();
        server.join().unwrap();
        assert!(!host.status().unwrap()["active"].as_bool().unwrap());
        assert!(client.get(&url).send().is_err());
    }
    #[test]
    fn pending_requests_cancel_expire_and_drain_without_a_vault_lock() {
        let (host, url, server, events) = fixture(false, Duration::from_millis(500));
        let client = Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let request_client = client.clone();
        let request_url = url.clone();
        let pending = std::thread::spawn(move || {
            post(
                &request_client,
                &request_url,
                json!({"jsonrpc":"2.0","id":7,"method":"ping"}),
            )
            .send()
            .unwrap()
        });
        let event = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(host.status().unwrap()["pending"], 1);
        let cancelled = post(
            &client,
            &url,
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}),
        )
        .send()
        .unwrap();
        assert_eq!(cancelled.status(), 202);
        assert_eq!(
            pending.join().unwrap().json::<Value>().unwrap()["error"]["code"],
            -32800
        );
        assert!(host
            .reply(
                event["requestId"].as_str().unwrap(),
                "revision",
                Value::Null
            )
            .is_err());
        assert_eq!(
            post(
                &client,
                &url,
                json!({"jsonrpc":"2.0","id":8,"method":"ping"})
            )
            .send()
            .unwrap()
            .status(),
            504
        );
        assert_eq!(host.status().unwrap()["pending"], 0);
        // Drain a pending request immediately when the grant is revoked.
        let request_client = client.clone();
        let request_url = url.clone();
        let pending = std::thread::spawn(move || {
            post(
                &request_client,
                &request_url,
                json!({"jsonrpc":"2.0","id":9,"method":"ping"}),
            )
            .send()
            .unwrap()
        });
        while events.recv_timeout(Duration::from_secs(1)).unwrap()["message"]["id"] != 9 {}
        host.revoke();
        assert_eq!(pending.join().unwrap().status(), 503);
        server.join().unwrap();
    }
    #[test]
    fn write_admission_requires_current_scope_pending_request_and_deadline() {
        let host = Host::default();
        let root = std::env::temp_dir().join(format!("nevis-admission-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("pages")).unwrap();
        let note = uuid::Uuid::new_v4().to_string();
        let ancestor = uuid::Uuid::new_v4().to_string();
        let private = uuid::Uuid::new_v4().to_string();
        let save = |id: &str, parent: Value| {
            fs::write(
                root.join("pages").join(format!("{id}.json")),
                json!({"id":id,"parentId":parent}).to_string(),
            )
            .unwrap()
        };
        save(&note, json!(ancestor));
        save(&ancestor, Value::Null);
        save(&private, Value::Null);
        let admission = WriteAdmission {
            request_id: "request".into(),
            revision: "revision".into(),
        };
        let record = json!({"scopeId":"grant","before":{"id":note,"parentId":ancestor},"after":{"id":note,"parentId":ancestor}});
        let (sender, _) = oneshot::channel();
        {
            let mut inner = host.inner.lock().unwrap();
            inner.ready = Some(("owner".into(), "vault".into(), Instant::now()));
            inner.session = Some(Session {
                connection: Connection {
                    writes_available: true,
                    grant_id: "grant".into(),
                    revision: "revision".into(),
                    vault_id: "vault".into(),
                    policy: Policy {
                        whole_vault: false,
                        root_ids: vec![ancestor.clone()],
                        excluded_ids: vec![private.clone()],
                        allow_writes: true,
                    },
                },
                token: "test".into(),
                endpoint: "unused".into(),
            });
            inner.pending.insert(
                "request".into(),
                Pending {
                    expires_at: Instant::now() + Duration::from_secs(10),
                    sender,
                    rpc_id: json!(1),
                    revision: "revision".into(),
                },
            );
        }
        drop(
            host.write_guard("vault", &admission, &root, &record)
                .unwrap(),
        );
        save(&ancestor, json!(private));
        assert!(host
            .write_guard("vault", &admission, &root, &record)
            .is_err());
        save(&ancestor, Value::Null);
        host.inner
            .lock()
            .unwrap()
            .pending
            .get_mut("request")
            .unwrap()
            .expires_at = Instant::now();
        assert!(host
            .write_guard("vault", &admission, &root, &record)
            .is_err());
        host.inner.lock().unwrap().pending.clear();
        assert!(host
            .write_guard("vault", &admission, &root, &record)
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
