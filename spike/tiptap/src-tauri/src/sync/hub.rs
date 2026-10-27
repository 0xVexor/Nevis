//! The Nevis sync server (`server/` in this repository) as a `Remote` for the sync engine in `mod.rs`.
//!
//! The server numbers every change of a vault (`seq`), and every path carries the number of its last change (`rev`).
//! This file turns that into what the engine expects:
//! - `list()` is answered from a local mirror (`Cache`) that is brought up to date with one small request
//!   (`/changes?since=`), so a sync costs what changed, not what exists;
//! - a write names the rev it is based on and the server refuses it if the path moved on (so two devices never
//!   overwrite each other silently); the contents are sent first as a blob named by its hash, so a connection that
//!   dies halfway leaves nothing half-written;
//! - every request is safe to repeat (blobs are named by hash, commits carry an operation id), which is what makes
//!   retries on a bad network harmless.
//!
//! A `RemoteFile` id is `"<rev>:<path>"`: the engine keeps it as an opaque string, and we get back both parts.

use super::{PendingUpload, Remote, RemoteFile, CLOUD_GONE};
use crate::vault::{err, now_ms, Res};
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Duration;
use std::path::Path;
use std::io::{Read, Seek, SeekFrom, Write};

/// Errors that mean "the network is not there right now", as opposed to "the server said no".
pub const NETWORK: &str = "NETWORK:";
/// The token of this device is not accepted (signed out from another device, or the account changed).
pub const AUTH: &str = "AUTH:";

pub fn is_network(m: &str) -> bool {
    m.contains(NETWORK)
}

pub fn is_auth(m: &str) -> bool {
    m.contains(AUTH)
}

const API_VERSION: &str = "2";
/// Contents up to this size travel in one request; bigger ones in pieces that can be resumed.
const SINGLE: usize = 2 << 20;
const PIECE: usize = 1 << 20;

// ───── HTTP ─────

#[derive(Clone)]
pub struct Api {
    http: Client,
    base: String,
    token: Option<String>,
    attempts: u32,
    session: Option<u64>,
}

impl Api {
    pub fn new(base: &str, token: Option<String>) -> Res<Api> {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(10)) // a connection that does not open in 10 s is a dead one
            .timeout(Duration::from_secs(60))
            .tcp_keepalive(Duration::from_secs(30))
            .user_agent(concat!("Nevis/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(err)?;
        let session = token.as_ref().map(|_| super::account::generation());
        Ok(Api { http, base: base.trim_end_matches('/').to_string(), token, attempts: 4, session })
    }

    /// One attempt per request: for checks that run in the background and must not hold anything up when the network is bad.
    pub fn quick(mut self) -> Api {
        self.attempts = 1;
        self
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// Sends the request and returns whatever the server answered. Lost connections and busy servers (429, 502-504) are retried.
    pub fn send_any(&self, build: impl Fn(&Client) -> RequestBuilder) -> Res<Response> {
        for attempt in 0..self.attempts {
            self.check_session()?;
            let mut rb = build(&self.http).header("x-noviq-api", API_VERSION);
            if self.attempts == 1 { rb = rb.timeout(Duration::from_secs(30)); }
            if let Some(t) = &self.token {
                rb = rb.bearer_auth(t);
            }
            let last = attempt + 1 == self.attempts;
            match rb.send() {
                Ok(r) => {
                    self.check_session()?;
                    if matches!(r.status().as_u16(), 429 | 502 | 503 | 504) && !last {
                        let wait = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).map_or(500u64 << attempt, |s| s.min(8) * 1000);
                        std::thread::sleep(Duration::from_millis(wait));
                        continue;
                    }
                    return Ok(r);
                }
                Err(e) if last => return Err(format!("{NETWORK}{}", e.without_url())),
                Err(_) => std::thread::sleep(Duration::from_millis(400u64 << attempt)),
            }
        }
        Err(format!("{NETWORK}no attempt was made"))
    }

    fn check_session(&self) -> Res<()> {
        if self.session.is_some_and(|n| n != super::account::generation()) { return Err("AUTH:session_changed".into()); }
        Ok(())
    }

    /// Like `send_any`, but anything but 2xx is an error (see `status_error`).
    pub fn send(&self, build: impl Fn(&Client) -> RequestBuilder) -> Res<Response> {
        let r = self.send_any(build)?;
        if r.status().is_success() {
            Ok(r)
        } else {
            Err(status_error(r, self.token.is_some()))
        }
    }

    pub fn get(&self, path: &str) -> Res<Value> {
        let url = self.url(path);
        self.send(|c| c.get(&url))?.json().map_err(|e| format!("{NETWORK}{e}"))
    }

    pub fn post(&self, path: &str, body: &Value) -> Res<Value> {
        let url = self.url(path);
        self.send(|c| c.post(&url).json(body))?.json().map_err(|e| format!("{NETWORK}{e}"))
    }
}

/// `HUB:<code>` for what the server said (its own error codes), `AUTH:unauthorized` when the token of this device is not accepted.
/// `authed`: the request carried a token. A 401 to a request without one (sign-in, sign-up) is not "you are signed out":
/// it is a wrong password, or an address that is not a Nevis server at all.
pub fn status_error(r: Response, authed: bool) -> String {
    let code = r.status().as_u16();
    let endpoint = format!("{}{}", r.url().origin().ascii_serialization(), r.url().path());
    let body: Value = r.json().unwrap_or(Value::Null);
    let name = body.get("error").and_then(Value::as_str).unwrap_or("");
    if code == 401 && authed {
        return format!("{AUTH}unauthorized\nhttp={code}\nendpoint={endpoint}");
    }
    // only the server's own codes (lower case, underscores) are passed on; any other text is another program talking
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
        format!("HUB:http_{code}\nhttp={code}\nendpoint={endpoint}")
    } else {
        format!("HUB:{name}\nhttp={code}\nendpoint={endpoint}")
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut n = 0;
    for b in bytes {
        if *b == 0 {
            n += 8;
        } else {
            return n + b.leading_zeros();
        }
    }
    n
}

/// The small job the server asks of a new account (and of a recovery) so that a bot cannot make thousands: a few hundred
/// milliseconds for a person's computer.
pub fn solve_pow(challenge: &str, bits: u32) -> u64 {
    let mut counter = 0u64;
    loop {
        if leading_zero_bits(&Sha256::digest(format!("{challenge}:{counter}").as_bytes())) >= bits {
            return counter;
        }
        counter += 1;
    }
}

// ───── the mirror of the server's file list ─────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HubFile {
    pub rev: i64,
    pub md5: String,
    #[serde(default)]
    pub sha: String,
    #[serde(default)]
    pub size: u64,
    /// server time of the change
    #[serde(default)]
    pub time: i64,
}

/// What this device knows about the server's copy of one vault. Kept in the sync state of the vault.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Cache {
    /// the generation of the server's data; another one means the server lost data and was restored from a backup
    #[serde(default)]
    pub epoch: String,
    /// every change up to this number has been applied to `files`
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub files: BTreeMap<String, HubFile>,
}

/// Same hash as the server's `rootHash`: equal on both sides means both hold exactly the same files.
pub fn root_of(files: &BTreeMap<String, HubFile>) -> String {
    let mut h = Sha256::new();
    for (p, f) in files {
        h.update(format!("{p}\0{}\n", f.md5).as_bytes());
    }
    hex(&h.finalize())
}

fn file_of(v: &Value) -> Option<(String, HubFile)> {
    Some((
        v.get("path")?.as_str()?.to_string(),
        HubFile {
            rev: v.get("rev")?.as_i64()?,
            md5: v.get("md5").and_then(Value::as_str).unwrap_or("").to_string(),
            sha: v.get("sha256").and_then(Value::as_str).unwrap_or("").to_string(),
            size: v.get("size").and_then(Value::as_u64).unwrap_or(0),
            time: v.get("server_time").and_then(Value::as_i64).unwrap_or(0),
        },
    ))
}

pub fn make_id(rev: i64, path: &str) -> String {
    format!("{rev}:{path}")
}

pub fn split_id(id: &str) -> Res<(i64, &str)> {
    let (rev, path) = id.split_once(':').ok_or_else(|| format!("bad file id {id}"))?;
    Ok((rev.parse().map_err(|_| format!("bad file id {id}"))?, path))
}

/// What `preflight` found out. Both mean "start from what is here, delete nothing": the bookkeeping of the engine
/// no longer says anything about this server.
#[derive(Debug, Default)]
pub struct Preflight {
    pub created: bool,
    pub baseline: bool,
}

pub struct Hub {
    api: Api,
    vault: String,
    pub cache: Cache,
    /// server clock minus our clock, so that "newer" between a server time and a local file time means something
    offset: i64,
    prepared: bool,
    confirm_bulk: bool,
}

impl Hub {
    pub fn new(api: Api, vault: &str, cache: Cache) -> Hub {
        Hub { api, vault: vault.to_string(), cache, offset: 0, prepared: false, confirm_bulk: false }
    }

    fn v(&self, tail: &str) -> String {
        format!("/v1/vaults/{}{tail}", self.vault)
    }

    /// Makes the mirror current: checks that the vault exists (creating it the first time), notices a server that lost
    /// data, pulls what changed, and checks the mirror against the server's own hash of its files.
    pub fn preflight(&mut self, name: &str) -> Res<Preflight> {
        let mut out = Preflight::default();
        let health = self.api.get("/v1/health")?;
        if health["api"].as_u64().unwrap_or(0) < 2 || !health["capabilities"].as_array().is_some_and(|caps| caps.iter().any(|v| v == "session_safe_writes")) {
            return Err("HUB:session_server_upgrade_required".into());
        }
        let state = match self.api.get(&self.v("/state")) {
            Ok(s) => s,
            Err(e) if e.lines().next() == Some("HUB:no_such_vault") => {
                if !self.cache.epoch.is_empty() {
                    return Err(CLOUD_GONE.into()); // it was there and is gone: the user decides, nothing is created or deleted
                }
                self.api.post("/v1/vaults", &json!({ "id": self.vault, "name": name }))?;
                out.created = true;
                self.api.get(&self.v("/state"))?
            }
            Err(e) => return Err(e),
        };
        let epoch = state["epoch"].as_str().unwrap_or("").to_string();
        if !self.cache.epoch.is_empty() && self.cache.epoch != epoch {
            self.cache = Cache::default();
            out.baseline = true;
        }
        if out.created {
            out.baseline = true;
        }
        self.cache.epoch = epoch;
        if self.pull()? {
            out.baseline = true;
        }
        // the mirror must be what the server has: a file missing from it would look like a deletion to the engine
        if state["seq"].as_i64() == Some(self.cache.seq) && state["root"].as_str().is_some_and(|r| r != root_of(&self.cache.files)) {
            let epoch = self.cache.epoch.clone();
            self.cache = Cache { epoch, ..Default::default() };
            self.pull()?;
            out.baseline = true;
            let fresh = self.api.get(&self.v("/state"))?;
            if fresh["seq"].as_i64() == Some(self.cache.seq) && fresh["root"].as_str().is_some_and(|r| r != root_of(&self.cache.files)) {
                return Err("HUB:inconsistent".into());
            }
        }
        self.prepared = true;
        Ok(out)
    }

    /// Build a verified live snapshot without mixing pages from different heads.
    fn snapshot(&mut self) -> Res<()> {
        for _ in 0..3 {
            let mut files = BTreeMap::new();
            let mut after = String::new();
            let mut epoch = String::new();
            let mut head = 0i64;
            loop {
                let url = self.api.url(&self.v("/snapshot"));
                let mut query = vec![("limit", "500".to_string())];
                if !after.is_empty() {
                    query.extend([("after", after.clone()), ("epoch", epoch.clone()), ("head", head.to_string())]);
                }
                let page: Value = match self.api.send(|c| c.get(&url).query(&query)).and_then(|r| r.json().map_err(err)) {
                    Ok(v) => v,
                    Err(e) if e.lines().next() == Some("HUB:snapshot_changed") => break,
                    Err(e) => return Err(e),
                };
                let current_epoch = page["epoch"].as_str().filter(|s| !s.is_empty()).ok_or("HUB:bad_answer")?;
                let current_head = page["head"].as_i64().filter(|n| *n >= 0).ok_or("HUB:bad_answer")?;
                if after.is_empty() { epoch = current_epoch.to_string(); head = current_head; }
                if epoch != current_epoch || head != current_head { break; }
                for f in page["files"].as_array().ok_or("HUB:bad_answer")? {
                    let (path, file) = file_of(f).ok_or("HUB:bad_answer")?;
                    if file.rev > head || f["deleted"].as_bool() != Some(false) || files.insert(path, file).is_some() {
                        return Err("HUB:bad_answer".into());
                    }
                }
                self.offset = page["server_time"].as_i64().unwrap_or_else(now_ms) - now_ms();
                if page["has_more"].as_bool() == Some(false) {
                    if page["root"].as_str() != Some(root_of(&files).as_str()) { return Err("HUB:inconsistent".into()); }
                    self.cache = Cache { epoch, seq: head, files };
                    return Ok(());
                }
                let next = page["after"].as_str().filter(|s| !s.is_empty()).ok_or("HUB:bad_answer")?;
                if next <= after.as_str() { return Err("HUB:bad_answer".into()); }
                after = next.to_string();
            }
        }
        Err("HUB:snapshot_changed".into())
    }

    /// Incremental reads are applied to a candidate mirror and published only
    /// after the complete response sequence has been validated.
    fn pull(&mut self) -> Res<bool> {
        if self.cache.seq == 0 {
            // Older servers can still serve uncompacted workspaces.
            let health = self.api.get("/v1/health")?;
            if health["capabilities"].as_array().is_some_and(|a| a.iter().any(|v| v == "full_snapshot")) {
                // seq can still be zero immediately after this device's first
                // uploads. Those acknowledged baselines remain valid: resetting
                // them here would resurrect a local deletion on the next round.
                let baseline = self.cache.files.is_empty();
                self.snapshot()?;
                return Ok(baseline);
            }
        }
        let mut candidate = self.cache.clone();
        loop {
            let page = match self.api.get(&self.v(&format!("/changes?since={}&limit=500", candidate.seq))) {
                Ok(p) => p,
                Err(e) if e.lines().next() == Some("HUB:since_too_old") => { self.snapshot()?; return Ok(true); }
                Err(e) => return Err(e),
            };
            if page["epoch"].as_str() != Some(candidate.epoch.as_str()) { self.snapshot()?; return Ok(true); }
            self.offset = page["server_time"].as_i64().unwrap_or_else(now_ms) - now_ms();
            for f in page["files"].as_array().ok_or("HUB:bad_answer")? {
                let (path, file) = file_of(f).ok_or("HUB:bad_answer")?;
                if f["deleted"].as_bool().ok_or("HUB:bad_answer")? { candidate.files.remove(&path); }
                else { candidate.files.insert(path, file); }
            }
            let next = page["next"].as_i64().ok_or("HUB:bad_answer")?;
            let more = page["has_more"].as_bool().ok_or("HUB:bad_answer")?;
            if next < candidate.seq || (more && next == candidate.seq) { return Err("HUB:bad_answer".into()); }
            candidate.seq = next;
            if !more { self.cache = candidate; return Ok(false); }
        }
    }

    /// Sends the contents under their hash. Nothing refers to them until a commit does.
    fn put_blob(&self, sha: &str, bytes: &[u8]) -> Res<()> {
        let url = self.api.url(&self.v(&format!("/blobs/{sha}")));
        if bytes.len() <= SINGLE {
            self.api.send(|c| c.put(&url).header("content-type", "application/octet-stream").body(bytes.to_vec()))?;
            return Ok(());
        }
        let head = self.api.send_any(|c| c.head(&url))?;
        if head.status().is_success() {
            return Ok(()); // the server has all of it already
        }
        let mut at = head.headers().get("x-received").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(bytes.len());
        if at == bytes.len() && at > 0 { at = at.saturating_sub(PIECE); }
        let mut rounds = 0;
        while at < bytes.len() {
            rounds += 1;
            if rounds > bytes.len() / PIECE + 8 {
                return Err("HUB:upload_stuck".into());
            }
            let end = (at + PIECE).min(bytes.len());
            let range = format!("bytes {at}-{}/{}", end - 1, bytes.len());
            let r = self.api.send_any(|c| c.put(&url).header("content-type", "application/octet-stream").header("content-range", range.clone()).body(bytes[at..end].to_vec()))?;
            match r.status().as_u16() {
                200 | 201 => return Ok(()),
                202 => at = end,
                409 => {
                    // the server holds a different amount than we thought: continue from what it says
                    let body: Value = r.json().unwrap_or(Value::Null);
                    at = body["received"].as_u64().filter(|n| *n <= bytes.len() as u64).ok_or("HUB:bad_answer")? as usize;
                    if at == bytes.len() && at > 0 { at = at.saturating_sub(PIECE); }
                }
                _ => return Err(status_error(r, true)),
            }
        }
        Err("HUB:incomplete_upload".into())
    }

    /// One conditional write. The result is the server's answer for that one operation.
    fn commit_one(&mut self, op: Value) -> Res<Value> {
        let body = json!({ "op_id": uuid::Uuid::new_v4().to_string(), "ops": [op], "confirm_bulk": self.confirm_bulk });
        let r = self.api.post(&self.v("/commit"), &body)?;
        r["results"].get(0).cloned().ok_or_else(|| "HUB:bad_answer".to_string())
    }

    /// The server says the path is not what we based the write on: remember what it is now, and report the conflict.
    fn absorb_current(&mut self, path: &str, current: &Value) {
        match file_of(&json!({ "path": path, "rev": current["rev"], "md5": current["md5"], "sha256": current["sha256"], "size": current["size"], "server_time": current["server_time"] })) {
            Some((p, f)) if !current["deleted"].as_bool().unwrap_or(false) && !current.is_null() => {
                self.cache.files.insert(p, f);
            }
            _ => {
                self.cache.files.remove(path);
            }
        }
    }

    fn remote_file(&self, path: &str, f: &HubFile) -> RemoteFile {
        RemoteFile { id: make_id(f.rev, path), path: path.to_string(), md5: f.md5.clone(), modified_ms: f.time - self.offset }
    }

    fn answer(&mut self, path: &str, r: &Value) -> Res<RemoteFile> {
        if r["ok"].as_bool() == Some(true) {
            let (_, f) = file_of(&json!({ "path": path, "rev": r["rev"], "md5": r["md5"], "sha256": r["sha256"], "size": r["size"], "server_time": r["server_time"] })).ok_or("HUB:bad_answer")?;
            if r["deleted"].as_bool().unwrap_or(false) {
                self.cache.files.remove(path);
            } else {
                self.cache.files.insert(path.to_string(), f.clone());
            }
            return Ok(self.remote_file(path, &f));
        }
        let code = r["error"].as_str().unwrap_or("failed");
        if code == "conflict" {
            self.absorb_current(path, &r["current"]);
        }
        let detail = r["detail"].as_str().unwrap_or("");
        let endpoint = self.api.url(&self.v("/commit"));
        Err(format!("HUB:{code}\npath={path}\ndetail={detail}\noperation=commit\nendpoint={endpoint}"))
    }
}

impl Remote for Hub {
    fn upload_batch(&mut self, files: &[PendingUpload]) -> Res<Vec<Res<RemoteFile>>> {
        if files.is_empty() { return Ok(vec![]); }
        if files.len() > 200 { return Err("HUB:batch_too_large".into()); }
        let mut ops = Vec::with_capacity(files.len());
        for file in files {
            let sha = hex(&Sha256::digest(&file.bytes));
            self.put_blob(&sha, &file.bytes)?;
            let base = file.existing.as_deref().map(split_id).transpose()?.map_or(0, |p| p.0);
            ops.push(json!({"op":"put", "path":file.path, "sha256":sha, "base_rev":base}));
        }
        let result = self.api.post(&self.v("/commit"), &json!({"op_id":uuid::Uuid::new_v4().to_string(), "ops":ops, "atomic":false}))?;
        let rows = result["results"].as_array().filter(|rows| rows.len() == files.len()).ok_or("HUB:bad_answer")?;
        Ok(files.iter().zip(rows).map(|(file, row)| self.answer(&file.path, row)).collect())
    }

    fn download_to(&mut self, f: &RemoteFile, destination: &Path) -> Res<()> {
        let (rev, _) = split_id(&f.id)?;
        let url = self.api.url(&self.v(&format!("/rev/{rev}")));
        let mut response = self.api.send(|c| c.get(&url))?;
        let header = response.headers().get("x-sha256").and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
        let expected = self.cache.files.get(&f.path).filter(|entry| entry.rev == rev).map(|entry| entry.sha.as_str()).unwrap_or(&header);
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(destination).map_err(err)?;
        let mut sha = Sha256::new();
        let mut md5 = md5::Md5::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            self.api.check_session()?;
            let n = response.read(&mut buffer).map_err(|e| format!("{NETWORK}{e}"))?;
            if n == 0 { break; }
            sha.update(&buffer[..n]); md5.update(&buffer[..n]);
            file.write_all(&buffer[..n]).map_err(err)?;
        }
        if (!expected.is_empty() && hex(&sha.finalize()) != expected) || (!f.md5.is_empty() && hex(&md5.finalize()) != f.md5) {
            return Err("HUB:corrupt_download".into());
        }
        file.sync_all().map_err(err)
    }

    fn upload_file(&mut self, path: &str, existing: Option<&str>, file: &mut std::fs::File) -> Res<RemoteFile> {
        // Keep one file handle: an atomic local replacement cannot change the
        // inode whose hashes and pieces are being uploaded.
        let mut sha = Sha256::new(); let mut md5 = md5::Md5::new();
        let mut buffer = [0u8; 64 * 1024]; let mut size = 0u64;
        loop {
            let n = file.read(&mut buffer).map_err(err)?;
            if n == 0 { break; }
            sha.update(&buffer[..n]); md5.update(&buffer[..n]); size += n as u64;
        }
        let sha = hex(&sha.finalize()); let digest = hex(&md5.finalize());
        if size == 0 { self.put_blob(&sha, &[])?; }
        let url = self.api.url(&self.v(&format!("/blobs/{sha}")));
        let head = self.api.send_any(|c| c.head(&url))?;
        if !head.status().is_success() {
            if head.status().as_u16() != 404 { return Err(status_error(head, true)); }
            let mut at = head.headers().get("x-received").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0).min(size);
            if at == size && at > 0 { at = at.saturating_sub(PIECE as u64); }
            let mut complete = false;
            let mut rounds = 0u64;
            while at < size {
                rounds += 1;
                if rounds > size / PIECE as u64 + 8 { return Err("HUB:upload_stuck".into()); }
                let end = (at + PIECE as u64).min(size);
                file.seek(SeekFrom::Start(at)).map_err(err)?;
                let mut piece = vec![0u8; (end - at) as usize];
                file.read_exact(&mut piece).map_err(err)?;
                let range = format!("bytes {at}-{}/{size}", end - 1);
                let r = self.api.send_any(|c| c.put(&url).header("content-type", "application/octet-stream").header("content-range", &range).body(piece.clone()))?;
                match r.status().as_u16() {
                    200 | 201 => { complete = true; break; },
                    202 => at = end,
                    409 => {
                        let body: Value = r.json().unwrap_or(Value::Null);
                        at = body["received"].as_u64().filter(|n| *n <= size).ok_or("HUB:bad_answer")?;
                        if at == size && at > 0 { at = at.saturating_sub(PIECE as u64); }
                    }
                    _ => return Err(status_error(r, true)),
                }
            }
            if !complete { return Err("HUB:incomplete_upload".into()); }
        }
        let base = existing.map(split_id).transpose()?.map_or(0, |p| p.0);
        let r = self.commit_one(json!({"op":"put", "path":path, "sha256":sha, "base_rev":base}))?;
        let answer = self.answer(path, &r)?;
        if answer.md5 != digest { return Err("HUB:corrupt_upload".into()); }
        Ok(answer)
    }

    fn confirm_deletes(&mut self, confirmed: bool) { self.confirm_bulk = confirmed; }
    fn validate_paths(&mut self, paths: &[String]) -> Res<()> {
        if let Some(path) = paths.iter().find(|p| p.starts_with("databases/")) {
            let health = self.api.get("/v1/health")?;
            if !health["capabilities"].as_array().is_some_and(|a| a.iter().any(|v| v == "database_sync")) {
                return Err(format!("HUB:server_upgrade_required\npath={path}\noperation=sync"));
            }
        }
        Ok(())
    }

    fn check(&mut self) -> Res<()> {
        if self.prepared {
            Ok(())
        } else {
            Err("HUB:not_prepared".into()) // `preflight` always runs first
        }
    }

    fn list(&mut self) -> Res<Vec<RemoteFile>> {
        Ok(self.cache.files.iter().map(|(p, f)| self.remote_file(p, f)).collect())
    }

    fn download(&mut self, f: &RemoteFile) -> Res<Vec<u8>> {
        let (rev, _) = split_id(&f.id)?;
        let url = self.api.url(&self.v(&format!("/rev/{rev}")));
        let r = self.api.send(|c| c.get(&url))?;
        let header_sha = r.headers().get("x-sha256").and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
        let bytes = r.bytes().map_err(|e| format!("{NETWORK}{e}"))?.to_vec();
        let expected = self.cache.files.get(&f.path).filter(|entry| entry.rev == rev).map(|entry| entry.sha.as_str()).unwrap_or(&header_sha);
        if (!expected.is_empty() && hex(&Sha256::digest(&bytes)) != expected) ||
            (!f.md5.is_empty() && hex(&md5::Md5::digest(&bytes)) != f.md5) {
            return Err("HUB:corrupt_download".into());
        }
        Ok(bytes)
    }

    fn upload(&mut self, path: &str, existing: Option<&str>, bytes: &[u8]) -> Res<RemoteFile> {
        let sha = hex(&Sha256::digest(bytes));
        self.put_blob(&sha, bytes)?;
        let base = match existing {
            Some(id) => split_id(id)?.0,
            None => 0,
        };
        let r = self.commit_one(json!({ "op": "put", "path": path, "sha256": sha, "base_rev": base }))?;
        self.answer(path, &r)
    }

    fn get(&mut self, id: &str) -> Res<Option<RemoteFile>> {
        let (_, path) = split_id(id)?;
        let url = self.api.url(&self.v("/file"));
        let r = self.api.send_any(|c| c.get(&url).query(&[("path", path)]))?;
        match r.status().as_u16() {
            200 => {
                let body: Value = r.json().map_err(|e| format!("{NETWORK}{e}"))?;
                match file_of(&body["file"]) {
                    Some((p, f)) if !body["file"]["deleted"].as_bool().unwrap_or(false) => Ok(Some(self.remote_file(&p, &f))),
                    _ => Ok(None),
                }
            }
            404 => {
                // only the server's own "no such file" means the file is gone; any other 404 (a wrong address, a proxy) proves nothing
                let body: Value = r.json().unwrap_or(Value::Null);
                match body["error"].as_str() {
                    Some("no_such_file") => Ok(None),
                    Some("no_such_vault") => Err(CLOUD_GONE.into()),
                    _ => Err("HUB:http_404".into()),
                }
            }
            _ => Err(status_error(r, true)),
        }
    }

    fn trash(&mut self, id: &str) -> Res<()> {
        let (rev, path) = split_id(id)?;
        let r = self.commit_one(json!({ "op": "delete", "path": path, "base_rev": rev }))?;
        self.answer(path, &r).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use md5::Md5;

    #[test]
    fn an_old_server_is_rejected_before_a_vault_can_be_created() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = [0u8; 8192];
            let n = socket.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /v1/health "));
            let body = r#"{"api":1,"capabilities":["full_snapshot"]}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let api = Api::new(&format!("http://{address}"), None).unwrap().quick();
        let mut hub = Hub::new(api, "test-vault", Cache::default());
        assert_eq!(hub.preflight("test").err().as_deref(), Some("HUB:session_server_upgrade_required"));
        server.join().unwrap();
        assert!(!hub.prepared);
    }

    fn md5_of(bytes: &[u8]) -> String {
        hex(&Md5::digest(bytes))
    }

    #[test]
    fn http_diagnostics_preserve_status_and_route_without_credentials_or_query() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).unwrap();
            let body = r#"{"error":"not_found"}"#;
            write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let response = reqwest::blocking::get(format!("http://user:password@{address}/v1/example?token=secret")).unwrap();
        let message = status_error(response, true);
        server.join().unwrap();
        assert_eq!(message.lines().next(), Some("HUB:not_found"));
        assert!(message.contains("http=404"));
        assert!(message.contains("/v1/example"));
        assert!(!message.contains("password") && !message.contains("token") && !message.contains("secret") && !message.contains("user"));
    }

    #[test]
    fn leading_zero_bits_counts_across_bytes() {
        assert_eq!(leading_zero_bits(&[0xff]), 0);
        assert_eq!(leading_zero_bits(&[0x0f]), 4);
        assert_eq!(leading_zero_bits(&[0x00, 0x01]), 15);
        assert_eq!(leading_zero_bits(&[0, 0, 0]), 24);
    }

    #[test]
    fn proof_of_work_meets_its_difficulty() {
        let c = solve_pow("some.challenge.sig", 10);
        assert!(leading_zero_bits(&Sha256::digest(format!("some.challenge.sig:{c}").as_bytes())) >= 10);
    }

    #[test]
    fn ids_keep_the_rev_and_the_path() {
        let id = make_id(42, "pages/abc.json");
        assert_eq!(split_id(&id).unwrap(), (42, "pages/abc.json"));
        assert!(split_id("nonsense").is_err());
        assert!(split_id("x:pages/a.json").is_err());
    }

    #[test]
    fn root_hash_is_the_same_as_the_servers() {
        // computed by the server code for these two files (server/src/vaults.js, rootHash)
        let mut files = BTreeMap::new();
        files.insert("pages/a.json".to_string(), HubFile { rev: 1, md5: md5_of(b"a"), sha: String::new(), size: 1, time: 0 });
        files.insert("pages/b.json".to_string(), HubFile { rev: 2, md5: md5_of(b"b"), sha: String::new(), size: 1, time: 0 });
        assert_eq!(root_of(&files), "9ee351a4056cc95744c24c1693184bc11988f3dc98bb1a2dc86136caabca773d");
    }

    #[test]
    fn network_and_auth_errors_are_told_apart() {
        assert!(is_network("Upload(\"x\"): NETWORK:timed out"));
        assert!(!is_network("HUB:conflict"));
        assert!(is_auth("AUTH:unauthorized"));
    }
}

/// The sync engine, two real vaults and a real server. They need a server on this computer, so they are ignored unless asked for:
///   (in server/)   REGISTRATION=open POW_BITS=12 STORAGE=disk DATA_DIR=<tmp> SESSION_SECRET=<32+ chars> PORT=3111 node src/index.js
///   (in src-tauri) NOVIQ_TEST_SERVER=http://localhost:3111 cargo test e2e -- --ignored --test-threads=1
#[cfg(test)]
mod e2e {
    use super::*;
    use crate::sync::{sync_once, Report, SyncState};
    use crate::vault::Vault;
    use std::path::PathBuf;

    const P1: &str = "11111111-1111-4111-8111-111111111111";
    const P2: &str = "22222222-2222-4222-8222-222222222222";

    fn server() -> String {
        std::env::var("NOVIQ_TEST_SERVER").expect("set NOVIQ_TEST_SERVER to a running test server, e.g. http://localhost:3111")
    }

    /// A new account (so that tests never see each other's vaults); returns its device token.
    fn signup_account() -> (String, String) {
        let api = Api::new(&server(), None).unwrap();
        let ch = api.get("/v1/auth/challenge").unwrap();
        let challenge = ch["challenge"].as_str().unwrap().to_string();
        let counter = solve_pow(&challenge, ch["bits"].as_u64().unwrap() as u32);
        let name = format!("e2e{}", uuid::Uuid::new_v4().simple());
        let r = api.post("/v1/auth/register", &json!({ "username": &name[..20], "password": "an end to end password", "device_name": "test", "challenge": challenge, "counter": counter })).unwrap();
        (r["token"].as_str().unwrap().to_string(), name[..20].to_string())
    }

    struct Dev {
        vault: Vault,
        state: SyncState,
        api: Api,
        id: String,
    }

    impl Dev {
        fn new(token: &str, id: &str) -> Dev {
            let root: PathBuf = std::env::temp_dir().join(format!("noviq-e2e-{}", uuid::Uuid::new_v4()));
            let vault = Vault::create_with_id(root, "E2E", id).unwrap();
            Dev { vault, state: SyncState::default(), api: Api::new(&server(), Some(token.to_string())).unwrap().quick(), id: id.to_string() }
        }
        fn try_sync(&mut self) -> Res<Report> {
            let mut hub = Hub::new(self.api.clone(), &self.id, self.state.hub.clone());
            let pre = hub.preflight("E2E")?;
            if pre.baseline {
                self.state.files.clear();
            }
            let rep = sync_once(&self.vault, &mut hub, &mut self.state, &mut |_| {})?;
            self.state.hub = hub.cache.clone();
            Ok(rep)
        }
        fn sync(&mut self) -> Report {
            let r = self.try_sync().unwrap();
            assert!(r.errors.is_empty(), "{:?}", r.errors);
            r
        }
        fn save(&self, id: &str, title: &str, at: i64) {
            self.vault.save_pages(&[json!({ "id": id, "title": title, "content": {"type":"doc","content":[]}, "updatedAt": at, "deletedAt": null })], &[], false).unwrap();
        }
        fn page(&self, id: &str) -> Option<Value> {
            self.vault.pages_all().unwrap().into_iter().find(|p| p["id"] == id)
        }
        fn titles(&self) -> Vec<String> {
            let mut t: Vec<String> = self.vault.pages_all().unwrap().iter().map(|p| p["title"].as_str().unwrap_or("").to_string()).collect();
            t.sort();
            t
        }
    }

    fn pair() -> (Dev, Dev) {
        let (token, username) = signup_account();
        let second = Api::new(&server(), None).unwrap().post("/v1/auth/login", &json!({"username":username,"password":"an end to end password","device_name":"second device"})).unwrap();
        let token2 = second["token"].as_str().unwrap();
        assert_ne!(token, token2);
        let id = uuid::Uuid::new_v4().to_string();
        (Dev::new(&token, &id), Dev::new(token2, &id))
    }

    #[test]
    #[ignore]
    fn e2e_an_untouched_offline_copy_cannot_replace_a_published_edit() {
        let (mut a, mut b) = pair();
        a.save(P1, "shared baseline", 100); a.sync(); b.sync();
        a.save(P1, "published while b was offline", 200); a.sync();
        b.sync(); a.sync(); b.sync();
        assert_eq!(a.page(P1).unwrap()["title"], "published while b was offline");
        assert_eq!(a.page(P1), b.page(P1));
        assert_eq!(b.sync().uploaded, 0);
    }

    #[test]
    #[ignore]
    fn e2e_independent_offline_edits_to_different_files_both_survive() {
        let (mut a, mut b) = pair();
        a.save(P1, "first", 100); a.save(P2, "second", 100); a.sync(); b.sync();
        a.save(P1, "edited on a", 200); b.save(P2, "edited offline on b", 200);
        a.sync(); b.sync(); a.sync(); b.sync();
        assert_eq!(a.page(P1), b.page(P1)); assert_eq!(a.page(P2), b.page(P2));
        assert_eq!(a.page(P1).unwrap()["title"], "edited on a");
        assert_eq!(a.page(P2).unwrap()["title"], "edited offline on b");
    }

    #[test]
    #[ignore]
    fn e2e_revoked_offline_device_keeps_its_edit_and_can_reauthenticate() {
        let (mut a, mut b) = pair();
        a.save(P1, "baseline", 100); a.sync(); b.sync();
        let user = a.api.get("/v1/account").unwrap()["user"]["username"].as_str().unwrap().to_string();
        b.save(P1, "offline edit", 300);
        b.api.post("/v1/auth/logout", &json!({})).unwrap();
        a.save(P1, "online edit", 200); a.sync();
        assert!(b.try_sync().is_err());
        assert_eq!(b.page(P1).unwrap()["title"], "offline edit");
        let login = Api::new(&server(), None).unwrap().post("/v1/auth/login", &json!({"username":user,"password":"an end to end password","device_name":"reauthenticated"})).unwrap();
        b.api = Api::new(&server(), Some(login["token"].as_str().unwrap().to_string())).unwrap().quick();
        b.sync(); a.sync(); b.sync(); a.sync();
        assert_eq!(a.page(P1), b.page(P1));
        let mut titles = vec![b.page(P1).unwrap()["title"].as_str().unwrap().to_string()];
        titles.extend(b.vault.versions_list(P1).unwrap().iter().filter_map(|v| v["title"].as_str().map(str::to_string)));
        assert!(titles.contains(&"offline edit".into()));
        assert!(titles.contains(&"online edit".into()));
    }

    #[test]
    #[ignore]
    fn e2e_a_real_offline_edit_survives_a_remote_delete() {
        let (mut a, mut b) = pair();
        a.save(P1, "baseline", 100); a.sync(); b.sync();
        b.save(P1, "edited while offline", 300);
        a.vault.save_pages(&[], &[P1.to_string()], false).unwrap(); a.sync();
        b.sync(); a.sync(); b.sync();
        assert_eq!(a.page(P1), b.page(P1));
        assert_eq!(a.page(P1).unwrap()["title"], "edited while offline");
    }

    #[test]
    #[ignore]
    fn e2e_three_independent_sessions_keep_all_equal_time_versions() {
        let (mut a, mut b) = pair();
        let user = a.api.get("/v1/account").unwrap()["user"]["username"].as_str().unwrap().to_string();
        let third = Api::new(&server(), None).unwrap().post("/v1/auth/login", &json!({"username":user,"password":"an end to end password","device_name":"third device"})).unwrap();
        let mut c = Dev::new(third["token"].as_str().unwrap(), &a.id);
        a.save(P1, "baseline", 100); a.sync(); b.sync(); c.sync();
        a.save(P1, "version a", 200); b.save(P1, "version b", 200); c.save(P1, "version c", 200);
        for _ in 0..3 { a.sync(); b.sync(); c.sync(); }
        assert_eq!(a.page(P1), b.page(P1)); assert_eq!(a.page(P1), c.page(P1));
        for d in [&a, &b, &c] {
            let mut titles = vec![d.page(P1).unwrap()["title"].as_str().unwrap().to_string()];
            titles.extend(d.vault.versions_list(P1).unwrap().iter().filter_map(|v| v["title"].as_str().map(str::to_string)));
            for title in ["version a", "version b", "version c"] { assert!(titles.contains(&title.to_string()), "{titles:?}"); }
        }
    }

    #[test]
    #[ignore]
    fn e2e_a_stale_batch_member_cannot_replace_a_newer_file_or_block_an_unrelated_file() {
        let (mut a, mut b) = pair();
        a.save(P1, "baseline", 100); a.sync(); b.sync();
        let path = format!("pages/{P1}.json");
        let stale = b.state.hub.files[&path].rev;
        a.save(P1, "newer remote content", 200); a.sync();
        let mut hub = Hub::new(b.api.clone(), &b.id, b.state.hub.clone());
        hub.preflight("E2E").unwrap();
        let results = hub.upload_batch(&[
            PendingUpload { path: path.clone(), existing: Some(make_id(stale, &path)), bytes: b"stale bytes".to_vec() },
            PendingUpload { path:"kv/unrelated.json".into(), existing:None, bytes:b"{}".to_vec() },
        ]).unwrap();
        assert!(results[0].is_err()); assert!(results[1].is_ok());
        a.sync();
        assert_eq!(a.page(P1).unwrap()["title"], "newer remote content");
        assert_eq!(std::fs::read(a.vault.root.join("kv/unrelated.json")).unwrap(), b"{}");
    }

    #[test]
    #[ignore]
    fn e2e_a_large_first_upload_uses_batches_and_every_file_reaches_another_session() {
        let (mut a, mut b) = pair();
        for i in 0..405 { crate::vault::write_atomic(&a.vault.root.join(format!("kv/batch-{i:04}.json")), format!("{{\"n\":{i}}}").as_bytes()).unwrap(); }
        assert_eq!(a.sync().uploaded, 406); // files plus vault marker
        b.sync();
        for i in 0..405 { assert_eq!(std::fs::read(b.vault.root.join(format!("kv/batch-{i:04}.json"))).unwrap(), format!("{{\"n\":{i}}}").as_bytes()); }
        assert_eq!(a.sync().uploaded, 0);
    }

    #[test]
    #[ignore]
    fn e2e_a_page_travels_both_ways_and_a_quiet_sync_does_nothing() {
        let (mut a, mut b) = pair();
        a.save(P1, "hello", 100);
        assert!(a.sync().uploaded >= 1);
        b.sync();
        assert_eq!(b.page(P1).unwrap()["title"], "hello");
        b.save(P1, "edited on b", 200);
        b.sync();
        a.sync();
        assert_eq!(a.page(P1).unwrap()["title"], "edited on b");
        assert!(!a.sync().changed() && !b.sync().changed());
    }

    #[test]
    #[ignore]
    fn e2e_different_pages_edited_at_once_both_survive() {
        let (mut a, mut b) = pair();
        a.save(P1, "one", 100);
        a.sync();
        b.sync();
        a.save(P1, "one-a", 200);
        b.save(P2, "two-b", 200);
        a.sync();
        b.sync();
        a.sync();
        assert_eq!(a.titles(), vec!["one-a", "two-b"]);
        assert_eq!(b.titles(), vec!["one-a", "two-b"]);
    }

    #[test]
    #[ignore]
    fn e2e_the_same_page_edited_on_both_keeps_the_newer_and_the_older_in_history() {
        let (mut a, mut b) = pair();
        a.save(P1, "start", 100);
        a.sync();
        b.sync();
        a.save(P1, "from a", 300);
        b.save(P1, "from b", 200);
        a.sync(); // a is first at the server
        b.sync(); // b's edit was based on an older rev: refused there, merged here
        for _ in 0..2 {
            // the history file the merge made travels in the rounds after it
            a.sync();
            b.sync();
        }
        for d in [&a, &b] {
            assert_eq!(d.page(P1).unwrap()["title"], "from a", "the newer edit wins on both devices");
            assert!(d.vault.versions_list(P1).unwrap().iter().any(|v| v.to_string().contains("from b")), "the older edit is kept in the history");
        }
    }

    #[test]
    #[ignore]
    fn e2e_a_deleted_page_reaches_the_other_device() {
        let (mut a, mut b) = pair();
        a.save(P1, "doomed", 100);
        a.save(P2, "stays", 100);
        a.sync();
        b.sync();
        a.vault.save_pages(&[], &[P1.to_string()], false).unwrap();
        a.sync();
        b.sync();
        assert_eq!(b.titles(), vec!["stays"]);
        assert!(b.vault.pages_all().unwrap().iter().all(|p| p["id"] != P1));
    }

    #[test]
    #[ignore]
    fn e2e_database_records_survive_client_state_reload_and_sync_between_devices() {
        use std::fs;
        let (mut a, mut b) = pair();
        let path = "databases/views/view1.json";
        let first = br#"{"id":"view1","revision":1,"name":"original"}"#;
        crate::vault::write_atomic(&a.vault.root.join(path), first).unwrap();
        a.sync();
        b.sync();
        assert_eq!(fs::read(b.vault.root.join(path)).unwrap(), first);
        // A client upgrade reads its existing bookkeeping rather than resetting the account or baseline.
        a.state = serde_json::from_slice(&serde_json::to_vec(&a.state).unwrap()).unwrap();
        let edited = br#"{"id":"view1","revision":2,"name":"edited offline"}"#;
        crate::vault::write_atomic(&a.vault.root.join(path), edited).unwrap();
        a.sync();
        b.sync();
        assert_eq!(fs::read(b.vault.root.join(path)).unwrap(), edited);
        assert_eq!(fs::read(a.vault.root.join(path)).unwrap(), edited);
    }

    #[test]
    #[ignore]
    fn e2e_a_big_attachment_travels_in_pieces() {
        let (mut a, mut b) = pair();
        let bytes: Vec<u8> = (0..(5 * (1usize << 20) + 123)).map(|i| (i * 7 + i / 13) as u8).collect();
        let id = hex(&Sha256::digest(&bytes));
        a.vault.file_put(&id, &bytes, "application/octet-stream", "big.bin", 1).unwrap();
        a.sync();
        b.sync();
        assert_eq!(b.vault.file_get(&id).unwrap(), bytes);
    }

    #[test]
    #[ignore]
    fn e2e_work_done_offline_is_kept_and_sent_when_the_network_is_back() {
        let (mut a, mut b) = pair();
        a.save(P1, "before", 100);
        a.sync();
        // the network is gone: a dead address
        let real = a.api.clone();
        a.api = Api::new("http://127.0.0.1:9", Some("nvq_x".repeat(8))).unwrap().quick();
        a.save(P1, "written offline", 200);
        let m = a.try_sync().unwrap_err();
        assert!(is_network(&m), "{m}");
        assert_eq!(a.page(P1).unwrap()["title"], "written offline", "nothing was lost or reverted");
        a.api = real;
        a.sync();
        b.sync();
        assert_eq!(b.page(P1).unwrap()["title"], "written offline");
    }

    #[test]
    #[ignore]
    fn e2e_a_server_that_lost_its_data_deletes_nothing_on_the_devices() {
        let (mut a, mut b) = pair();
        a.save(P1, "one", 100);
        b.save(P2, "two", 100);
        a.sync();
        b.sync();
        a.sync();
        // as if the server had come back from a backup: this device's idea of "the last sync" no longer counts
        a.state.hub.epoch = "an-older-generation".into();
        a.sync();
        assert_eq!(a.titles(), vec!["one", "two"]);
        b.sync();
        assert_eq!(b.titles(), vec!["one", "two"]);
    }

    #[test]
    #[ignore]
    fn e2e_a_damaged_mirror_is_noticed_and_never_looks_like_a_deletion() {
        let (mut a, mut b) = pair();
        a.save(P1, "one", 100);
        a.save(P2, "two", 100);
        a.sync();
        b.sync();
        // the mirror forgets a page (a bug, a damaged file): the engine would read that as "deleted on the server"
        let victim = a.state.hub.files.keys().find(|p| p.starts_with("pages/")).cloned().unwrap();
        a.state.hub.files.remove(&victim);
        a.sync();
        assert_eq!(a.titles(), vec!["one", "two"]);
        assert!(a.state.hub.files.contains_key(&victim), "the mirror was rebuilt");
    }

    #[test]
    #[ignore]
    fn e2e_a_vault_that_is_gone_from_the_server_stops_the_sync_and_keeps_the_files() {
        let (mut a, _b) = pair();
        a.save(P1, "one", 100);
        a.sync();
        let url = a.api.url(&format!("/v1/vaults/{}", a.id));
        a.api.send(|c| c.delete(&url)).unwrap();
        let m = a.try_sync().unwrap_err();
        assert_eq!(m, CLOUD_GONE);
        assert_eq!(a.titles(), vec!["one"]);
    }
    #[test]
    #[ignore]
    fn e2e_a_new_device_reads_every_page_of_a_large_snapshot() {
        let (mut a, mut b) = pair();
        a.sync();
        let mut hub = Hub::new(a.api.clone(), &a.id, a.state.hub.clone());
        hub.preflight("T").unwrap();
        let bytes = b"{}";
        let sha = hex(&Sha256::digest(bytes));
        hub.put_blob(&sha, bytes).unwrap();
        for start in (0..501).step_by(200) {
            let ops: Vec<_> = (start..(start + 200).min(501)).map(|n| json!({
                "op":"put", "path":format!("kv/item-{n:04}.json"), "sha256":sha, "base_rev":0
            })).collect();
            let result = a.api.post(&format!("/v1/vaults/{}/commit", a.id), &json!({"op_id":uuid::Uuid::new_v4().to_string(),"ops":ops})).unwrap();
            assert!(result["results"].as_array().unwrap().iter().all(|r| r["ok"] == true));
        }
        b.sync();
        for n in 0..501 {
            assert_eq!(std::fs::read(b.vault.root.join(format!("kv/item-{n:04}.json"))).unwrap(), bytes);
        }
        assert_eq!(b.state.hub.files.len(), 502);
    }

}
