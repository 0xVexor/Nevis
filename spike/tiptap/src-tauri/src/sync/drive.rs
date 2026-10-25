//! Google Drive as a `Remote`. Everything lives in the app's hidden `appDataFolder` (scope drive.appdata):
//! one Drive folder per vault, named `noviq-vault-<vault id>`, with the vault's files stored flat inside it
//! (the file name is the relative path, e.g. `pages/<id>.json`).

use super::auth::Session;
use super::{Remote, RemoteFile, CLOUD_GONE};
use crate::vault::{err, Res};
use reqwest::blocking::{Client, RequestBuilder};
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS: &str = "id,name,md5Checksum,modifiedTime";
const FIELDS_TRASHED: &str = "id,name,md5Checksum,modifiedTime,trashed";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

pub struct Drive {
    http: Client,
    session: Session,
    /// ids reserved with files.generateIds: creating a file with a known id can be retried without making a second file
    ids: Vec<String>,
}

/// "2026-10-24T12:34:56.789Z" → unix ms (Drive always answers in UTC).
fn parse_time(s: &str) -> i64 {
    let n = |a: usize, b: usize| s.get(a..b).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let (y, m, d) = (n(0, 4), n(5, 7), n(8, 10));
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) }; // days from civil (H. Hinnant)
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let ms = s.get(20..).and_then(|f| f.trim_end_matches('Z').get(..3.min(f.trim_end_matches('Z').len()))).and_then(|f| format!("{f:0<3}").parse::<i64>().ok()).unwrap_or(0);
    ((days * 24 + n(11, 13)) * 60 + n(14, 16)) * 60_000 + n(17, 19) * 1000 + ms
}

fn file_of(v: &Value) -> Option<RemoteFile> {
    Some(RemoteFile {
        id: v.get("id")?.as_str()?.into(),
        path: v.get("name")?.as_str()?.into(),
        md5: v.get("md5Checksum").and_then(Value::as_str).unwrap_or_default().into(),
        modified_ms: v.get("modifiedTime").and_then(Value::as_str).map_or(0, parse_time),
    })
}

impl Drive {
    pub fn new(session: Session) -> Res<Drive> {
        Ok(Drive { http: Client::builder().timeout(Duration::from_secs(120)).build().map_err(err)?, session, ids: vec![] })
    }

    /// A file id reserved for a create request (files.generateIds, space appDataFolder); `None` when Drive does not hand one out.
    fn new_id(&mut self) -> Option<String> {
        if self.ids.is_empty() {
            let r: Value = self.send(|h| h.get(format!("{API}/generateIds")).query(&[("space", "appDataFolder"), ("count", "20")])).ok()?.json().ok()?;
            self.ids = r.get("ids")?.as_array()?.iter().filter_map(|i| i.as_str().map(String::from)).collect();
        }
        self.ids.pop()
    }

    /// The file as Drive has it now; `None` when it does not exist (any more) or is in the trash.
    fn file_now(&mut self, id: &str) -> Res<Option<RemoteFile>> {
        let url = format!("{API}/{id}");
        match self.send(|h| h.get(&url).query(&[("fields", FIELDS_TRASHED)])) {
            Ok(r) => {
                let v: Value = r.json().map_err(err)?;
                if v.get("trashed").and_then(Value::as_bool).unwrap_or(false) {
                    return Ok(None);
                }
                Ok(file_of(&v))
            }
            Err(e) if e.contains("404") => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn trash_file(&mut self, id: &str) -> Res<()> {
        let url = format!("{API}/{id}");
        match self.send(|h| h.patch(&url).json(&json!({ "trashed": true }))) {
            Ok(_) => Ok(()),
            Err(e) if e.contains("404") => Ok(()), // already gone
            Err(e) => Err(e),
        }
    }

    /// Sends a request with a fresh token; retries throttling / server errors, and once after a rejected token.
    fn send(&mut self, build: impl Fn(&Client) -> RequestBuilder) -> Res<reqwest::blocking::Response> {
        let mut refreshed = false;
        for attempt in 0..5u64 {
            let token = self.session.token()?;
            let resp = build(&self.http).bearer_auth(token).send();
            match resp {
                Ok(r) if r.status().is_success() => return Ok(r),
                Ok(r) if r.status().as_u16() == 401 && !refreshed => {
                    refreshed = true;
                    self.session.invalidate();
                }
                Ok(r) if matches!(r.status().as_u16(), 429 | 500 | 502 | 503 | 504) || (r.status().as_u16() == 403 && attempt < 3) => {
                    std::thread::sleep(Duration::from_millis(500 * (1 << attempt)));
                }
                Ok(r) => {
                    let code = r.status();
                    return Err(format!("Drive {code}: {}", r.text().unwrap_or_default()));
                }
                Err(e) if attempt < 4 => {
                    let _ = e;
                    std::thread::sleep(Duration::from_millis(500 * (1 << attempt)));
                }
                Err(e) => return Err(err(e)),
            }
        }
        Err("Drive: too many retries".into())
    }

    fn list_query(&mut self, q: &str, fields: &str) -> Res<Vec<Value>> {
        let (mut out, mut page) = (vec![], String::new());
        loop {
            let (q, fields, page_token) = (q.to_string(), format!("nextPageToken,files({fields})"), page.clone());
            let r: Value = self
                .send(|h| {
                    let mut rb = h.get(API).query(&[("spaces", "appDataFolder"), ("q", q.as_str()), ("fields", fields.as_str()), ("pageSize", "1000")]);
                    if !page_token.is_empty() {
                        rb = rb.query(&[("pageToken", page_token.as_str())]);
                    }
                    rb
                })?
                .json()
                .map_err(err)?;
            out.extend(r.get("files").and_then(Value::as_array).cloned().unwrap_or_default());
            match r.get("nextPageToken").and_then(Value::as_str) {
                Some(t) => page = t.to_string(),
                None => return Ok(out),
            }
        }
    }

    /// Vaults stored in the account: (drive folder id, vault id, name).
    pub fn cloud_vaults(&mut self) -> Res<Vec<(String, String, String)>> {
        let q = format!("'appDataFolder' in parents and mimeType='{FOLDER_MIME}' and trashed=false");
        Ok(self
            .list_query(&q, "id,name,appProperties")?
            .iter()
            .filter_map(|f| {
                let props = f.get("appProperties")?;
                Some((f.get("id")?.as_str()?.into(), props.get("vaultId")?.as_str()?.into(), props.get("vaultName").and_then(Value::as_str).unwrap_or("Noviq").into()))
            })
            .collect())
    }

    /// The Drive folder of a vault, if the account has one.
    pub fn find_vault_folder(&mut self, vault_id: &str) -> Res<Option<String>> {
        Ok(self.cloud_vaults()?.into_iter().find(|v| v.1 == vault_id).map(|v| v.0))
    }

    /// Finds the Drive folder of a vault, or creates it. The flag says it was just created (it is empty).
    pub fn vault_folder(&mut self, vault_id: &str, name: &str) -> Res<(String, bool)> {
        if let Some(id) = self.find_vault_folder(vault_id)? {
            return Ok((id, false));
        }
        let meta = json!({ "name": format!("noviq-vault-{vault_id}"), "mimeType": FOLDER_MIME, "parents": ["appDataFolder"], "appProperties": { "vaultId": vault_id, "vaultName": name } });
        let r: Value = self.send(|h| h.post(API).query(&[("fields", "id")]).json(&meta))?.json().map_err(err)?;
        r.get("id").and_then(Value::as_str).map(|i| (i.to_string(), true)).ok_or_else(|| "Drive: folder not created".into())
    }

    /// Moves the cloud copy of a vault to the Drive trash (never an outright delete). Does nothing when there is none.
    pub fn trash_vault_folder(&mut self, vault_id: &str) -> Res<()> {
        match self.find_vault_folder(vault_id)? {
            Some(id) => self.trash_file(&id),
            None => Ok(()),
        }
    }

    pub fn remote_for(&mut self, folder: &str) -> FolderRemote<'_> {
        FolderRemote { drive: self, folder: folder.to_string() }
    }
}

pub struct FolderRemote<'a> {
    drive: &'a mut Drive,
    folder: String,
}

impl Remote for FolderRemote<'_> {
    fn check(&mut self) -> Res<()> {
        let url = format!("{API}/{}", self.folder);
        match self.drive.send(|h| h.get(&url).query(&[("fields", "id,trashed")])) {
            Ok(r) => {
                let v: Value = r.json().map_err(err)?;
                if v.get("trashed").and_then(Value::as_bool).unwrap_or(false) {
                    return Err(CLOUD_GONE.into());
                }
                Ok(())
            }
            Err(e) if e.contains("404") => Err(CLOUD_GONE.into()),
            Err(e) => Err(e),
        }
    }

    fn get(&mut self, id: &str) -> Res<Option<RemoteFile>> {
        self.drive.file_now(id)
    }

    fn trash(&mut self, id: &str) -> Res<()> {
        self.drive.trash_file(id)
    }

    fn list(&mut self) -> Res<Vec<RemoteFile>> {
        let q = format!("'{}' in parents and trashed=false", self.folder);
        Ok(self.drive.list_query(&q, FIELDS)?.iter().filter_map(file_of).collect())
    }

    fn download(&mut self, f: &RemoteFile) -> Res<Vec<u8>> {
        let url = format!("{API}/{}", f.id);
        let r = self.drive.send(|h| h.get(&url).query(&[("alt", "media")]))?;
        Ok(r.bytes().map_err(err)?.to_vec())
    }

    fn upload(&mut self, path: &str, existing: Option<&str>, bytes: &[u8]) -> Res<RemoteFile> {
        // a create carries a reserved id: if the answer got lost and the request is repeated, Drive says "already
        // exists" instead of making a second file of the same name
        let new_id = if existing.is_none() { self.drive.new_id() } else { None };
        let meta = match (existing, &new_id) {
            (Some(_), _) => json!({}),
            (None, Some(id)) => json!({ "id": id, "name": path, "parents": [self.folder] }),
            (None, None) => json!({ "name": path, "parents": [self.folder] }),
        };
        let boundary = format!("noviq{}", uuid::Uuid::new_v4().simple());
        let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
        let ctype = format!("multipart/related; boundary={boundary}");
        let sent = self.drive.send(|h| {
            let rb = match existing {
                Some(id) => h.patch(format!("{UPLOAD}/{id}")),
                None => h.post(UPLOAD),
            };
            rb.query(&[("uploadType", "multipart"), ("fields", FIELDS)]).header("Content-Type", ctype.as_str()).body(body.clone())
        });
        let r: Value = match sent {
            Ok(resp) => resp.json().map_err(err)?,
            Err(e) if e.contains("409") && new_id.is_some() => {
                // the first try had arrived after all
                return self.drive.file_now(new_id.as_deref().unwrap_or_default())?.ok_or(e);
            }
            Err(e) => return Err(e),
        };
        file_of(&r).ok_or_else(|| format!("Drive: unexpected upload answer {r}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_drive_timestamps() {
        assert_eq!(parse_time("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(parse_time("2000-03-01T00:00:01.500Z"), 951_868_801_500);
        assert_eq!(parse_time("2026-10-24T12:00:00Z"), 1_792_843_200_000);
    }
}
