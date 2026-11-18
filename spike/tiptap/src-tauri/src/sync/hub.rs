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

use super::{Remote, RemoteFile, CLOUD_GONE};
use crate::vault::{err, now_ms, Res};
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Duration;

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

const API_VERSION: &str = "1";
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
        Ok(Api { http, base: base.trim_end_matches('/').to_string(), token, attempts: 4 })
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
            let mut rb = build(&self.http).header("x-nevis-api", API_VERSION);
            if let Some(t) = &self.token {
                rb = rb.bearer_auth(t);
            }
            let last = attempt + 1 == self.attempts;
            match rb.send() {
                Ok(r) => {
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

/// Everything but unreserved characters as %XX, for a path inside a query string.
fn percent_encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub fn make_id(rev: i64, path: &str) -> String {
    format!("{rev}:{path}")
}

pub fn split_id(id: &str) -> Res<(i64, &str)> {
    let (rev, path) = id.split_once(':').ok_or_else(|| format!("bad file id {id}"))?;
    Ok((rev.parse().map_err(|_| format!("bad file id {id}"))?, path))
}

/// What `preflight` found out. `created` and `baseline` mean "start from what is here, delete nothing": the bookkeeping
/// of the engine no longer says anything about this server.
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
    /// what the server can do (`/v1/health`), asked once per sync
    capabilities: Option<Vec<String>>,
}

impl Hub {
    pub fn new(api: Api, vault: &str, cache: Cache) -> Hub {
        Hub { api, vault: vault.to_string(), cache, offset: 0, prepared: false, capabilities: None }
    }

    fn has_capability(&mut self, name: &str) -> Res<bool> {
        if self.capabilities.is_none() {
            let health = self.api.get("/v1/health")?;
            self.capabilities = Some(health["capabilities"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect());
        }
        Ok(self.capabilities.iter().flatten().any(|c| c == name))
    }

    fn v(&self, tail: &str) -> String {
        format!("/v1/vaults/{}{tail}", self.vault)
    }

    /// Makes the mirror current: checks that the vault exists (creating it the first time), notices a server that lost
    /// data, pulls what changed, and checks the mirror against the server's own hash of its files.
    pub fn preflight(&mut self, name: &str, must_exist: bool) -> Res<Preflight> {
        let mut out = Preflight::default();
        let state = match self.api.get(&self.v("/state")) {
            Ok(s) => s,
            Err(e) if e.lines().next() == Some("HUB:no_such_vault") => {
                if must_exist || !self.cache.epoch.is_empty() {
                    return Err(CLOUD_GONE.into()); // it was there (or is being downloaded) and is gone: the user decides, nothing is created or deleted
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
        // the server's counter went backwards: it lost data (or was restored) without changing its epoch
        if state["seq"].as_i64().is_some_and(|s| s < self.cache.seq) {
            self.cache = Cache::default();
            out.baseline = true;
        }
        self.cache.epoch = epoch;
        // (a mirror rebuilt only because the server forgot how far we were is not a baseline: the bookkeeping of the
        // engine is about files, not about change numbers, and is what turns a remote deletion into a deletion here)
        self.pull()?;
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

    /// Brings the mirror up to date. A mirror that has to be (re)built (fresh device, or the server no longer remembers
    /// how far back we were) is built from a snapshot of the live files, then the normal feed continues from the
    /// snapshot's first `seq`.
    fn pull(&mut self) -> Res<()> {
        let mut rebuilt = false;
        if self.cache.seq == 0 {
            self.snapshot()?;
        }
        loop {
            let url = self.v(&format!("/changes?since={}&limit=500", self.cache.seq));
            let page = match self.api.get(&url) {
                Ok(p) => p,
                Err(e) if e.lines().next() == Some("HUB:since_too_old") && !rebuilt => {
                    self.snapshot()?;
                    rebuilt = true;
                    continue;
                }
                Err(e) => return Err(e),
            };
            self.offset = page["server_time"].as_i64().unwrap_or_else(now_ms) - now_ms();
            for f in page["files"].as_array().into_iter().flatten() {
                let Some((path, file)) = file_of(f) else { continue };
                if f["deleted"].as_bool().unwrap_or(false) {
                    self.cache.files.remove(&path);
                } else {
                    self.cache.files.insert(path, file);
                }
            }
            // only now has this page been applied; a connection lost before this point repeats the page, which changes nothing
            self.cache.seq = page["next"].as_i64().unwrap_or(self.cache.seq).max(self.cache.seq);
            if !page["has_more"].as_bool().unwrap_or(false) {
                return Ok(());
            }
        }
    }

    /// Replaces the mirror with the server's live files, read page by page in path order. The cursor becomes the `seq` of
    /// the FIRST page: whatever changed while the pages were read is in the normal feed after it and is applied again
    /// harmlessly. The mirror is only replaced when every page arrived.
    fn snapshot(&mut self) -> Res<()> {
        let mut files = BTreeMap::new();
        let mut first_seq = None;
        let mut after = String::new();
        loop {
            let page = self.api.get(&self.v(&format!("/changes?snapshot=1&after={}&limit=500", percent_encode(&after))))?;
            self.offset = page["server_time"].as_i64().unwrap_or_else(now_ms) - now_ms();
            first_seq.get_or_insert(page["seq"].as_i64().ok_or("HUB:bad_answer")?);
            for f in page["files"].as_array().into_iter().flatten() {
                let Some((path, file)) = file_of(f) else { continue };
                if !f["deleted"].as_bool().unwrap_or(false) {
                    files.insert(path, file);
                }
            }
            if !page["has_more"].as_bool().unwrap_or(false) {
                break;
            }
            let next = page["next_after"].as_str().unwrap_or("");
            if next.is_empty() || next <= after.as_str() {
                return Err("HUB:bad_answer".into()); // a server that does not move on would keep us here forever
            }
            after = next.to_string();
        }
        self.cache.files = files;
        self.cache.seq = first_seq.unwrap_or(0);
        Ok(())
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
                    at = body["received"].as_u64().unwrap_or(0) as usize;
                }
                _ => return Err(status_error(r, true)),
            }
        }
        Ok(())
    }

    /// One conditional write. The result is the server's answer for that one operation.
    fn commit_one(&mut self, op: Value) -> Res<Value> {
        let body = json!({ "op_id": uuid::Uuid::new_v4().to_string(), "ops": [op] });
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
    fn validate_paths(&mut self, paths: &[String]) -> Res<()> {
        for (prefix, capability) in [("databases/", "database_sync"), ("pages-state/", "page_state")] {
            if let Some(path) = paths.iter().find(|p| p.starts_with(prefix)) {
                if !self.has_capability(capability)? {
                    return Err(format!("HUB:server_upgrade_required\npath={path}\noperation=sync"));
                }
            }
        }
        Ok(())
    }

    fn page_state_supported(&mut self) -> Res<bool> {
        self.has_capability("page_state")
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
        r.bytes().map(|b| b.to_vec()).map_err(|e| format!("{NETWORK}{e}"))
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

    /// A server on this computer that answers `n` requests with what `route` says (status, body).
    fn mock_server(n: usize, route: impl Fn(&str) -> (u16, String) + Send + 'static) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            for _ in 0..n {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0; 4096];
                let len = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..len]).to_string();
                let target = request.split_whitespace().nth(1).unwrap_or("").to_string();
                let (status, body) = route(&target);
                write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (base, handle)
    }

    fn cache_at(seq: i64) -> Cache {
        let mut files = BTreeMap::new();
        files.insert("pages/a.json".to_string(), HubFile { rev: 1, md5: md5_of(b"a"), sha: String::new(), size: 1, time: 0 });
        Cache { epoch: "e".into(), seq, files }
    }

    fn snap_row(path: &str, rev: i64, content: &[u8]) -> String {
        format!(r#"{{"path":"{path}","rev":{rev},"md5":"{}"}}"#, md5_of(content))
    }

    #[test]
    fn a_rebuild_for_history_keeps_the_bookkeeping_of_the_engine() {
        let (base, server) = mock_server(4, |t| {
            if t.ends_with("/state") {
                (200, r#"{"epoch":"e","seq":9}"#.into())
            } else if t.contains("since=5") {
                (410, r#"{"error":"since_too_old"}"#.into())
            } else if t.contains("snapshot=1") {
                (200, format!(r#"{{"files":[{}],"seq":9,"has_more":false,"next_after":""}}"#, snap_row("pages/b.json", 9, b"b")))
            } else {
                assert!(t.contains("since=9"), "{t}");
                (200, r#"{"files":[],"next":9,"has_more":false}"#.into())
            }
        });
        let mut state = crate::sync::SyncState::default();
        state.files.insert("pages/b.json".into(), crate::sync::Entry { base: md5_of(b"b"), remote_id: "9:pages/b.json".into(), ..Default::default() });
        let mut hub = Hub::new(Api::new(&base, None).unwrap().quick(), "v", cache_at(5));
        let pre = hub.preflight("T", false).unwrap();
        server.join().unwrap();
        // what sync_app does with the answer: only a baseline wipes the bases of the engine
        if pre.baseline {
            state.files.clear();
        }
        assert!(!pre.baseline, "{pre:?}");
        assert!(state.files.contains_key("pages/b.json"), "the bases survive a rebuild for history");
        assert_eq!(hub.cache.files.keys().collect::<Vec<_>>(), vec!["pages/b.json"]);
        assert_eq!(hub.cache.seq, 9);
    }

    #[test]
    fn a_snapshot_is_read_page_by_page_and_continues_from_the_first_seq() {
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let log = seen.clone();
        // 5 requests: state, three snapshot pages (seq 10, 11, 12: the vault moves on meanwhile), the feed after the first seq
        let (base, server) = mock_server(5, move |t| {
            log.lock().unwrap().push(t.to_string());
            if t.ends_with("/state") {
                (200, r#"{"epoch":"e","seq":10}"#.into())
            } else if t.contains("snapshot=1&after=&") {
                (200, format!(r#"{{"files":[{},{}],"seq":10,"has_more":true,"next_after":"pages/b b.json"}}"#, snap_row("pages/a.json", 1, b"a"), snap_row("pages/b b.json", 2, b"b")))
            } else if t.contains("snapshot=1&after=pages%2Fb%20b.json&") {
                (200, format!(r#"{{"files":[{}],"seq":11,"has_more":true,"next_after":"pages/c.json"}}"#, snap_row("pages/c.json", 3, b"c")))
            } else if t.contains("snapshot=1&after=pages%2Fc.json&") {
                // pages/a.json changed (rev 11) and pages/d.json appeared (rev 12) while the pages were read
                (200, format!(r#"{{"files":[{}],"seq":12,"has_more":false,"next_after":""}}"#, snap_row("pages/e.json", 4, b"e")))
            } else {
                assert!(t.contains("since=10"), "the feed continues from the FIRST page's seq: {t}");
                (200, format!(r#"{{"files":[{},{},{{"path":"pages/c.json","rev":12,"deleted":true}}],"next":12,"has_more":false}}"#, snap_row("pages/a.json", 11, b"a2"), snap_row("pages/d.json", 12, b"d")))
            }
        });
        let mut hub = Hub::new(Api::new(&base, None).unwrap().quick(), "v", Cache::default());
        let pre = hub.preflight("T", false).unwrap();
        server.join().unwrap();
        assert!(!pre.baseline, "{pre:?}");
        let files: Vec<_> = hub.cache.files.iter().map(|(p, f)| (p.as_str(), f.rev)).collect();
        assert_eq!(files, vec![("pages/a.json", 11), ("pages/b b.json", 2), ("pages/d.json", 12), ("pages/e.json", 4)]);
        assert_eq!(hub.cache.seq, 12);
        assert!(seen.lock().unwrap().iter().all(|t| !t.contains("since=0")), "a fresh device does not use the plain feed");
    }

    #[test]
    fn a_server_counter_that_went_backwards_is_a_baseline() {
        let (base, server) = mock_server(3, |t| {
            if t.ends_with("/state") {
                (200, r#"{"epoch":"e","seq":3}"#.into())
            } else if t.contains("snapshot=1") {
                (200, r#"{"files":[],"seq":3,"has_more":false,"next_after":""}"#.into())
            } else {
                assert!(t.contains("since=3"), "{t}");
                (200, r#"{"files":[],"next":3,"has_more":false}"#.into())
            }
        });
        let mut hub = Hub::new(Api::new(&base, None).unwrap().quick(), "v", cache_at(5));
        let pre = hub.preflight("T", false).unwrap();
        server.join().unwrap();
        assert!(pre.baseline, "{pre:?}");
        assert_eq!(hub.cache.seq, 3);
    }

    #[test]
    fn downloading_a_vault_that_is_gone_from_the_server_creates_nothing() {
        // one request only: the state; a create (POST) would find no one to answer and fail the join
        let (base, server) = mock_server(1, |t| {
            assert!(t.ends_with("/state"), "{t}");
            (404, r#"{"error":"no_such_vault"}"#.into())
        });
        let mut hub = Hub::new(Api::new(&base, None).unwrap().quick(), "v", Cache::default());
        assert_eq!(hub.preflight("T", true).unwrap_err(), CLOUD_GONE);
        server.join().unwrap();
    }

    #[test]
    fn a_snapshot_that_does_not_move_on_is_an_error_not_a_loop() {
        let (base, _server) = mock_server(2, |t| {
            if t.ends_with("/state") {
                (200, r#"{"epoch":"e","seq":3}"#.into())
            } else {
                (200, r#"{"files":[],"seq":3,"has_more":true,"next_after":""}"#.into())
            }
        });
        let mut hub = Hub::new(Api::new(&base, None).unwrap().quick(), "v", Cache::default());
        assert_eq!(hub.preflight("T", false).unwrap_err(), "HUB:bad_answer");
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
///   (in src-tauri) NEVIS_TEST_SERVER=http://localhost:3111 cargo test e2e -- --ignored --test-threads=1
#[cfg(test)]
mod e2e {
    use super::*;
    use crate::sync::{sync_once, Report, SyncState};
    use crate::vault::Vault;
    use std::path::PathBuf;

    const P1: &str = "11111111-1111-4111-8111-111111111111";
    const P2: &str = "22222222-2222-4222-8222-222222222222";

    fn server() -> String {
        std::env::var("NEVIS_TEST_SERVER").expect("set NEVIS_TEST_SERVER to a running test server, e.g. http://localhost:3111")
    }

    /// A new account (so that tests never see each other's vaults); returns its device token.
    fn signup() -> String {
        let api = Api::new(&server(), None).unwrap();
        let ch = api.get("/v1/auth/challenge").unwrap();
        let challenge = ch["challenge"].as_str().unwrap().to_string();
        let counter = solve_pow(&challenge, ch["bits"].as_u64().unwrap() as u32);
        let name = format!("e2e{}", uuid::Uuid::new_v4().simple());
        let r = api.post("/v1/auth/register", &json!({ "username": &name[..20], "password": "an end to end password", "device_name": "test", "challenge": challenge, "counter": counter })).unwrap();
        r["token"].as_str().unwrap().to_string()
    }

    struct Dev {
        vault: Vault,
        state: SyncState,
        api: Api,
        id: String,
        /// page states on (the release flag `pageState`) for this device
        ps: bool,
    }

    impl Dev {
        fn new(token: &str, id: &str) -> Dev {
            let root: PathBuf = std::env::temp_dir().join(format!("nevis-e2e-{}", uuid::Uuid::new_v4()));
            let vault = Vault::create_with_id(root, "E2E", id).unwrap();
            Dev { vault, state: SyncState::default(), api: Api::new(&server(), Some(token.to_string())).unwrap().quick(), id: id.to_string(), ps: false }
        }
        fn try_sync(&mut self) -> Res<Report> {
            crate::sync::pages::force_enabled(Some(self.ps));
            let mut hub = Hub::new(self.api.clone(), &self.id, self.state.hub.clone());
            let pre = hub.preflight("E2E", false)?;
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
        fn has_state(&self, id: &str) -> bool {
            crate::page_state::has_state(&self.vault.root, id)
        }
        fn titles(&self) -> Vec<String> {
            let mut t: Vec<String> = self.vault.pages_all().unwrap().iter().map(|p| p["title"].as_str().unwrap_or("").to_string()).collect();
            t.sort();
            t
        }
    }

    fn pair() -> (Dev, Dev) {
        let token = signup();
        let id = uuid::Uuid::new_v4().to_string();
        (Dev::new(&token, &id), Dev::new(&token, &id))
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

    // ---- randomized two-device test -------------------------------------------------------------------------------
    //
    // Random edits, deletes, syncs, offline stretches and "crashes" (the device forgets what its last sync recorded
    // while the files stay as they are) on two devices of one vault. Afterwards the devices sync until quiet and two
    // things must hold:
    //   1. both devices have the same files and no sync reported an error;
    //   2. no update was lost: every title that was written and never built upon (no later edit started from it, no
    //      delete removed it) is still somewhere in one of the two vaults: as the page, in its history or as a
    //      conflict copy. A title is a unique token, so "somewhere" is a byte search.
    // Run: NEVIS_TEST_SERVER=http://localhost:3111 NEVIS_FUZZ_SEEDS=50 cargo test e2e_random -- --ignored --nocapture
    // A failure prints its seed and the list of operations; NEVIS_FUZZ_START=<seed> NEVIS_FUZZ_SEEDS=1 replays it.

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    const FUZZ_PAGES: [&str; 3] = [P1, P2, "33333333-3333-4333-8333-333333333333"];
    const SYNCED_ROOTS: [&str; 7] = ["pages", "pages-state", "files", "history", "kv", ".trash", "databases"];

    fn all_files(root: &std::path::Path, only: Option<&[&str]>) -> std::collections::BTreeMap<String, Vec<u8>> {
        fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') && name.ends_with(".tmp") {
                    continue;
                }
                if p.is_dir() {
                    walk(root, &p, out);
                } else if let Ok(b) = std::fs::read(&p) {
                    out.insert(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), b);
                }
            }
        }
        let mut out = std::collections::BTreeMap::new();
        walk(root, root, &mut out);
        if let Some(only) = only {
            out.retain(|k, _| only.iter().any(|r| k == r || k.starts_with(&format!("{r}/"))));
        }
        out
    }

    /// The unique title tokens ("t17_") in some bytes.
    fn tokens_in(bytes: &[u8]) -> Vec<String> {
        let s = String::from_utf8_lossy(bytes);
        let b = s.as_bytes();
        let mut out = vec![];
        let mut i = 0;
        while i < b.len() {
            if b[i] == b't' && (i == 0 || !b[i - 1].is_ascii_alphanumeric()) {
                let mut j = i + 1;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j > i + 1 && j < b.len() && b[j] == b'_' {
                    out.push(s[i..=j].to_string());
                }
            }
            i += 1;
        }
        out
    }

    /// A page body of three paragraphs with fixed block ids (the same on every device).
    fn fuzz_doc(texts: &[String]) -> Value {
        let kids: Vec<Value> = texts
            .iter()
            .enumerate()
            .map(|(k, t)| {
                let mut p = json!({ "type": "paragraph", "attrs": { "blockId": format!("00000000-0000-4000-8000-00000000000{k}") } });
                if !t.is_empty() {
                    p["content"] = json!([{ "type": "text", "text": t }]);
                }
                p
            })
            .collect();
        json!({ "type": "doc", "attrs": { "blockIdentityVersion": 1 }, "content": kids })
    }

    static STATE_SEEDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static STRICT_CHECKED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static STATE_MERGES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn fuzz_once(token: &str, seed: u64, steps: usize) -> Vec<String> {
        // one account for the whole run (the server limits sign-ups), a new vault for each seed
        let id = uuid::Uuid::new_v4().to_string();
        let (mut devs, mut findings, mut log) = (vec![Dev::new(token, &id), Dev::new(token, &id)], Vec::<String>::new(), Vec::<String>::new());
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let (mut clock, mut counter) = (1_000i64, 0u32);
        let (mut written, mut killed) = (Vec::<String>::new(), std::collections::HashSet::<String>::new());
        // seed % 3: 0 = page states off (the legacy oracle), 1 = both devices on, 2 = dev 1 is a legacy device that turns them on mid-run
        let (mut state_tokens, mut deleted_ever) = (Vec::<(String, String)>::new(), std::collections::HashSet::<String>::new());
        // titles of pages that end up with a state are one key of the page map: the later write wins and the other is gone (by design)
        let mut lww_titles = std::collections::HashMap::<String, String>::new();
        let mut ever_state = std::collections::HashSet::<String>::new();
        let mode = std::env::var("NEVIS_FUZZ_MODE").ok().and_then(|m| m.parse::<u64>().ok()).unwrap_or(seed % 3);
        // what the page states add to the run draws from its own stream, so mode 0 replays the old fuzz exactly
        let mut prng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03) | 1);
        devs[0].ps = mode != 0;
        devs[1].ps = mode == 1;
        let flip = prng.below(steps.max(1));

        let sync = |devs: &mut Vec<Dev>, i: usize, crash: bool, log: &mut Vec<String>, findings: &mut Vec<String>| {
            let before = devs[i].state.clone();
            match devs[i].try_sync() {
                Ok(r) if !r.errors.is_empty() => findings.push(format!("sync errors on dev {i}: {:?}", r.errors)),
                Ok(r) => {
                    STATE_MERGES.fetch_add(r.state_merges, std::sync::atomic::Ordering::Relaxed);
                }
                Err(e) => findings.push(format!("sync failed on dev {i}: {e}")),
            }
            if crash {
                devs[i].state = before; // the files moved, the bookkeeping did not
            }
            log.push(format!("sync dev{i}{}", if crash { " (then crash: state lost)" } else { "" }));
        };

        let trace = std::env::var("NEVIS_FUZZ_TRACE").ok();
        let mut was_seen = false;
        for step in 0..steps {
            if mode == 2 && step == flip {
                devs[1].ps = true;
                log.push("dev1 turns page states on".to_string());
            }
            if let Some(watch) = &trace {
                // which devices hold the watched title, and where (a page, a history file, a conflict copy...)
                let mut where_ = vec![];
                for (n, d) in devs.iter().enumerate() {
                    for (path, bytes) in all_files(&d.vault.root, None) {
                        if tokens_in(&bytes).iter().any(|t| t == watch) {
                            where_.push(format!("dev{n}:{path}"));
                        }
                    }
                }
                if !where_.is_empty() || was_seen {
                    eprintln!("  [trace] before step {step} (after: {}): {watch} is in {where_:?}", log.last().cloned().unwrap_or_default());
                }
                was_seen |= !where_.is_empty();
            }
            for id in FUZZ_PAGES {
                if devs.iter().any(|d| d.has_state(id)) {
                    ever_state.insert(id.to_string());
                }
            }
            let i = rng.below(2);
            match rng.below(10) {
                0..=3 => {
                    let id = FUZZ_PAGES[rng.below(FUZZ_PAGES.len())];
                    let current = devs[i].page(id);
                    let parent = current.as_ref().map(|p| p["title"].as_str().unwrap_or("").to_string());
                    let had_state = devs[i].has_state(id);
                    counter += 1;
                    clock += 10;
                    let token = format!("t{counter}_");
                    // a ProseMirror document of three paragraphs with fixed block ids; the token goes into one paragraph or the title
                    let mut texts: Vec<String> = (0..3).map(|k| current.as_ref().and_then(|p| p["content"]["content"][k]["content"][0]["text"].as_str()).unwrap_or("").to_string()).collect();
                    let target = if mode == 0 { 3 } else { prng.below(5) };
                    let mut title = parent.clone().unwrap_or_else(|| "p".to_string());
                    if target >= 3 {
                        title = token.clone();
                    } else {
                        texts[target] = format!("{} {token}", texts[target]);
                    }
                    let page = json!({ "id": id, "title": &title, "content": if mode == 0 { json!({"type":"doc","content":[]}) } else { fuzz_doc(&texts) }, "updatedAt": clock, "deletedAt": null });
                    match devs[i].vault.save_pages(&[page], &[], false) {
                        Ok(_) => {
                            written.push(token.clone());
                            if target >= 3 {
                                lww_titles.insert(token.clone(), id.to_string());
                                if let Some(p) = parent {
                                    killed.insert(p);
                                }
                            } else if had_state {
                                state_tokens.push((token.clone(), id.to_string()));
                            }
                            log.push(format!("dev{i} writes {token} to {} ({})", &id[..2], if target >= 3 { "title".to_string() } else { format!("paragraph {target}") }));
                        }
                        Err(e) => log.push(format!("dev{i} write to {} refused: {e}", &id[..2])),
                    }
                }
                4 => {
                    let id = FUZZ_PAGES[rng.below(FUZZ_PAGES.len())];
                    if let Some(p) = devs[i].page(id) {
                        killed.insert(p["title"].as_str().unwrap_or("").to_string());
                        // deleting a page deletes its history on this device too: everything the user could see there goes
                        for (path, bytes) in all_files(&devs[i].vault.root, None) {
                            if path.contains(id) {
                                killed.extend(tokens_in(&bytes));
                            }
                        }
                        devs[i].vault.save_pages(&[], &[id.to_string()], false).unwrap();
                        deleted_ever.insert(id.to_string());
                        log.push(format!("dev{i} deletes {}", &id[..2]));
                    }
                }
                5..=7 => sync(&mut devs, i, false, &mut log, &mut findings),
                8 => sync(&mut devs, i, std::env::var("NEVIS_FUZZ_NOCRASH").is_err(), &mut log, &mut findings),
                _ => {
                    sync(&mut devs, i, false, &mut log, &mut findings);
                    sync(&mut devs, 1 - i, false, &mut log, &mut findings);
                }
            }
        }

        // quiet: sync until nothing moves. Deletions the engine holds back wait for the user's confirmation; here the
        // "user" confirms once the devices are quiet, and the hold itself is reported as a NOTE.
        let mut held = false;
        for round in 0..12 {
            let mut moved = false;
            if round >= 6 && held {
                if round == 6 {
                    findings.push("NOTE: a deletion was held back for the user's confirmation (the deleted page stayed on a device until then)".into());
                }
                // every device asks again: the confirmation is used up by one sync
                for d in devs.iter_mut() {
                    d.state.allow_deletes_once = true;
                }
            }
            for i in 0..2 {
                match devs[i].try_sync() {
                    Ok(r) => {
                        held |= r.held > 0;
                        STATE_MERGES.fetch_add(r.state_merges, std::sync::atomic::Ordering::Relaxed);
                        moved |= r.changed() || r.skipped > 0 || (r.held > 0 && round < 6);
                        if !r.errors.is_empty() {
                            findings.push(format!("sync errors at the end, dev {i}: {:?}", r.errors));
                        }
                    }
                    Err(e) => findings.push(format!("sync failed at the end, dev {i}: {e}")),
                }
            }
            if !moved && !(held && round < 6) {
                break;
            }
            if round == 11 {
                findings.push("the devices never went quiet in 12 rounds (sync ping-pong)".into());
            }
        }

        let (fa, fb) = (all_files(&devs[0].vault.root, Some(&SYNCED_ROOTS)), all_files(&devs[1].vault.root, Some(&SYNCED_ROOTS)));
        for k in fa.keys().chain(fb.keys()).collect::<std::collections::BTreeSet<_>>() {
            match (fa.get(k), fb.get(k)) {
                (Some(x), Some(y)) if x != y => {
                    let brief = |b: &Vec<u8>| String::from_utf8_lossy(&b[..b.len().min(160)]).replace('\n', " ");
                    let st = |i: usize| format!("entry={:?} mirror={:?} local_md5={}", devs[i].state.files.get(k.as_str()), devs[i].state.hub.files.get(k.as_str()), crate::sync::md5_hex(if i == 0 { x } else { y }));
                    findings.push(format!("DIVERGED: {k} differs between the devices\n    dev0: {}\n      {}\n    dev1: {}\n      {}", brief(x), st(0), brief(y), st(1)))
                }
                (Some(_), None) => findings.push(format!("DIVERGED: {k} only on dev 0")),
                (None, Some(_)) => findings.push(format!("DIVERGED: {k} only on dev 1")),
                _ => {}
            }
        }
        // page states: the derived JSON is the projection of the state, and no paragraph edit made on a page that had a state is lost
        for (n, d) in devs.iter().enumerate() {
            for id in FUZZ_PAGES {
                let Ok(bin) = std::fs::read(d.vault.root.join(format!("pages-state/{id}.bin"))) else { continue };
                let projected = crate::page_state::State::from_blob(&bin).map(|s| s.project());
                let file = std::fs::read(d.vault.root.join(format!("pages/{id}.json"))).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
                match (projected, file) {
                    (Ok(p), Some(f)) if crate::page_state::canon_page(&p) == crate::page_state::canon_page(&f) => {}
                    (Ok(_), f) => findings.push(format!("dev{n}: pages/{id}.json is not the projection of its state ({})", if f.is_some() { "differs" } else { "missing" })),
                    (Err(e), _) => findings.push(format!("dev{n}: state of {id} unreadable: {e}")),
                }
            }
        }
        if FUZZ_PAGES.iter().any(|id| devs.iter().all(|d| d.has_state(id))) {
            STATE_SEEDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        for (t, id) in &state_tokens {
            let both = devs.iter().all(|d| d.has_state(id));
            if deleted_ever.contains(id) || !both {
                continue;
            }
            STRICT_CHECKED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            for (n, d) in devs.iter().enumerate() {
                let text = std::fs::read_to_string(d.vault.root.join(format!("pages/{id}.json"))).unwrap_or_default();
                if !text.contains(t.as_str()) {
                    findings.push(format!("LOST FROM STATE: {t} was written into a paragraph of {} that had a state and is missing from dev{n}'s page", &id[..2]));
                }
            }
        }
        let everything: Vec<Vec<u8>> = (0..2).flat_map(|i| all_files(&devs[i].vault.root, None).into_values()).collect();
        for t in written.iter().filter(|t| !killed.contains(*t) && !lww_titles.get(*t).is_some_and(|id| ever_state.contains(id))) {
            if !everything.iter().any(|b| b.windows(t.len()).any(|w| w == t.as_bytes())) {
                findings.push(format!("LOST UPDATE: {t} was written, never built upon, and is nowhere in either vault"));
            }
        }
        if findings.iter().any(|f| !f.starts_with("NOTE")) {
            findings.push(format!("operations:\n  {}", log.join("\n  ")));
        }
        findings
    }

    #[test]
    #[ignore]
    fn e2e_random_edits_deletes_syncs_and_crashes_on_two_devices_lose_nothing() {
        let env = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (start, seeds, steps) = (env("NEVIS_FUZZ_START", 1), env("NEVIS_FUZZ_SEEDS", 10), env("NEVIS_FUZZ_STEPS", 30) as usize);
        let (mut bad, mut notes) = (vec![], 0);
        // the server limits requests per device token (1500 a minute) and sign-ups per hour (120): a new account every few seeds
        let mut token = String::new();
        for seed in start..start + seeds {
            if (seed - start) % 4 == 0 {
                token = signup();
            }
            let f = fuzz_once(&token, seed, steps);
            if f.iter().any(|x| x.starts_with("NOTE")) {
                notes += 1;
            }
            if f.iter().any(|x| !x.starts_with("NOTE")) {
                eprintln!("seed {seed} FAILED:\n  {}\n", f.join("\n  "));
                bad.push(seed);
            }
        }
        eprintln!("{seeds} seeds, {} failed, {notes} had a deletion held back for confirmation", bad.len());
        let o = std::sync::atomic::Ordering::Relaxed;
        eprintln!("page states: {} seeds ended with a state on both devices, {} paragraph tokens checked by the strict oracle, {} state merges", STATE_SEEDS.load(o), STRICT_CHECKED.load(o), STATE_MERGES.load(o));
        assert!(bad.is_empty(), "failing seeds: {bad:?}");
    }
}
