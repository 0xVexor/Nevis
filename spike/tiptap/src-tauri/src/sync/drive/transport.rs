//! Drive v3 transport. IDs, never names, are the identity of published files.
use super::super::snapshot::hash;
use super::{
    auth,
    core::{bytes, valid_hash},
};
use crate::vault::{err, Res};
use reqwest::{
    blocking::{Client, RequestBuilder, Response},
    StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::Mutex,
    time::{Duration, Instant},
};
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const FIELDS: &str = "id,name,mimeType,parents,trashed,size,appProperties";
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    pub requests: u64,
    pub uploaded_bytes: u64,
    pub downloaded_bytes: u64,
    pub rate_limits: u64,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub wall_elapsed_ms: u64,
    #[serde(default)]
    pub operation_elapsed_ms: BTreeMap<String, u64>,
    pub operations: BTreeMap<String, u64>,
    #[serde(default)]
    pub header_latency_ms: Vec<u64>,
    /// Wall-clock milliseconds spent in each phase of the last run (capture, discovery, objects, ...).
    #[serde(default)]
    pub phase_elapsed_ms: BTreeMap<String, u64>,
}
impl Meter {
    pub fn merge(&mut self, other: Meter) {
        self.requests += other.requests;
        self.uploaded_bytes += other.uploaded_bytes;
        self.downloaded_bytes += other.downloaded_bytes;
        self.rate_limits += other.rate_limits;
        self.elapsed_ms += other.elapsed_ms;
        for (k, v) in other.operations {
            *self.operations.entry(k).or_default() += v;
        }
        for (k, v) in other.operation_elapsed_ms {
            *self.operation_elapsed_ms.entry(k).or_default() += v;
        }
        self.header_latency_ms.extend(other.header_latency_ms);
        let excess = self.header_latency_ms.len().saturating_sub(512);
        self.header_latency_ms.drain(..excess);
    }
    pub fn phase(&mut self, name: &str, started: Instant) {
        *self.phase_elapsed_ms.entry(name.into()).or_default() += started.elapsed().as_millis() as u64;
    }
}
/// Upper bound of simultaneous Drive requests from one sync run. Kept low to stay clear of per-user rate limits.
pub const PARALLEL_REQUESTS: usize = 4;
/// Runs `work` for every item, up to `PARALLEL_REQUESTS` at a time, each worker with its own forked client.
/// Results come back in input order; the first failure (by input order) wins and stops the remaining items.
pub fn parallel_map<T: Send, R: Send>(
    drive: &mut Drive,
    items: Vec<T>,
    work: impl Fn(&mut Drive, T) -> Res<R> + Sync,
) -> Res<Vec<R>> {
    if items.len() <= 1 {
        return items.into_iter().map(|item| work(drive, item)).collect();
    }
    let total = items.len();
    let queue = Mutex::new(items.into_iter().enumerate().collect::<std::collections::VecDeque<_>>());
    let slots: Mutex<Vec<Option<Res<R>>>> = Mutex::new((0..total).map(|_| None).collect());
    let failed = std::sync::atomic::AtomicBool::new(false);
    let meters = Mutex::new(Vec::new());
    let width = PARALLEL_REQUESTS.min(total);
    let template = &*drive;
    std::thread::scope(|scope| {
        for _ in 0..width {
            scope.spawn(|| {
                let mut fork = template.fork();
                loop {
                    if failed.load(std::sync::atomic::Ordering::SeqCst) {
                        break;
                    }
                    let Some((index, item)) = queue.lock().ok().and_then(|mut q| q.pop_front()) else {
                        break;
                    };
                    let result = work(&mut fork, item);
                    if result.is_err() {
                        failed.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    if let Ok(mut slots) = slots.lock() {
                        slots[index] = Some(result);
                    }
                }
                if let Ok(mut meters) = meters.lock() {
                    meters.push(fork.meter);
                }
            });
        }
    });
    for meter in meters.into_inner().map_err(|_| "DRIVE:network")? {
        drive.meter.merge(meter);
    }
    let mut out = Vec::with_capacity(total);
    for slot in slots.into_inner().map_err(|_| "DRIVE:network")? {
        match slot {
            Some(Ok(value)) => out.push(value),
            Some(Err(error)) => return Err(error),
            None => return Err("DRIVE:network".into()),
        }
    }
    Ok(out)
}
// Clones share reqwest's connection pool, including TLS sessions, across sync runs.
// Rotate periodically so a changed system proxy is picked up without restarting Nevis.
#[derive(Default)]
struct HttpPool {
    current: Option<(Instant, Client)>,
}
impl HttpPool {
    fn client(&mut self) -> Res<Client> {
        if let Some((created, client)) = &self.current {
            if created.elapsed() < Duration::from_secs(300) {
                return Ok(client.clone());
            }
        }
        let client = build_http()?;
        self.current = Some((Instant::now(), client.clone()));
        Ok(client)
    }
}
static HTTP_POOL: Mutex<HttpPool> = Mutex::new(HttpPool { current: None });
pub fn http() -> Res<Client> {
    HTTP_POOL
        .lock()
        .map_err(|_| "DRIVE:network_configuration")?
        .client()
}
fn build_http() -> Res<Client> {
    Client::builder()
        .pool_idle_timeout(Duration::from_secs(300))
        .pool_max_idle_per_host(4)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .user_agent("Nevis-Drive/1")
        .build()
        .map_err(|_| "DRIVE:network_configuration".into())
}
pub fn json_response(r: Response, limit: usize) -> Res<Value> {
    let b = read_response(r, limit)?;
    serde_json::from_slice(&b).map_err(|_| "DRIVE:invalid_response".into())
}
fn read_response(r: Response, limit: usize) -> Res<Vec<u8>> {
    if r.content_length().is_some_and(|n| n > limit as u64) {
        return Err("DRIVE:response_too_large".into());
    }
    let mut b = vec![];
    r.take(limit as u64 + 1)
        .read_to_end(&mut b)
        .map_err(|_| "DRIVE:network")?;
    if b.len() > limit {
        return Err("DRIVE:response_too_large".into());
    }
    Ok(b)
}
pub fn classify(status: u16, reason: &str, retry: u64) -> String {
    match status {
        401 => "DRIVE:sign_in_required".into(),
        403 if ["rateLimitExceeded", "userRateLimitExceeded"].contains(&reason) => {
            format!("DRIVE:rate_limited:{}", retry.max(60))
        }
        429 => format!("DRIVE:rate_limited:{}", retry.max(60)),
        403 if reason == "storageQuotaExceeded" => "DRIVE:storage_full".into(),
        403 => "DRIVE:permission_denied".into(),
        404 => "DRIVE:remote_unavailable".into(),
        409 => "DRIVE:id_collision".into(),
        410 => "DRIVE:cursor_expired".into(),
        500..=599 => "DRIVE:service_unavailable".into(),
        _ => format!("DRIVE:http_{status}"),
    }
}
pub struct Drive {
    client: Client,
    token: String,
    pub meter: Meter,
    api: String,
    upload: String,
    pause_signal: Option<std::path::PathBuf>,
    #[cfg(test)]
    refresh: Option<fn() -> Res<String>>,
}
impl Drive {
    pub fn new() -> Res<Self> {
        Ok(Self {
            client: http()?,
            token: auth::access(false)?,
            meter: Meter::default(),
            api: API.into(),
            upload: UPLOAD.into(),
            pause_signal: None,
            #[cfg(test)]
            refresh: None,
        })
    }
    pub fn cancellable(mut self, path: std::path::PathBuf) -> Self {
        self.pause_signal = Some(path);
        self
    }
    /// Another client for a worker thread: same connection pool, token and pause signal, separate meter.
    pub fn fork(&self) -> Drive {
        Drive {
            client: self.client.clone(),
            token: self.token.clone(),
            meter: Meter::default(),
            api: self.api.clone(),
            upload: self.upload.clone(),
            pause_signal: self.pause_signal.clone(),
            #[cfg(test)]
            refresh: self.refresh,
        }
    }
    fn check_pause(&self) -> Res<()> {
        if self.pause_signal.as_ref().is_some_and(|p| p.exists()) {
            Err("DRIVE:paused".into())
        } else {
            Ok(())
        }
    }
    fn refresh_token(&mut self) -> Res<String> {
        #[cfg(test)]
        if let Some(refresh) = self.refresh {
            return refresh();
        }
        auth::access(true)
    }
    fn send(&mut self, operation: &str, make: impl Fn(&Client) -> RequestBuilder) -> Res<Response> {
        self.check_pause()?;
        for attempt in 0..2 {
            let start = Instant::now();
            self.meter.requests += 1;
            *self.meter.operations.entry(operation.into()).or_default() += 1;
            let response = make(&self.client).bearer_auth(&self.token).send();
            let elapsed = start.elapsed().as_millis() as u64;
            self.meter.elapsed_ms += elapsed;
            *self
                .meter
                .operation_elapsed_ms
                .entry(operation.into())
                .or_default() += elapsed;
            if self.meter.header_latency_ms.len() == 512 {
                self.meter.header_latency_ms.remove(0);
            }
            self.meter.header_latency_ms.push(elapsed);
            let r = response.map_err(|_| {
                if let Ok(mut pool) = HTTP_POOL.lock() {
                    pool.current = None;
                }
                "DRIVE:network"
            })?;
            if r.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                self.token = self.refresh_token()?;
                continue;
            }
            if r.status().is_success() || r.status().as_u16() == 308 {
                return Ok(r);
            }
            let status = r.status().as_u16();
            let retry = super::schedule::retry_seconds(
                r.headers().get("Retry-After").and_then(|h| h.to_str().ok()),
                std::time::SystemTime::now(),
            );
            let v = json_response(r, 64 * 1024).unwrap_or(Value::Null);
            let reason = v["error"]["errors"][0]["reason"].as_str().unwrap_or("");
            let error = classify(status, reason, retry);
            if error.starts_with("DRIVE:rate_limited:") {
                self.meter.rate_limits += 1;
            }
            return Err(error);
        }
        Err("DRIVE:sign_in_required".into())
    }
    pub fn generate_id(&mut self) -> Res<String> {
        self.generate_ids(1)?
            .into_iter()
            .next()
            .ok_or("DRIVE:invalid_response".into())
    }
    /// One request reserves `count` IDs (Drive allows up to 1000 per call).
    pub fn generate_ids(&mut self, count: usize) -> Res<Vec<String>> {
        let count = count.clamp(1, 100);
        let u = format!("{}/files/generateIds", self.api);
        let n = count.to_string();
        let r = self.send("generateIds", |c| {
            c.get(&u)
                .query(&[("count", n.as_str()), ("space", "drive"), ("type", "files")])
        })?;
        let v = json_response(r, 64 * 1024)?;
        let ids: Vec<String> = v["ids"]
            .as_array()
            .ok_or("DRIVE:invalid_response")?
            .iter()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect();
        if ids.len() != count || ids.iter().any(|id| check_id(id).is_err()) {
            return Err("DRIVE:invalid_response".into());
        }
        Ok(ids)
    }
    pub fn metadata(&mut self, id: &str) -> Res<Value> {
        check_id(id)?;
        let u = format!("{}/files/{id}", self.api);
        let r = self.send("files.get", |c| c.get(&u).query(&[("fields", FIELDS)]))?;
        let v = json_response(r, 64 * 1024)?;
        if v["trashed"] == true {
            return Err("DRIVE:remote_unavailable".into());
        }
        Ok(v)
    }
    pub fn list(&mut self, query: &str) -> Res<Vec<Value>> {
        let u = format!("{}/files", self.api);
        let mut token = String::new();
        let mut out = vec![];
        let mut seen = std::collections::BTreeSet::new();
        loop {
            let r = self.send("files.list", |c| {
                c.get(&u).query(&[
                    ("q", query),
                    ("spaces", "drive"),
                    ("pageSize", "1000"),
                    ("fields", &format!("nextPageToken,files({FIELDS})")),
                    ("pageToken", token.as_str()),
                ])
            })?;
            let v = json_response(r, 4 * 1024 * 1024)?;
            out.extend(
                v["files"]
                    .as_array()
                    .ok_or("DRIVE:invalid_response")?
                    .iter()
                    .cloned(),
            );
            match v["nextPageToken"].as_str() {
                Some(t) if seen.insert(t.to_string()) => token = t.into(),
                Some(_) => return Err("DRIVE:pagination_cycle".into()),
                None => return Ok(out),
            }
        }
    }
    pub fn start_token(&mut self) -> Res<String> {
        let u = format!("{}/changes/startPageToken", self.api);
        let r = self.send("changes.start", |c| {
            c.get(&u).query(&[("fields", "startPageToken")])
        })?;
        json_response(r, 8192)?["startPageToken"]
            .as_str()
            .map(str::to_string)
            .ok_or("DRIVE:invalid_response".into())
    }
    pub fn changes(&mut self, token: &str) -> Res<Value> {
        let u = format!("{}/changes", self.api);
        let r = self.send("changes.list", |c| {
            c.get(&u).query(&[
                ("pageToken", token),
                ("pageSize", "1000"),
                ("spaces", "drive"),
                ("includeRemoved", "true"),
                (
                    "fields",
                    &format!(
                        "nextPageToken,newStartPageToken,changes(fileId,removed,file({FIELDS}))"
                    ),
                ),
            ])
        })?;
        json_response(r, 4 * 1024 * 1024)
    }
    pub fn download(&mut self, id: &str, expected: &str, max: usize) -> Res<Vec<u8>> {
        check_id(id)?;
        if !valid_hash(expected) {
            return Err("DRIVE:invalid_hash".into());
        }
        let u = format!("{}/files/{id}", self.api);
        let r = self.send("files.download", |c| c.get(&u).query(&[("alt", "media")]))?;
        let b = read_response(r, max)?;
        self.meter.downloaded_bytes += b.len() as u64;
        if hash(&b) != expected {
            return Err("DRIVE:integrity".into());
        }
        Ok(b)
    }
    pub fn create_folder(
        &mut self,
        id: &str,
        name: &str,
        parent: Option<&str>,
        props: &Value,
    ) -> Res<()> {
        check_id(id)?;
        if let Some(p) = parent {
            check_id(p)?;
        }
        match self.metadata(id) {
            Ok(v) => {
                if v["mimeType"] != "application/vnd.google-apps.folder"
                    || v["appProperties"] != *props
                    || parent.is_some_and(|p| {
                        !v["parents"]
                            .as_array()
                            .is_some_and(|a| a.contains(&json!(p)))
                    })
                {
                    return Err("DRIVE:identity_mismatch".into());
                }
                return Ok(());
            }
            Err(e) if e == "DRIVE:remote_unavailable" => (),
            Err(e) => return Err(e),
        }
        let mut meta = json!({"id":id,"name":name,"mimeType":"application/vnd.google-apps.folder","appProperties":props});
        if let Some(p) = parent {
            meta["parents"] = json!([p]);
        }
        let u = format!("{}/files", self.api);
        self.send("folder.create", |c| c.post(&u).json(&meta))?;
        Ok(())
    }
    /// Immutable create with a preallocated ID. Unknown response is reconciled by exact ID on retry.
    pub fn put(
        &mut self,
        id: &str,
        parent: &str,
        kind: &str,
        vault: &str,
        key: &str,
        data: &[u8],
    ) -> Res<()> {
        check_id(id)?;
        check_id(parent)?;
        let digest = hash(data);
        if data.len() > 4 * 1024 * 1024 {
            return Err("DRIVE:marker_too_large".into());
        }
        let props = json!({"nevisProtocol":"1","nevisKind":kind,"nevisVault":vault,"nevisKey":key,"sha256":digest});
        let meta = json!({"id":id,"name":key,"parents":[parent],"appProperties":props});
        // Small immutable markers carry metadata and bytes in one request, not an unjournaled session.
        let boundary = format!("nevis-{}", uuid::Uuid::new_v4());
        let mut payload=format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n",meta).into_bytes();
        payload.extend_from_slice(data);
        payload.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        // Create directly: the reserved ID makes a repeated create harmless. The response carries the
        // stored metadata and Drive's own MD5 of the stored bytes, so a fresh create needs no read-back.
        let u = format!(
            "{}/files?uploadType=multipart&fields={FIELDS},md5Checksum",
            self.upload
        );
        let sent = self.send("upload.marker", |c| {
            c.post(&u)
                .header(
                    "Content-Type",
                    format!("multipart/related; boundary={boundary}"),
                )
                .body(payload.clone())
        });
        match sent {
            Ok(r) => {
                self.meter.uploaded_bytes += data.len() as u64;
                if let Ok(created) = json_response(r, 64 * 1024) {
                    if created["id"] == id
                        && verify(&created, parent, kind, vault, key, &digest).is_ok()
                        && created["size"].as_str() == Some(&data.len().to_string())
                        && created["md5Checksum"].as_str() == Some(&md5_hex(data))
                    {
                        return Ok(());
                    }
                }
                // No usable checksum in the response: confirm by reading the object back.
                self.confirm_marker(id, parent, kind, vault, key, &digest, data.len())
            }
            // A pause, quota or sign-in problem says nothing about whether the create landed.
            // Any other failure (an unknown result, or the ID already existing) is settled by
            // looking the reserved ID up: present and identical means an earlier attempt landed.
            Err(e) if e == "DRIVE:paused" || e == "DRIVE:sign_in_required" || e == "DRIVE:storage_full" || e.starts_with("DRIVE:rate_limited:") => Err(e),
            Err(e) => match self.confirm_marker(id, parent, kind, vault, key, &digest, data.len()) {
                Ok(()) => Ok(()),
                // Nothing there (or unreachable): report the failure of the create itself.
                Err(c) if c == "DRIVE:remote_unavailable" || c == "DRIVE:network" => Err(e),
                // Something is there but it is not our object: that is the real problem.
                Err(c) => Err(c),
            },
        }
    }
    fn confirm_marker(
        &mut self,
        id: &str,
        parent: &str,
        kind: &str,
        vault: &str,
        key: &str,
        digest: &str,
        len: usize,
    ) -> Res<()> {
        let meta = self.metadata(id)?;
        verify(&meta, parent, kind, vault, key, digest)?;
        self.download(id, digest, len)?;
        Ok(())
    }
    pub fn object(
        &mut self,
        parent: &str,
        vault: &str,
        digest: &str,
        data: Option<&[u8]>,
    ) -> Res<Vec<u8>> {
        if !valid_hash(digest) {
            return Err("DRIVE:invalid_hash".into());
        }
        check_id(parent)?;
        let q=format!("trashed = false and '{parent}' in parents and appProperties has {{ key='nevisKey' and value='{digest}' }}");
        let rows = self.list(&q)?;
        if let Some(m) = rows.first() {
            verify(m, parent, "object", vault, digest, digest)?;
            return self.download(
                m["id"].as_str().ok_or("DRIVE:invalid_response")?,
                digest,
                super::super::snapshot::MAX_FILE,
            );
        }
        let b = data.ok_or("DRIVE:missing_dependency")?;
        if hash(b) != digest {
            return Err("DRIVE:integrity".into());
        }
        let id = self.generate_id()?;
        self.put(&id, parent, "object", vault, digest, b)?;
        Ok(b.to_vec())
    }
}
fn md5_hex(data: &[u8]) -> String {
    use md5::{Digest, Md5};
    format!("{:x}", Md5::digest(data))
}
pub fn verify(
    meta: &Value,
    parent: &str,
    kind: &str,
    vault: &str,
    key: &str,
    digest: &str,
) -> Res<()> {
    if meta["trashed"] == true
        || !meta["parents"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(parent)))
        || meta["appProperties"]["nevisProtocol"] != "1"
        || meta["appProperties"]["nevisKind"] != kind
        || meta["appProperties"]["nevisVault"] != vault
        || meta["appProperties"]["nevisKey"] != key
        || meta["appProperties"]["sha256"] != digest
    {
        return Err("DRIVE:identity_or_integrity".into());
    }
    Ok(())
}
pub fn check_id(id: &str) -> Res<()> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        Err("DRIVE:invalid_file_id".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn stub(status: &str, body: &str) -> (String, std::thread::JoinHandle<()>) {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", socket.local_addr().unwrap());
        let body = body.to_string();
        let status = status.to_string();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = socket.accept().unwrap();
            let mut b = [0; 4096];
            let n = stream.read(&mut b).unwrap();
            assert!(String::from_utf8_lossy(&b[..n]).contains("Bearer test-token"));
            write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nRetry-After: 120\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        });
        (url, handle)
    }
    #[test]
    fn successive_sync_clients_reuse_one_connection() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", socket.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = socket.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            for _ in 0..2 {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                    .unwrap();
                stream.flush().unwrap();
            }
        });
        let mut pool = HttpPool::default();
        for _ in 0..2 {
            let client = pool.client().unwrap();
            assert_eq!(
                client
                    .get(&url)
                    .timeout(Duration::from_secs(3))
                    .send()
                    .unwrap()
                    .text()
                    .unwrap(),
                "{}"
            );
        }
        server.join().unwrap();
    }
    #[test]
    fn adapter_http_errors_redact_and_respect_retry_after() {
        for (status, reason, expected) in [
            (
                "403 Forbidden",
                "rateLimitExceeded",
                "DRIVE:rate_limited:120",
            ),
            ("429 Too Many Requests", "", "DRIVE:rate_limited:120"),
            (
                "403 Forbidden",
                "storageQuotaExceeded",
                "DRIVE:storage_full",
            ),
            ("403 Forbidden", "forbidden", "DRIVE:permission_denied"),
            ("404 Not Found", "", "DRIVE:remote_unavailable"),
            ("409 Conflict", "", "DRIVE:id_collision"),
            ("503 Service Unavailable", "", "DRIVE:service_unavailable"),
        ] {
            let body=json!({"error":{"message":"SECRET content should not leak","errors":[{"reason":reason}]}}).to_string();
            let (url, t) = stub(status, &body);
            let mut d = Drive {
                client: http().unwrap(),
                token: "test-token".into(),
                meter: Meter::default(),
                api: url.clone(),
                upload: url,
                pause_signal: None,
                #[cfg(test)]
                refresh: None,
            };
            assert_eq!(d.metadata("test-id").unwrap_err(), expected);
            t.join().unwrap();
            assert_eq!(d.meter.requests, 1);
        }
    }
    #[test]
    fn adapter_bounded_json_and_integrity_download() {
        let (url, t) = stub("200 OK", "{\"id\":\"test-id\",\"trashed\":false}");
        let mut d = Drive {
            client: http().unwrap(),
            token: "test-token".into(),
            meter: Meter::default(),
            api: url.clone(),
            upload: url,
            pause_signal: None,
            #[cfg(test)]
            refresh: None,
        };
        assert_eq!(d.metadata("test-id").unwrap()["id"], "test-id");
        t.join().unwrap();
        let (url, t) = stub("200 OK", "wrong bytes");
        d.api = url;
        assert_eq!(
            d.download("test-id", &"00".repeat(32), 1024).unwrap_err(),
            "DRIVE:integrity"
        );
        t.join().unwrap();
    }
}

fn resume_offset(headers: &reqwest::header::HeaderMap, size: u64, required: bool) -> Res<u64> {
    let Some(value) = headers.get("Range") else {
        return if required {
            Err("DRIVE:invalid_upload_offset".into())
        } else {
            Ok(0)
        };
    };
    let offset = value
        .to_str()
        .ok()
        .and_then(|s| s.strip_prefix("bytes=0-"))
        .and_then(|s| s.parse::<u64>().ok())
        .and_then(|n| n.checked_add(1))
        .filter(|n| *n <= size)
        .ok_or("DRIVE:invalid_upload_offset")?;
    Ok(offset)
}

impl Drive {
    fn valid_session(&self, session: &str) -> Res<()> {
        let url = reqwest::Url::parse(session).map_err(|_| "DRIVE:invalid_upload_session")?;
        if url.scheme() == "https"
            && url.host_str() == Some("www.googleapis.com")
            && url.username().is_empty()
            && url.password().is_none()
        {
            return Ok(());
        }
        #[cfg(test)]
        {
            let api = reqwest::Url::parse(&self.api).map_err(|_| "DRIVE:invalid_upload_session")?;
            if url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.origin() == api.origin()
            {
                return Ok(());
            }
        }
        Err("DRIVE:invalid_upload_session".into())
    }
    fn verify_stream(&mut self, id: &str, digest: &str, size: u64) -> Res<()> {
        use sha2::{Digest, Sha256};
        let u = format!("{}/files/{id}", self.api);
        let r = self.send("files.verify_stream", |c| {
            c.get(&u).query(&[("alt", "media")])
        })?;
        let mut reader = r.take(size + 1);
        let mut h = Sha256::new();
        let mut n = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let count = reader.read(&mut chunk).map_err(|_| "DRIVE:network")?;
            if count == 0 {
                break;
            }
            n += count as u64;
            h.update(&chunk[..count]);
        }
        self.meter.downloaded_bytes += n;
        if n != size || format!("{:x}", h.finalize()) != digest {
            return Err("DRIVE:integrity".into());
        }
        Ok(())
    }
    /// Bounded-memory resumable upload, with durable session and ID. The source remains immutable in app-data.
    pub fn put_file(
        &mut self,
        parent: &str,
        vault: &str,
        digest: &str,
        source: &std::path::Path,
        receipt: &std::path::Path,
    ) -> Res<()> {
        use sha2::{Digest, Sha256};
        use std::io::{Seek, SeekFrom};
        if !valid_hash(digest) {
            return Err("DRIVE:invalid_hash".into());
        }
        check_id(parent)?;
        let mut file = std::fs::File::open(source).map_err(|_| "DRIVE:source_unavailable")?;
        let size = file
            .metadata()
            .map_err(|_| "DRIVE:source_unavailable")?
            .len();
        let mut h = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = file
                .read(&mut buffer)
                .map_err(|_| "DRIVE:source_unavailable")?;
            if n == 0 {
                break;
            }
            h.update(&buffer[..n]);
        }
        if format!("{:x}", h.finalize()) != digest {
            return Err("DRIVE:integrity".into());
        }
        let mut state: Value = match std::fs::read(receipt) {
            Ok(b) => serde_json::from_slice(&b).map_err(|_| "DRIVE:upload_receipt_corrupt")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let v =
                    json!({"id":self.generate_id()?,"digest":digest,"size":size,"session":null});
                crate::vault::write_atomic(receipt, &bytes(&v)?)?;
                v
            }
            Err(_) => return Err("DRIVE:upload_receipt_unreadable".into()),
        };
        if state["digest"] != digest || state["size"] != size {
            return Err("DRIVE:upload_receipt_mismatch".into());
        }
        let id = state["id"]
            .as_str()
            .ok_or("DRIVE:upload_receipt_corrupt")?
            .to_string();
        // Small immutable objects need no resumable session round trips. Keep the
        // reserved ID durable before calling put, including an unknown POST result.
        // An existing resumable receipt always follows the original recovery path.
        if size <= 4 * 1024 * 1024 && state["session"].is_null() {
            let data = std::fs::read(source).map_err(|_| "DRIVE:source_unavailable")?;
            if data.len() as u64 != size || hash(&data) != digest {
                return Err("DRIVE:integrity".into());
            }
            self.put(&id, parent, "object", vault, digest, &data)?;
            std::fs::remove_file(receipt).map_err(err)?;
            return Ok(());
        }
        match self.metadata(&id) {
            Ok(m) => {
                verify(&m, parent, "object", vault, digest, digest)?;
                self.verify_stream(&id, digest, size)?;
                std::fs::remove_file(receipt).map_err(err)?;
                return Ok(());
            }
            Err(e) if e == "DRIVE:remote_unavailable" => (),
            Err(e) => return Err(e),
        }
        let fresh_session = state["session"].is_null();
        if fresh_session {
            let u = format!("{}/files?uploadType=resumable", self.upload);
            let meta = json!({"id":id,"name":digest,"parents":[parent],"appProperties":{"nevisProtocol":"1","nevisKind":"object","nevisVault":vault,"nevisKey":digest,"sha256":digest}});
            let r = self.send("upload.start", |c| {
                c.post(&u)
                    .header("X-Upload-Content-Type", "application/octet-stream")
                    .header("X-Upload-Content-Length", size)
                    .json(&meta)
            })?;
            state["session"] = json!(r
                .headers()
                .get("Location")
                .and_then(|s| s.to_str().ok())
                .ok_or("DRIVE:invalid_upload_session")?);
            crate::vault::write_atomic(receipt, &bytes(&state)?)?;
        }
        let session = state["session"]
            .as_str()
            .ok_or("DRIVE:upload_receipt_corrupt")?
            .to_string();
        self.valid_session(&session)?;
        // A session created in this call is empty. Only recovered sessions need
        // a status probe; after a crash they still resume from Google's offset.
        let mut offset = if fresh_session {
            0
        } else {
            let probe = self.send("upload.probe", |c| {
                c.put(&session)
                    .header("Content-Length", 0)
                    .header("Content-Range", format!("bytes */{size}"))
            });
            match probe {
                Ok(r) if r.status().as_u16() == 308 => resume_offset(r.headers(), size, false)?,
                Ok(_) => {
                    let meta = self.metadata(&id)?;
                    verify(&meta, parent, "object", vault, digest, digest)?;
                    self.verify_stream(&id, digest, size)?;
                    std::fs::remove_file(receipt).map_err(err)?;
                    return Ok(());
                }
                Err(e) if e == "DRIVE:remote_unavailable" => {
                    state["session"] = Value::Null;
                    crate::vault::write_atomic(receipt, &bytes(&state)?)?;
                    return Err("DRIVE:upload_session_expired".into());
                }
                Err(e) => return Err(e),
            }
        };
        if offset > size {
            return Err("DRIVE:invalid_upload_offset".into());
        }
        while offset < size {
            file.seek(SeekFrom::Start(offset))
                .map_err(|_| "DRIVE:source_unavailable")?;
            let count = (size - offset).min(8 * 1024 * 1024) as usize;
            let mut chunk = vec![0u8; count];
            file.read_exact(&mut chunk)
                .map_err(|_| "DRIVE:source_unavailable")?;
            let end = offset + count as u64 - 1;
            let r = self.send("upload.chunk", |c| {
                c.put(&session)
                    .header("Content-Type", "application/octet-stream")
                    .header("Content-Range", format!("bytes {offset}-{end}/{size}"))
                    .body(chunk.clone())
            })?;
            self.meter.uploaded_bytes += count as u64;
            if r.status().as_u16() == 308 {
                let accepted = resume_offset(r.headers(), size, true)?;
                if accepted <= offset || accepted > end + 1 {
                    return Err("DRIVE:invalid_upload_offset".into());
                }
                offset = accepted;
            } else {
                offset = size;
            }
        }
        self.verify_stream(&id, digest, size)?;
        let m = self.metadata(&id)?;
        verify(&m, parent, "object", vault, digest, digest)?;
        std::fs::remove_file(receipt).map_err(err)?;
        Ok(())
    }
    pub fn object_with_state(
        &mut self,
        parent: &str,
        vault: &str,
        digest: &str,
        data: Option<&[u8]>,
        state: &std::path::Path,
    ) -> Res<Vec<u8>> {
        if data.is_none_or(|d| d.len() <= 4 * 1024 * 1024) {
            return self.object(parent, vault, digest, data);
        }
        let q=format!("trashed = false and '{parent}' in parents and appProperties has {{ key='nevisKey' and value='{digest}' }}");
        let rows = self.list(&q)?;
        if let Some(m) = rows.first() {
            verify(m, parent, "object", vault, digest, digest)?;
            return self.download(
                m["id"].as_str().ok_or("DRIVE:invalid_response")?,
                digest,
                super::super::snapshot::MAX_FILE,
            );
        }
        let data = data.unwrap();
        let source = state.join("objects").join(digest);
        crate::vault::write_atomic(&source, data)?;
        self.put_file(
            parent,
            vault,
            digest,
            &source,
            &state.join(format!("upload-{digest}.json")),
        )?;
        Ok(data.to_vec())
    }
}

#[cfg(test)]
mod resumable_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    #[test]
    fn upload_ranges_reject_overflow_malformed_and_out_of_bounds() {
        for range in [
            "bytes=0-18446744073709551615",
            "bytes=1-3",
            "bytes=0-100",
            "wrong",
        ] {
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("Range", range.parse().unwrap());
            assert_eq!(
                resume_offset(&h, 16, false).unwrap_err(),
                "DRIVE:invalid_upload_offset"
            );
        }
        assert_eq!(
            resume_offset(&reqwest::header::HeaderMap::new(), 16, false).unwrap(),
            0
        );
        assert!(resume_offset(&reqwest::header::HeaderMap::new(), 16, true).is_err());
    }
    #[test]
    fn resumable_308_unknown_response_restart_sends_only_unacknowledged_bytes() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", socket.local_addr().unwrap());
        let data = b"0123456789abcdef";
        let digest = hash(data);
        let h = digest.clone();
        let server = std::thread::spawn(move || {
            for i in 0..8 {
                let (mut stream, _) = socket.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let header_end = loop {
                    let mut b = [0; 4096];
                    let n = stream.read(&mut b).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&b[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let header = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
                assert!(header.contains("bearer test-token"));
                let len = header
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                while request.len() < header_end + len {
                    let mut b = [0; 4096];
                    let n = stream.read(&mut b).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&b[..n]);
                }
                let (status,extra,body):( &str,&str,Vec<u8>)=match i{
                    0|3=>("404 Not Found","",vec![]),
                    1=>{assert!(header.contains("content-range: bytes */16"));("308 Resume Incomplete","Range: bytes=0-3\r\n",vec![])},
                    2=>{assert!(header.contains("content-range: bytes 4-15/16"));assert_eq!(&request[header_end..],&data[4..]);("503 Service Unavailable","",vec![])},
                    4=>{assert!(header.contains("content-range: bytes */16"));("308 Resume Incomplete","Range: bytes=0-7\r\n",vec![])},
                    5=>{assert!(header.contains("content-range: bytes 8-15/16"));assert_eq!(&request[header_end..],&data[8..]);("200 OK","",vec![])},
                    6=>("200 OK","",data.to_vec()),
                    _=>("200 OK","",bytes(&json!({"id":"reserved","parents":["parent"],"trashed":false,"appProperties":{"nevisProtocol":"1","nevisKind":"object","nevisVault":"vault","nevisKey":h,"sha256":h}})).unwrap()),
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        let root = std::env::temp_dir().join(format!("nevis-upload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        let receipt = root.join("receipt.json");
        std::fs::write(&source, data).unwrap();
        crate::vault::write_atomic(&receipt,&bytes(&json!({"id":"reserved","digest":digest,"size":16,"session":format!("{url}/session")})).unwrap()).unwrap();
        let mut d = Drive {
            client: http().unwrap(),
            token: "test-token".into(),
            meter: Meter::default(),
            api: url.clone(),
            upload: url,
            pause_signal: None,
            #[cfg(test)]
            refresh: None,
        };
        assert_eq!(
            d.put_file("parent", "vault", &digest, &source, &receipt)
                .unwrap_err(),
            "DRIVE:service_unavailable"
        );
        assert!(receipt.exists());
        d.put_file("parent", "vault", &digest, &source, &receipt)
            .unwrap();
        assert!(!receipt.exists());
        server.join().unwrap();
        assert_eq!(d.meter.uploaded_bytes, 8);
        std::fs::remove_dir_all(root).unwrap();
    }
}

impl Drive {
    pub fn object_file(
        &mut self,
        parent: &str,
        vault: &str,
        digest: &str,
        target: &std::path::Path,
        local: bool,
        state: &std::path::Path,
    ) -> Res<()> {
        if !valid_hash(digest) {
            return Err("DRIVE:invalid_hash".into());
        }
        check_id(parent)?;
        let rows=self.list(&format!("trashed = false and '{parent}' in parents and appProperties has {{ key='nevisKey' and value='{digest}' }}"))?;
        if rows.is_empty() {
            if !local {
                return Err("DRIVE:missing_dependency".into());
            }
            return self.put_file(
                parent,
                vault,
                digest,
                target,
                &state.join(format!("upload-{digest}.json")),
            );
        }
        let metadata = &rows[0];
        verify(metadata, parent, "object", vault, digest, digest)?;
        let id = metadata["id"].as_str().ok_or("DRIVE:invalid_metadata")?;
        let size = metadata["size"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| *n <= 5 * 1024 * 1024 * 1024)
            .ok_or("DRIVE:media_size_limit")?;
        if target.exists() {
            if super::streaming::file_hash(target)? != digest {
                return Err("DRIVE:integrity".into());
            }
            return self.verify_stream(id, digest, size);
        }
        use sha2::{Digest, Sha256};
        use std::io::Write;
        let parent_path = target.parent().ok_or("DRIVE:invalid_path")?;
        std::fs::create_dir_all(parent_path).map_err(err)?;
        let temp = parent_path.join(format!(".drive-download-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let u = format!("{}/files/{id}", self.api);
            let response = self.send("files.stream", |c| c.get(&u).query(&[("alt", "media")]))?;
            if response.content_length().is_some_and(|n| n != size) {
                return Err("DRIVE:integrity".into());
            }
            let mut input = response.take(size + 1);
            let mut output = std::fs::File::create(&temp).map_err(err)?;
            let mut h = Sha256::new();
            let mut count = 0u64;
            let mut buf = [0; 64 * 1024];
            loop {
                self.check_pause()?;
                let n = input.read(&mut buf).map_err(|_| "DRIVE:network")?;
                if n == 0 {
                    break;
                }
                count += n as u64;
                output.write_all(&buf[..n]).map_err(err)?;
                h.update(&buf[..n]);
            }
            self.meter.downloaded_bytes += count;
            if count != size || format!("{:x}", h.finalize()) != digest {
                return Err("DRIVE:integrity".into());
            }
            output.sync_all().map_err(err)?;
            drop(output);
            std::fs::rename(&temp, target).map_err(err)?;
            #[cfg(unix)]
            std::fs::File::open(parent_path)
                .and_then(|f| f.sync_all())
                .map_err(err)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    }
}

#[cfg(test)]
mod pause_tests {
    use super::*;
    #[test]
    fn pause_signal_stops_before_the_next_request() {
        let root = std::env::temp_dir().join(format!("nevis-pause-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let signal = root.join("pause");
        std::fs::write(&signal, b"1").unwrap();
        let mut drive = Drive {
            client: http().unwrap(),
            token: "test-token".into(),
            meter: Meter::default(),
            api: "http://127.0.0.1:9".into(),
            upload: "http://127.0.0.1:9".into(),
            pause_signal: Some(signal),
            #[cfg(test)]
            refresh: None,
        };
        assert_eq!(drive.metadata("id").unwrap_err(), "DRIVE:paused");
        assert_eq!(drive.meter.requests, 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod multipart_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    #[test]
    fn marker_lost_response_reconciles_reserved_id_without_second_create() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", socket.local_addr().unwrap());
        let payload = b"immutable marker";
        let digest = hash(payload);
        let h = digest.clone();
        let server = std::thread::spawn(move || {
            for i in 0..3 {
                let (mut stream, _) = socket.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let end = loop {
                    let mut buf = [0; 4096];
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buf[..n]);
                    if let Some(n) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        break n + 4;
                    }
                };
                let header = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                assert!(header.contains("bearer test-token"));
                let len = header
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                while request.len() < end + len {
                    let mut buf = [0; 4096];
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buf[..n]);
                }
                let (status, body) = match i {
                    0 => {
                        assert!(header.starts_with("post /files?uploadtype=multipart"));
                        assert!(header.contains("multipart/related; boundary=nevis-"));
                        let body = String::from_utf8_lossy(&request[end..]);
                        assert!(body.contains("\"id\":\"reserved\""));
                        assert!(body.contains("immutable marker"));
                        ("503 Service Unavailable", vec![])
                    }
                    1 => {
                        assert!(header.starts_with("get /files/reserved"));
                        ("200 OK",bytes(&json!({"id":"reserved","parents":["parent"],"trashed":false,"appProperties":{"nevisProtocol":"1","nevisKind":"batch","nevisVault":"vault","nevisKey":"key","sha256":h}})).unwrap())
                    }
                    _ => {
                        assert!(header.starts_with("get /files/reserved"));
                        assert!(header.contains("alt=media"));
                        ("200 OK", payload.to_vec())
                    }
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        let mut drive = Drive {
            client: http().unwrap(),
            token: "test-token".into(),
            meter: Meter::default(),
            api: url.clone(),
            upload: url,
            pause_signal: None,
            #[cfg(test)]
            refresh: None,
        };
        // The response was lost but the create landed: the same call finds the reserved ID and
        // confirms its bytes, so there is no second create and no failed attempt left for the next run.
        drive
            .put("reserved", "parent", "batch", "vault", "key", payload)
            .unwrap();
        server.join().unwrap();
        assert_eq!(drive.meter.operations["upload.marker"], 1);
        assert_eq!(drive.meter.requests, 3);
    }
}

#[cfg(test)]
mod refresh_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static REFRESHES: AtomicUsize = AtomicUsize::new(0);
    fn refreshed() -> Res<String> {
        REFRESHES.fetch_add(1, Ordering::SeqCst);
        Ok("refreshed-token".into())
    }
    fn revoked() -> Res<String> {
        REFRESHES.fetch_add(1, Ordering::SeqCst);
        Err("DRIVE:sign_in_required".into())
    }
    #[test]
    fn repeated_401_and_revoked_refresh_are_bounded_and_redacted() {
        for succeeds in [true, false] {
            REFRESHES.store(0, Ordering::SeqCst);
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                for index in 0..if succeeds { 2 } else { 1 } {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut request = vec![];
                    loop {
                        let mut buf = [0; 4096];
                        let n = stream.read(&mut buf).unwrap();
                        assert!(n > 0);
                        request.extend_from_slice(&buf[..n]);
                        if request.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let header = String::from_utf8_lossy(&request);
                    assert!(header.contains(if index == 0 {
                        "Bearer original-token"
                    } else {
                        "Bearer refreshed-token"
                    }));
                    let body = r#"{"error":{"message":"private body must never be returned"}}"#;
                    write!(stream,"HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
            });
            let mut d = Drive {
                client: http().unwrap(),
                token: "original-token".into(),
                meter: Meter::default(),
                api: url.clone(),
                upload: url,
                pause_signal: None,
                refresh: Some(if succeeds { refreshed } else { revoked }),
            };
            assert_eq!(d.metadata("file").unwrap_err(), "DRIVE:sign_in_required");
            assert_eq!(REFRESHES.load(Ordering::SeqCst), 1);
            assert_eq!(d.meter.requests, if succeeds { 2 } else { 1 });
            server.join().unwrap();
        }
    }
}

#[cfg(test)]
mod upload_latency_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    fn request(stream: &mut std::net::TcpStream) -> (String, Vec<u8>) {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut raw = vec![];
        let end = loop {
            let mut buf = [0; 8192];
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0);
            raw.extend_from_slice(&buf[..n]);
            if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let header = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
        let size = header
            .lines()
            .find_map(|l| l.strip_prefix("content-length: "))
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        while raw.len() < end + size {
            let mut buf = [0; 8192];
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0);
            raw.extend_from_slice(&buf[..n]);
        }
        (header, raw[end..].to_vec())
    }
    fn metadata(digest: &str) -> Vec<u8> {
        bytes(&json!({"id":"reserved","parents":["parent"],"trashed":false,"appProperties":{"nevisProtocol":"1","nevisKind":"object","nevisVault":"vault","nevisKey":digest,"sha256":digest}})).unwrap()
    }
    /// What Drive answers to a multipart create: the stored metadata, size and MD5 of the bytes.
    fn created(digest: &str, data: &[u8]) -> Vec<u8> {
        bytes(&json!({"id":"reserved","parents":["parent"],"trashed":false,"size":data.len().to_string(),"md5Checksum":md5_hex(data),"appProperties":{"nevisProtocol":"1","nevisKind":"object","nevisVault":"vault","nevisKey":digest,"sha256":digest}})).unwrap()
    }
    fn drive(url: String) -> Drive {
        Drive {
            client: http().unwrap(),
            token: "test-token".into(),
            meter: Meter::default(),
            api: url.clone(),
            upload: url,
            pause_signal: None,
            refresh: None,
        }
    }
    #[test]
    fn small_file_multipart_preserves_receipt_and_reserved_id_after_unknown_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let data = b"small immutable object";
        let digest = hash(data);
        let h = digest.clone();
        let server = std::thread::spawn(move || {
            for i in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let (header, body) = request(&mut stream);
                let (status, response) = match i {
                    0 => {
                        assert!(header.starts_with("post /files?uploadtype=multipart"));
                        assert!(String::from_utf8_lossy(&body).contains("small immutable object"));
                        ("503 Service Unavailable", vec![])
                    }
                    // Nothing landed: the reserved ID does not exist yet.
                    1 => {
                        assert!(header.starts_with("get /files/reserved"));
                        ("404 Not Found", vec![])
                    }
                    // The retry's create answers with the stored metadata and Drive's own checksum.
                    _ => {
                        assert!(header.starts_with("post /files?uploadtype=multipart"));
                        ("200 OK", created(&h, data))
                    }
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                stream.write_all(&response).unwrap();
            }
        });
        let root =
            std::env::temp_dir().join(format!("nevis-small-upload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        let receipt = root.join("receipt");
        std::fs::write(&source, data).unwrap();
        crate::vault::write_atomic(
            &receipt,
            &bytes(&json!({"id":"reserved","digest":digest,"size":data.len(),"session":null}))
                .unwrap(),
        )
        .unwrap();
        let mut d = drive(url);
        assert_eq!(
            d.put_file("parent", "vault", &digest, &source, &receipt)
                .unwrap_err(),
            "DRIVE:service_unavailable"
        );
        assert!(receipt.is_file());
        d.put_file("parent", "vault", &digest, &source, &receipt)
            .unwrap();
        assert!(!receipt.exists());
        assert_eq!(d.meter.operations.get("upload.marker"), Some(&2));
        assert_eq!(d.meter.requests, 3);
        assert!(!d.meter.operations.contains_key("upload.start"));
        assert!(!d.meter.operations.contains_key("upload.probe"));
        server.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    fn serve(script: Vec<(&'static str, &'static str, Vec<u8>)>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (expected, status, response) in script {
                let (mut stream, _) = listener.accept().unwrap();
                let (header, _) = request(&mut stream);
                assert!(header.starts_with(expected), "{header}");
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                stream.write_all(&response).unwrap();
            }
        });
        (url, server)
    }
    #[test]
    fn fresh_marker_create_is_one_request_verified_by_drives_checksum() {
        let data = b"fresh marker";
        let digest = hash(data);
        let (url, server) = serve(vec![("post /files?uploadtype=multipart", "200 OK", created(&digest, data))]);
        let mut d = drive(url);
        d.put("reserved", "parent", "object", "vault", &digest, data).unwrap();
        server.join().unwrap();
        assert_eq!(d.meter.requests, 1);
        assert_eq!(d.meter.uploaded_bytes, data.len() as u64);
    }
    #[test]
    fn checksum_mismatch_falls_back_to_reading_back_and_rejects_different_bytes() {
        let data = b"fresh marker";
        let digest = hash(data);
        let mut wrong = serde_json::from_slice::<Value>(&created(&digest, data)).unwrap();
        wrong["md5Checksum"] = json!("00000000000000000000000000000000");
        let (url, server) = serve(vec![
            ("post /files?uploadtype=multipart", "200 OK", bytes(&wrong).unwrap()),
            ("get /files/reserved", "200 OK", metadata(&digest)),
            ("get /files/reserved", "200 OK", b"other bytes!".to_vec()),
        ]);
        let mut d = drive(url);
        assert_eq!(
            d.put("reserved", "parent", "object", "vault", &digest, data).unwrap_err(),
            "DRIVE:integrity"
        );
        server.join().unwrap();
        assert_eq!(d.meter.requests, 3);
    }
    #[test]
    fn existing_reserved_id_after_a_conflict_is_confirmed_not_recreated() {
        let data = b"fresh marker";
        let digest = hash(data);
        let (url, server) = serve(vec![
            ("post /files?uploadtype=multipart", "409 Conflict", vec![]),
            ("get /files/reserved", "200 OK", metadata(&digest)),
            ("get /files/reserved", "200 OK", data.to_vec()),
        ]);
        let mut d = drive(url);
        d.put("reserved", "parent", "object", "vault", &digest, data).unwrap();
        server.join().unwrap();
        assert_eq!(d.meter.operations["upload.marker"], 1);
    }
    #[test]
    fn several_ids_are_reserved_in_one_request() {
        let ids: Vec<String> = (0..3).map(|n| format!("id{n}")).collect();
        let (url, server) = serve(vec![("get /files/generateids?count=3", "200 OK", bytes(&json!({"ids":ids})).unwrap())]);
        let mut d = drive(url);
        assert_eq!(d.generate_ids(3).unwrap(), ids);
        server.join().unwrap();
        assert_eq!(d.meter.requests, 1);
    }
    #[test]
    fn parallel_map_keeps_input_order_merges_meters_and_reports_the_first_failure() {
        let mut d = drive("http://127.0.0.1:9".into());
        let doubled = parallel_map(&mut d, (0..20u64).collect(), |worker, n| {
            worker.meter.requests += 1;
            std::thread::sleep(Duration::from_millis(5 * (n % 3)));
            Ok(n * 2)
        })
        .unwrap();
        assert_eq!(doubled, (0..20u64).map(|n| n * 2).collect::<Vec<_>>());
        assert_eq!(d.meter.requests, 20);
        let failed: Res<Vec<u64>> = parallel_map(&mut d, (0..20u64).collect(), |_, n| {
            if n == 7 { Err("DRIVE:integrity".into()) } else { Ok(n) }
        });
        assert_eq!(failed.unwrap_err(), "DRIVE:integrity");
    }
    #[test]
    fn fresh_large_session_sends_bytes_without_status_probe_and_still_verifies_them() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let base = url.clone();
        let data = vec![b'x'; 4 * 1024 * 1024 + 1];
        let digest = hash(&data);
        let h = digest.clone();
        let payload = data.clone();
        let server = std::thread::spawn(move || {
            for i in 0..5 {
                let (mut stream, _) = listener.accept().unwrap();
                let (header, body) = request(&mut stream);
                let (status, extra, response) = match i {
                    0 => ("404 Not Found", String::new(), vec![]),
                    1 => {
                        assert!(header.contains("uploadtype=resumable"));
                        ("200 OK", format!("Location: {base}/session\r\n"), vec![])
                    }
                    2 => {
                        assert!(header.starts_with("put /session"));
                        assert!(header.contains(&format!(
                            "content-range: bytes 0-{}/{}",
                            payload.len() - 1,
                            payload.len()
                        )));
                        assert_eq!(body, payload);
                        ("200 OK", String::new(), vec![])
                    }
                    3 => {
                        assert!(header.contains("alt=media"));
                        ("200 OK", String::new(), payload.clone())
                    }
                    _ => ("200 OK", String::new(), metadata(&h)),
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                stream.write_all(&response).unwrap();
            }
        });
        let root =
            std::env::temp_dir().join(format!("nevis-fresh-upload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        let receipt = root.join("receipt");
        std::fs::write(&source, &data).unwrap();
        crate::vault::write_atomic(
            &receipt,
            &bytes(&json!({"id":"reserved","digest":digest,"size":data.len(),"session":null}))
                .unwrap(),
        )
        .unwrap();
        let mut d = drive(url);
        d.put_file("parent", "vault", &digest, &source, &receipt)
            .unwrap();
        assert_eq!(d.meter.requests, 5);
        assert_eq!(d.meter.uploaded_bytes, data.len() as u64);
        assert_eq!(d.meter.downloaded_bytes, data.len() as u64);
        assert!(!d.meter.operations.contains_key("upload.probe"));
        assert!(!receipt.exists());
        server.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
