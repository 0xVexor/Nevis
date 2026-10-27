//! GitHub App device authentication + a Git Database snapshot provider. No application secrets.
use super::snapshot::{self, Bundle, Files};
use crate::vault::{err, now_ms, write_atomic, Res};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::{
    blocking::{Client, Response},
    Method, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

// Serialize provider transitions and refresh-token rotation, but never hold the vault lock over network I/O.
pub static OPERATION: Mutex<()> = Mutex::new(());
const SERVICE: &str = match option_env!("NOVIQ_GITHUB_CREDENTIAL_SERVICE") {
    Some(service) => service,
    None => "app.noviq.github",
};
fn client_id() -> Res<&'static str> {
    option_env!("NOVIQ_GITHUB_CLIENT_ID")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "GITHUB:app_not_configured".into())
}
fn client() -> Res<Client> {
    Client::builder()
        .user_agent("Noviq-personal-vaults/1")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "GITHUB:network".into())
}
fn secret() -> Res<keyring::Entry> {
    keyring::Entry::new(SERVICE, "user-token")
        .map_err(|_| "GITHUB:secure_storage_unavailable".into())
}
#[derive(Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    user_id: u64,
    login: String,
}
fn tokens() -> Res<Tokens> {
    serde_json::from_str(
        &secret()?
            .get_password()
            .map_err(|_| "GITHUB:sign_in_required")?,
    )
    .map_err(|_| "GITHUB:sign_in_required".into())
}
fn store_tokens(t: &Tokens) -> Res<()> {
    secret()?
        .set_password(&serde_json::to_string(t).map_err(err)?)
        .map_err(|_| "GITHUB:secure_storage_unavailable".into())
}
fn oauth(path: &str, form: &[(&str, &str)]) -> Res<Value> {
    let r = client()?
        .post(format!("https://github.com/login/{path}"))
        .header("Accept", "application/json")
        .form(form)
        .send()
        .map_err(|_| "GITHUB:network")?;
    if !r.status().is_success() {
        return Err(format!("GITHUB:oauth_http_{}", r.status().as_u16()));
    }
    r.json().map_err(|_| "GITHUB:invalid_response".into())
}
#[derive(Serialize, Deserialize)]
struct Device {
    code: String,
    interval: i64,
    expires: i64,
    next: i64,
}
// Device codes are transient secrets: keep in memory, never write them to disk.
static DEVICE: Mutex<Option<Device>> = Mutex::new(None);
pub fn begin() -> Res<Value> {
    let v = oauth("device/code", &[("client_id", client_id()?)])?;
    if let Some(e) = v["error"].as_str() {
        return Err(format!("GITHUB:{e}"));
    }
    let interval = v["interval"].as_i64().unwrap_or(5).max(5);
    *DEVICE.lock().map_err(err)? = Some(Device {
        code: field(&v, "device_code")?.into(),
        interval,
        expires: now_ms() + v["expires_in"].as_i64().unwrap_or(900) * 1000,
        next: now_ms() + interval * 1000,
    });
    Ok(
        json!({"userCode":field(&v,"user_code")?,"verificationUri":"https://github.com/login/device","interval":interval,"expiresIn":v["expires_in"]}),
    )
}
pub fn poll() -> Res<Value> {
    let mut d = DEVICE.lock().map_err(err)?;
    let flow = d.as_mut().ok_or("GITHUB:device_expired")?;
    if now_ms() >= flow.expires {
        *d = None;
        return Err("GITHUB:device_expired".into());
    }
    if now_ms() < flow.next {
        return Ok(json!({"pending":true,"interval":flow.interval}));
    }
    let v = oauth(
        "oauth/access_token",
        &[
            ("client_id", client_id()?),
            ("device_code", &flow.code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )?;
    if let Some(e) = v["error"].as_str() {
        if e == "authorization_pending" || e == "slow_down" {
            if e == "slow_down" {
                flow.interval = v["interval"]
                    .as_i64()
                    .unwrap_or(flow.interval + 5)
                    .max(flow.interval + 5);
            }
            flow.next = now_ms() + flow.interval * 1000;
            return Ok(json!({"pending":true,"interval":flow.interval}));
        }
        *d = None;
        return Err(format!("GITHUB:{e}"));
    }
    let access = field(&v, "access_token")?;
    let mut api = Api::new(access.into())?;
    let user = api.get("/user")?;
    let t = Tokens {
        access_token: access.into(),
        refresh_token: field(&v, "refresh_token")?.into(),
        expires_at: now_ms() + v["expires_in"].as_i64().unwrap_or(28800) * 1000,
        user_id: user["id"].as_u64().ok_or("GITHUB:invalid_response")?,
        login: field(&user, "login")?.into(),
    };
    if let Ok(old) = tokens() {
        if old.user_id != t.user_id {
            return Err("GITHUB:disconnect_before_account_switch".into());
        }
    }
    store_tokens(&t)?;
    *d = None;
    Ok(json!({"pending":false,"login":t.login}))
}
pub fn cancel() {
    if let Ok(mut d) = DEVICE.lock() {
        *d = None;
    }
}
pub fn disconnect() -> Res<()> {
    cancel();
    match secret()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("GITHUB:secure_storage_unavailable".into()),
    }
}
fn api() -> Res<Api> {
    let mut t = tokens()?;
    if t.expires_at < now_ms() + 60_000 {
        let v = oauth(
            "oauth/access_token",
            &[
                ("client_id", client_id()?),
                ("refresh_token", &t.refresh_token),
                ("grant_type", "refresh_token"),
            ],
        )?;
        if v.get("error").is_some() {
            return Err("GITHUB:sign_in_required".into());
        }
        t.access_token = field(&v, "access_token")?.into();
        t.refresh_token = field(&v, "refresh_token")?.into();
        t.expires_at = now_ms() + v["expires_in"].as_i64().unwrap_or(28800) * 1000;
        store_tokens(&t)?;
    }
    Api::new(t.access_token)
}
fn field<'a>(v: &'a Value, k: &str) -> Res<&'a str> {
    v[k].as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "GITHUB:invalid_response".into())
}
struct Api {
    client: Client,
    token: String,
    last_write: Option<Instant>,
    base: String,
}
impl Api {
    fn new(token: String) -> Res<Self> {
        Ok(Self {
            client: client()?,
            token,
            last_write: None,
            base: "https://api.github.com".into(),
        })
    }
    fn request(&mut self, m: Method, path: &str, body: Option<&Value>) -> Res<Response> {
        if m != Method::GET {
            if let Some(t) = self.last_write {
                let wait = Duration::from_millis(850).saturating_sub(t.elapsed());
                std::thread::sleep(wait);
            }
            self.last_write = Some(Instant::now());
        }
        let mut r = self
            .client
            .request(m, format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2026-03-10");
        if let Some(b) = body {
            r = r.json(b);
        }
        let r = r.send().map_err(|_| "GITHUB:network")?;
        if r.status().is_success() {
            return Ok(r);
        }
        let retry = r
            .headers()
            .get("retry-after")
            .and_then(|x| x.to_str().ok())
            .and_then(|x| x.parse::<u64>().ok());
        let exhausted = r
            .headers()
            .get("x-ratelimit-remaining")
            .is_some_and(|x| x == "0");
        if retry.is_some() || exhausted || r.status() == StatusCode::TOO_MANY_REQUESTS {
            let reset = r
                .headers()
                .get("x-ratelimit-reset")
                .and_then(|x| x.to_str().ok())
                .and_then(|x| x.parse::<i64>().ok())
                .map(|t| (t - now_ms() / 1000).max(60) as u64);
            return Err(format!(
                "GITHUB:rate_limited:{}",
                retry.or(reset).unwrap_or(60)
            ));
        }
        Err(match r.status().as_u16() {
            401 => "GITHUB:sign_in_required".into(),
            403 => "GITHUB:permission_or_branch_policy".into(),
            404 => "GITHUB:not_found_or_access_revoked".into(),
            422 if path == "/user/repos" => "GITHUB:repository_name_unavailable".into(),
            409 | 422 => "GITHUB:head_changed_or_branch_policy".into(),
            n => format!("GITHUB:http_{n}"),
        })
    }
    fn get(&mut self, p: &str) -> Res<Value> {
        self.request(Method::GET, p, None)?
            .json()
            .map_err(|_| "GITHUB:invalid_response".into())
    }
    fn post(&mut self, p: &str, v: &Value) -> Res<Value> {
        self.request(Method::POST, p, Some(v))?
            .json()
            .map_err(|_| "GITHUB:invalid_response".into())
    }
}
#[derive(Serialize, Deserialize, Clone)]
pub struct Binding {
    pub owner: String,
    pub owner_id: u64,
    pub repo: String,
    pub repo_id: u64,
    pub branch: String,
    pub vault: String,
    #[serde(default = "quiet")]
    pub quiet_seconds: u64,
    #[serde(default = "poll_seconds")]
    pub poll_seconds: u64,
    pub backup: String,
}
fn quiet() -> u64 {
    15
}
fn poll_seconds() -> u64 {
    120
}
fn dir(data: &Path, id: &str) -> PathBuf {
    data.join("github").join(id)
}
pub fn binding(data: &Path, id: &str) -> Res<Option<Binding>> {
    crate::vault::check_id(id)?;
    match fs::read(dir(data, id).join("binding.json")) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|_| "GITHUB:binding_corrupt".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
pub fn enabled(data: &Path, id: &str) -> bool {
    dir(data, id).join("binding.json").exists()
}
pub fn status(data: &Path, id: &str) -> Res<Value> {
    let t = tokens().ok();
    let b = binding(data, id)?;
    Ok(
        json!({"configured":client_id().is_ok() && option_env!("NOVIQ_GITHUB_APP_SLUG").is_some_and(|s|!s.is_empty()),"signedIn":t.is_some(),"login":t.map(|t|t.login),"binding":b,"installationUrl":option_env!("NOVIQ_GITHUB_APP_SLUG").map(|s|format!("https://github.com/apps/{s}/installations/new"))}),
    )
}
fn component(s: &str) -> Res<&str> {
    if s.is_empty()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || s == "."
        || s == ".."
    {
        Err("GITHUB:invalid_repository".into())
    } else {
        Ok(s)
    }
}
fn repo_path(b: &Binding) -> String {
    format!("/repos/{}/{}", b.owner, b.repo)
}
fn verify(a: &mut Api, b: &Binding) -> Res<Value> {
    let r = a.get(&repo_path(b))?;
    if r["id"].as_u64() != Some(b.repo_id)
        || r["owner"]["id"].as_u64() != Some(b.owner_id)
        || r["private"] != true
        || r["archived"] == true
    {
        return Err("GITHUB:repository_identity_or_privacy_changed".into());
    }
    Ok(r)
}
/// Prepare connection only. The caller must take a verified local backup before persisting this binding.
pub fn prepare(vault: &str, name: &str, create: bool, initialize: bool) -> Res<Binding> {
    component(name)?;
    let mut a = api()?;
    let user = a.get("/user")?;
    let owner = field(&user, "login")?;
    component(owner)?;
    let r = if create {
        a.post("/user/repos",&json!({"name":name,"private":true,"auto_init":true,"description":"Noviq personal vault data"}))?
    } else {
        a.get(&format!("/repos/{owner}/{name}"))?
    };
    let b = Binding {
        owner: owner.into(),
        owner_id: user["id"].as_u64().ok_or("GITHUB:invalid_response")?,
        repo: name.into(),
        repo_id: r["id"].as_u64().ok_or("GITHUB:invalid_response")?,
        branch: field(&r, "default_branch")?.into(),
        vault: vault.into(),
        quiet_seconds: 15,
        poll_seconds: 120,
        backup: String::new(),
    };
    verify(&mut a, &b)?;
    // Ref must be readable. Newly created repositories use auto_init; never treat a 404 as an empty repository.
    if let Err(e) = a.get(&format!("{}/git/ref/heads/{}", repo_path(&b), b.branch)) {
        if !initialize || r["size"].as_u64() != Some(0) {
            return Err(e);
        }
        a.request(Method::PUT,&format!("{}/contents/README.md",repo_path(&b)),Some(&json!({"message":"Initialize Noviq data repository","content":B64.encode(b"# Noviq personal vaults\n"),"branch":b.branch})))?;
        a.get(&format!("{}/git/ref/heads/{}", repo_path(&b), b.branch))?;
    }
    Ok(b)
}
pub fn save_binding(data: &Path, b: &Binding) -> Res<()> {
    write_atomic(
        &dir(data, &b.vault).join("binding.json"),
        &serde_json::to_vec(b).map_err(err)?,
    )
}
pub fn detach(data: &Path, id: &str) -> Res<()> {
    let p = dir(data, id).join("binding.json");
    if p.exists() {
        fs::rename(
            &p,
            p.with_extension(format!("disconnected-{}.json", now_ms())),
        )
        .map_err(err)?;
    }
    Ok(())
}
// Download a single pinned tarball instead of one request per page. No extraction to the filesystem.
fn archive(a: &mut Api, b: &Binding, head: &str) -> Res<BTreeMap<String, Vec<u8>>> {
    let r = a.request(
        Method::GET,
        &format!("{}/tarball/{head}", repo_path(b)),
        None,
    )?;
    let gzip = flate2::read::GzDecoder::new(r.take(snapshot::MAX_SNAPSHOT as u64 + 1));
    let mut archive = tar::Archive::new(gzip.take(snapshot::MAX_SNAPSHOT as u64 + 1));
    let mut out = BTreeMap::new();
    let mut total = 0usize;
    let mut count = 0;
    for entry in archive.entries().map_err(|_| "GITHUB:invalid_archive")? {
        let mut e = entry.map_err(|_| "GITHUB:invalid_archive")?;
        count += 1;
        if count > 200_000 {
            return Err("SYNC:too_large".into());
        }
        let p = e.path().map_err(err)?.to_string_lossy().to_string();
        let Some((_, relative)) = p.split_once('/') else {
            continue;
        };
        if !relative.starts_with("vaults/") {
            continue;
        }
        if e.header().entry_type().is_dir() {
            continue;
        }
        if !e.header().entry_type().is_file() {
            return Err("GITHUB:unsafe_archive".into());
        }
        if e.size() > snapshot::MAX_FILE as u64 {
            return Err("SYNC:too_large".into());
        }
        let mut bytes = Vec::new();
        e.read_to_end(&mut bytes).map_err(err)?;
        total += bytes.len();
        if total > snapshot::MAX_SNAPSHOT {
            return Err("SYNC:too_large".into());
        }
        if out.insert(relative.into(), bytes).is_some() {
            return Err("GITHUB:duplicate_archive_path".into());
        }
    }
    Ok(out)
}
fn remote_bundle(archive: &BTreeMap<String, Vec<u8>>, id: &str) -> Res<Bundle> {
    let prefix = format!("vaults/{id}/");
    let Some(raw) = archive.get(&format!("{prefix}manifest.json")) else {
        if archive.keys().any(|p| p.starts_with(&prefix)) {
            return Err("SYNC:manifest_missing".into());
        }
        return Ok(Bundle::new(id, &Files::new(), BTreeSet::new()));
    };
    let manifest: snapshot::Snapshot =
        serde_json::from_slice(raw).map_err(|_| "SYNC:manifest_corrupt")?;
    if manifest.vault != id {
        return Err("VAULT_MISMATCH".into());
    }
    let mut bytes = BTreeMap::new();
    for p in manifest.files.keys() {
        snapshot::safe_path(p)?;
        bytes.insert(
            p.clone(),
            B64.encode(
                archive
                    .get(&format!("{prefix}{p}"))
                    .ok_or("SYNC:incomplete_snapshot")?,
            ),
        );
    }
    let bundle = Bundle { manifest, bytes };
    bundle.decode()?;
    Ok(bundle)
}
pub fn list_vaults(data: &Path, repo: &str) -> Res<Value> {
    let b = prepare("browse", repo, false, false)?;
    let mut a = api()?;
    let head = a.get(&format!("{}/git/ref/heads/{}", repo_path(&b), b.branch))?;
    let archive = archive(&mut a, &b, field(&head["object"], "sha")?)?;
    let mut rows = vec![];
    for p in archive.keys().filter(|p| p.ends_with("/manifest.json")) {
        if let Some(id) = p
            .strip_prefix("vaults/")
            .and_then(|s| s.strip_suffix("/manifest.json"))
        {
            crate::vault::check_id(id)?;
            let s = remote_bundle(&archive, id)?;
            rows.push(
                json!({"id":id,"name":s.decode()?.get("kv/workspace.json").and_then(|b|serde_json::from_slice::<Value>(b).ok()).and_then(|v|v["name"].as_str().map(str::to_string)),"files":s.manifest.files.len(),"connectedHere":enabled(data,id)}),
            );
        }
    }
    Ok(json!(rows))
}
/// Provider transitions and token refresh rotate under the same lock.
pub fn run(
    data: &Path,
    b: &Binding,
    capture: impl FnMut() -> Res<Bundle>,
    apply: impl FnMut(&Bundle, &Bundle) -> Res<()>,
) -> Res<usize> {
    let _guard = OPERATION.lock().map_err(err)?;
    run_unlocked(data, b, true, capture, apply)
}
pub fn run_unlocked(
    data: &Path,
    b: &Binding,
    allow_create: bool,
    capture: impl FnMut() -> Res<Bundle>,
    apply: impl FnMut(&Bundle, &Bundle) -> Res<()>,
) -> Res<usize> {
    let mut provider = GitHubProvider {
        api: api()?,
        binding: b.clone(),
        user_id: tokens()?.user_id,
    };
    super::provider::synchronize(
        &mut provider,
        &b.vault,
        &dir(data, &b.vault).join(b.repo_id.to_string()),
        allow_create,
        capture,
        apply,
    )
}
pub fn download_unlocked(
    data: &Path,
    b: &Binding,
    capture: impl FnMut() -> Res<Bundle>,
    apply: impl FnMut(&Bundle, &Bundle) -> Res<()>,
) -> Res<usize> {
    let mut provider = GitHubProvider {
        api: api()?,
        binding: b.clone(),
        user_id: tokens()?.user_id,
    };
    super::provider::initialize_from_remote(
        &mut provider,
        &b.vault,
        &dir(data, &b.vault).join(b.repo_id.to_string()),
        capture,
        apply,
    )
}
struct GitHubProvider {
    api: Api,
    binding: Binding,
    user_id: u64,
}
impl super::provider::SnapshotProvider for GitHubProvider {
    fn capabilities(&self) -> super::provider::Capabilities {
        super::provider::Capabilities {
            conditional_publish: true,
            max_file_bytes: snapshot::MAX_FILE,
        }
    }
    fn check(&mut self) -> Res<()> {
        verify(&mut self.api, &self.binding)?;
        if self.user_id != self.binding.owner_id {
            return Err("GITHUB:account_mismatch".into());
        }
        Ok(())
    }
    fn head(&mut self) -> Res<String> {
        let b = &self.binding;
        let h = self
            .api
            .get(&format!("{}/git/ref/heads/{}", repo_path(b), b.branch))?;
        Ok(field(&h["object"], "sha")?.into())
    }
    fn read(&mut self, known: Option<&super::provider::Pinned>) -> Res<super::provider::Pinned> {
        let head = self.head()?;
        if let Some(known) = known {
            if known.revision == head {
                return Ok(known.clone());
            }
        }
        let files = archive(&mut self.api, &self.binding, &head)?;
        Ok(super::provider::Pinned {
            revision: head,
            snapshot: remote_bundle(&files, &self.binding.vault)?,
        })
    }
    fn published(&mut self, candidate: &str, head: &str) -> Res<bool> {
        if candidate == head {
            return Ok(true);
        }
        let compare = self.api.get(&format!(
            "{}/compare/{candidate}...{head}",
            repo_path(&self.binding)
        ))?;
        Ok(matches!(
            compare["status"].as_str(),
            Some("ahead" | "identical")
        ))
    }
    fn stage(&mut self, pinned: &super::provider::Pinned, merged: &Bundle) -> Res<String> {
        let a = &mut self.api;
        let b = &self.binding;
        let remote = &pinned.snapshot;
        let commit = a.get(&format!("{}/git/commits/{}", repo_path(b), pinned.revision))?;
        let prefix = format!("vaults/{}/", b.vault);
        let mut changes = vec![];
        for (p, bytes) in merged.decode()? {
            if remote.manifest.files.get(&p) == merged.manifest.files.get(&p) {
                continue;
            }
            let path = format!("{prefix}{p}");
            if let Ok(text) = std::str::from_utf8(&bytes) {
                if bytes.len() < 64 * 1024 {
                    changes.push(json!({"path":path,"mode":"100644","type":"blob","content":text}));
                    continue;
                }
            }
            let blob = a.post(
                &format!("{}/git/blobs", repo_path(b)),
                &json!({"content":B64.encode(&bytes),"encoding":"base64"}),
            )?;
            changes
                .push(json!({"path":path,"mode":"100644","type":"blob","sha":field(&blob,"sha")?}));
        }
        for p in remote
            .manifest
            .files
            .keys()
            .filter(|p| !merged.manifest.files.contains_key(*p))
        {
            changes.push(
                json!({"path":format!("{prefix}{p}"),"mode":"100644","type":"blob","sha":null}),
            );
        }
        changes.push(json!({"path":format!("{prefix}manifest.json"),"mode":"100644","type":"blob","content":String::from_utf8(snapshot::canonical(&serde_json::to_value(&merged.manifest).map_err(err)?)?).map_err(err)?}));
        let mut tree = field(&commit["tree"], "sha")?.to_string();
        // Bound tree payloads. Ordinary 10k-page vaults use batches rather than one call per page.
        for chunk in changes.chunks(80) {
            let t = a.post(
                &format!("{}/git/trees", repo_path(b)),
                &json!({"base_tree":tree,"tree":chunk}),
            )?;
            tree = field(&t, "sha")?.into();
        }
        let c = a.post(
            &format!("{}/git/commits", repo_path(b)),
            &json!({"message":"Sync Noviq vault","tree":tree,"parents":[pinned.revision]}),
        )?;
        Ok(field(&c, "sha")?.into())
    }
    fn publish(&mut self, candidate: &str) -> Res<()> {
        self.check()?;
        let b = &self.binding;
        self.api.request(
            Method::PATCH,
            &format!("{}/git/refs/heads/{}", repo_path(b), b.branch),
            Some(&json!({"sha":candidate,"force":false})),
        )?;
        Ok(())
    }
}

pub fn open_browser(target: &str) -> Res<()> {
    let url = match target {
        "device" => "https://github.com/login/device".to_string(),
        "install" => {
            let slug = option_env!("NOVIQ_GITHUB_APP_SLUG").ok_or("GITHUB:app_not_configured")?;
            component(slug)?;
            format!("https://github.com/apps/{slug}/installations/new")
        }
        "settings" => "https://github.com/settings/installations".to_string(),
        _ => return Err("GITHUB:invalid_browser_target".into()),
    };
    #[cfg(target_os = "macos")]
    let mut c = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut c = {
        let mut x = std::process::Command::new("rundll32");
        x.arg("url.dll,FileProtocolHandler");
        x
    };
    #[cfg(target_os = "linux")]
    let mut c = std::process::Command::new("xdg-open");
    c.arg(url)
        .spawn()
        .map_err(|_| "GITHUB:browser_unavailable")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::provider::SnapshotProvider;
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn binding() -> Binding {
        Binding {
            owner: "me".into(),
            owner_id: 7,
            repo: "data".into(),
            repo_id: 8,
            branch: "main".into(),
            vault: "v".into(),
            quiet_seconds: 15,
            poll_seconds: 120,
            backup: String::new(),
        }
    }
    fn server(replies: Vec<(u16, Value)>) -> (Api, std::thread::JoinHandle<Vec<(String, Value)>>) {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", socket.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut requests = vec![];
            for (status, body) in replies {
                let (mut stream, _) = socket.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = vec![];
                let mut chunk = [0u8; 4096];
                let header_end = loop {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..header_end]).to_string();
                let len = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + len {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                }
                let body_in = if len > 0 {
                    serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap()
                } else {
                    Value::Null
                };
                requests.push((headers.lines().next().unwrap().to_string(), body_in));
                let text = body.to_string();
                write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",text.len()).unwrap();
            }
            requests
        });
        let api = Api {
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            token: "test-token".into(),
            last_write: None,
            base,
        };
        (api, thread)
    }
    #[test]
    fn git_publication_uses_pinned_parent_preserved_tree_and_nonforce_ref() {
        let metadata = json!({"id":8,"owner":{"id":7},"private":true,"archived":false});
        let (api, thread) = server(vec![
            (200, json!({"tree":{"sha":"tree-H"}})),
            (201, json!({"sha":"tree-new"})),
            (201, json!({"sha":"commit-new"})),
            (200, metadata),
            (200, json!({})),
        ]);
        let mut p = GitHubProvider {
            api,
            binding: binding(),
            user_id: 7,
        };
        let empty = Bundle::new("v", &Files::new(), BTreeSet::new());
        let pinned = super::super::provider::Pinned {
            revision: "H".into(),
            snapshot: empty.clone(),
        };
        assert_eq!(p.stage(&pinned, &empty).unwrap(), "commit-new");
        p.publish("commit-new").unwrap();
        let requests = thread.join().unwrap();
        assert!(requests[0].0.contains("/git/commits/H "));
        assert_eq!(requests[1].1["base_tree"], "tree-H");
        assert_eq!(requests[2].1["parents"], json!(["H"]));
        assert_eq!(requests[4].1["force"], false);
        assert_eq!(requests[4].1["sha"], "commit-new");
    }
    #[test]
    fn public_repository_stops_before_any_upload() {
        let (api, thread) = server(vec![(
            200,
            json!({"id":8,"owner":{"id":7},"private":false}),
        )]);
        let mut p = GitHubProvider {
            api,
            binding: binding(),
            user_id: 7,
        };
        assert_eq!(
            p.check().unwrap_err(),
            "GITHUB:repository_identity_or_privacy_changed"
        );
        assert_eq!(thread.join().unwrap().len(), 1);
    }
    #[test]
    fn unchanged_head_reuses_verified_checkpoint_without_archive_requests() {
        let (api, thread) = server(vec![(200, json!({"object":{"sha":"H"}}))]);
        let mut p = GitHubProvider {
            api,
            binding: binding(),
            user_id: 7,
        };
        let known = super::super::provider::Pinned {
            revision: "H".into(),
            snapshot: Bundle::new("v", &Files::new(), BTreeSet::new()),
        };
        assert_eq!(p.read(Some(&known)).unwrap().revision, "H");
        assert_eq!(thread.join().unwrap().len(), 1);
    }
    #[test]
    fn incomplete_or_corrupt_archive_inventory_is_never_an_empty_snapshot() {
        let mut a = BTreeMap::new();
        let m = snapshot::Snapshot {
            format: 1,
            vault: "v".into(),
            files: BTreeMap::from([("pages/p.json".into(), "hash".into())]),
            tombstones: BTreeSet::new(),
        };
        a.insert(
            "vaults/v/manifest.json".into(),
            serde_json::to_vec(&m).unwrap(),
        );
        assert!(remote_bundle(&a, "v").is_err());
        a.clear();
        a.insert("vaults/v/pages/p.json".into(), b"{}".to_vec());
        assert!(remote_bundle(&a, "v").is_err());
    }
    #[test]
    fn api_errors_never_expose_response_body_tokens() {
        let (mut api, thread) = server(vec![(
            401,
            json!({"message":"secret-token-do-not-display"}),
        )]);
        let error = api.get("/user").unwrap_err();
        assert_eq!(error, "GITHUB:sign_in_required");
        assert!(!error.contains("secret-token"));
        thread.join().unwrap();
    }
}
