//! GitHub release discovery and signed, user-approved desktop updates.
use tauri::Manager;
use std::{cmp::Ordering, time::Duration};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES: &str = "https://api.github.com/repos/0xVexor/Nevis/releases";
const DOWNLOADS: &str = "https://github.com/0xVexor/Nevis/releases/download/";

#[derive(Default)]
pub struct Updates(pub tauri::async_runtime::Mutex<Option<Pending>>);
pub struct Pending {
    update: Update,
    bytes: Option<Vec<u8>>,
}

#[derive(Clone, Deserialize)]
struct Asset { name: String, browser_download_url: String }
#[derive(Clone, Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<Asset>,
}
impl Release {
    fn version(&self) -> Option<Version> {
        Version::parse(self.tag_name.strip_prefix('v').unwrap_or(&self.tag_name)).ok()
    }
    fn manifest(&self) -> Option<&str> {
        let expected = format!("{DOWNLOADS}{}/latest.json", self.tag_name);
        self.assets.iter().find(|a| a.name == "latest.json" && a.browser_download_url == expected)
            .map(|a| a.browser_download_url.as_str())
    }
}

// Stable means GitHub's explicitly designated Latest release, not an arbitrary stable tag.
fn select_release(current: &Version, stable: Option<Release>, previews: Vec<Release>) -> Option<Release> {
    stable.into_iter().filter(|r| !r.draft && !r.prerelease && r.version().is_some_and(|v| v.pre.is_empty()))
        .chain(previews.into_iter().filter(|r| !r.draft && r.prerelease && r.manifest().is_some()))
        .filter(|r| r.version().is_some_and(|v| v.cmp_precedence(current) == Ordering::Greater))
        .max_by(|a, b| a.version().unwrap().cmp_precedence(&b.version().unwrap()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    notes: String,
    published_at: Option<String>,
    prerelease: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress { downloaded: u64, total: Option<u64> }

#[tauri::command]
pub async fn updates_check(app: AppHandle, state: State<'_, Updates>, include_prerelease: bool) -> Result<Option<Available>, String> {
    let mut pending = state.0.try_lock().map_err(|_| "UPDATE_BUSY".to_string())?;
    let configured = app.config().plugins.0.get("updater")
        .and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()).is_some_and(|s| !s.trim().is_empty());
    if !configured { return Err("UPDATES_NOT_CONFIGURED".into()); }
    *pending = None;
    let client = reqwest::Client::builder().user_agent(concat!("Nevis/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let response = client.get(format!("{RELEASES}/latest")).send().await.map_err(|e| e.to_string())?;
    let stable = if response.status() == reqwest::StatusCode::NOT_FOUND { None } else {
        Some(response.error_for_status().map_err(|e| e.to_string())?.json::<Release>().await.map_err(|e| e.to_string())?)
    };
    let mut previews = Vec::new();
    if include_prerelease {
        // Follow pages so older-published tags with newer versions are not missed.
        for page in 1..=10 {
            let releases = client.get(format!("{RELEASES}?per_page=100&page={page}"))
                .send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?
                .json::<Vec<Release>>().await.map_err(|e| e.to_string())?;
            let done = releases.len() < 100;
            previews.extend(releases);
            if done { break; }
            if page == 10 { return Err("Release history is too large to check completely".into()); }
        }
    }
    let current = app.package_info().version.clone();
    let Some(release) = select_release(&current, stable, previews) else { return Ok(None) };
    let manifest = release.manifest().ok_or("UPDATE_NOT_READY")?;
    let expected = release.version().ok_or("Invalid release version")?;
    let updater = app.updater_builder().endpoints(vec![manifest.parse().map_err(|_| "Invalid update endpoint")?])
        .map_err(|e| e.to_string())?.timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let Some(mut update) = updater.check().await.map_err(|e| e.to_string())? else { return Err("UPDATE_NOT_READY".into()) };
    // Do not let a misplaced manifest cross channels or announce another version.
    if Version::parse(&update.version).map_err(|e| e.to_string())? != expected {
        return Err("Update manifest does not match its release".into());
    }
    if update.download_url.scheme() != "https" || !update.download_url.as_str().starts_with(&format!("{DOWNLOADS}{}/", release.tag_name)) {
        return Err("Unexpected update download URL".into());
    }
    update.timeout = Some(Duration::from_secs(15 * 60));
    let result = Available { version: update.version.clone(), notes: release.body.unwrap_or_default(), published_at: release.published_at, prerelease: release.prerelease };
    *pending = Some(Pending { update, bytes: None });
    Ok(Some(result))
}

#[tauri::command]
pub async fn updates_download(state: State<'_, Updates>, version: String, on_progress: Channel<Progress>) -> Result<(), String> {
    let mut pending = state.0.try_lock().map_err(|_| "UPDATE_BUSY")?;
    let p = pending.as_mut().filter(|p| p.update.version == version).ok_or("UPDATE_EXPIRED")?;
    if p.bytes.is_some() { return Ok(()); }
    let mut downloaded = 0;
    let bytes = p.update.download(|size, total| {
        downloaded += size as u64;
        let _ = on_progress.send(Progress { downloaded, total });
    }, || {}).await.map_err(|e| e.to_string())?;
    // download() verifies the signature before bytes can be installed.
    p.bytes = Some(bytes);
    Ok(())
}

#[tauri::command]
pub async fn updates_install(app: AppHandle, state: State<'_, Updates>, version: String) -> Result<(), String> {
    let mut pending = state.0.try_lock().map_err(|_| "UPDATE_BUSY")?;
    let p = pending.as_mut().filter(|p| p.update.version == version).ok_or("UPDATE_EXPIRED")?;
    let bytes = p.bytes.take().ok_or("UPDATE_NOT_DOWNLOADED")?;
    let update = p.update.clone();
    let install_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _session = crate::sync::account::guard()?;
        let store = install_app.state::<crate::Store>();
        let open = store.vault.lock().map_err(|e| e.to_string())?;
        let mutex = open.as_ref().map(|v| crate::vault::local_lock(&v.root));
        let _vault = mutex.as_ref().map(|m| m.lock());
        let mut pause = crate::vault::WritePause::new();
        update.install(bytes).map_err(|e| e.to_string())?;
        pause.keep_until_restart();
        Ok(())
    }).await.map_err(|e| e.to_string())??;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(version: &str, prerelease: bool) -> Release {
        Release { tag_name: format!("v{version}"), draft: false, prerelease, body: None, published_at: None,
            assets: vec![Asset { name: "latest.json".into(), browser_download_url: format!("{DOWNLOADS}v{version}/latest.json") }] }
    }
    fn selected(current: &str, stable: Option<Release>, previews: Vec<Release>) -> Option<String> {
        select_release(&Version::parse(current).unwrap(), stable, previews).map(|r| r.tag_name)
    }
    #[test]
    fn stable_and_preview_channels() {
        assert_eq!(selected("1.0.0", Some(release("1.1.0", false)), vec![]).as_deref(), Some("v1.1.0"));
        assert_eq!(selected("1.0.0", Some(release("1.1.0-beta.1", true)), vec![]), None);
        assert_eq!(selected("1.0.0", Some(release("1.1.0", false)), vec![release("1.2.0-beta.1", true)]).as_deref(), Some("v1.2.0-beta.1"));
        assert_eq!(selected("1.1.0-beta.2", Some(release("1.1.0", false)), vec![release("1.1.0-beta.10", true)]).as_deref(), Some("v1.1.0"));
        assert_eq!(selected("1.2.0-beta.1", Some(release("1.1.0", false)), vec![]), None);
    }
    #[test]
    fn rejects_drafts_missing_assets_and_non_latest_stable() {
        let mut draft = release("3.0.0-beta.1", true); draft.draft = true;
        let mut missing = release("4.0.0-beta.1", true); missing.assets.clear();
        assert_eq!(selected("1.0.0", None, vec![draft, missing, release("2.0.0", false)]), None);
        assert_eq!(selected("1.0.0", None, vec![release("1.1.0-beta.2", true), release("1.1.0-beta.10", true)]).as_deref(), Some("v1.1.0-beta.10"));
        assert_eq!(selected("1.0.0+one", Some(release("1.0.0+two", false)), vec![]), None);
    }
}
