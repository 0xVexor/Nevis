//! Explicit account-scoped root selection. Existing Vault bindings never follow a different root silently.
use super::{
    auth,
    core::bytes,
    snapshot,
    transport::{check_id, Drive},
};
use crate::vault::{err, write_atomic, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Choice {
    schema_version: u32,
    subject: String,
    id: String,
}
fn path(data: &Path, subject: &str) -> PathBuf {
    data.join("drive").join(format!(
        "root-choice-{}.json",
        snapshot::hash(subject.as_bytes())
    ))
}
pub fn selected(data: &Path, subject: &str) -> Res<Option<String>> {
    match fs::read(path(data, subject)) {
        Ok(raw) => {
            let c: Choice =
                serde_json::from_slice(&raw).map_err(|_| "DRIVE:root_choice_corrupt")?;
            if c.schema_version != 1 || c.subject != subject {
                return Err("DRIVE:root_choice_identity".into());
            }
            check_id(&c.id)?;
            Ok(Some(c.id))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
pub fn validate(metadata: &Value, subject: &str) -> Res<String> {
    let id = metadata["id"].as_str().ok_or("DRIVE:invalid_metadata")?;
    check_id(id)?;
    if metadata["trashed"] == true
        || metadata["mimeType"] != "application/vnd.google-apps.folder"
        || metadata["appProperties"]["owner"] != subject
        || metadata["appProperties"]["nevisKind"] != "root"
        || metadata["appProperties"]["nevisProtocol"] != "1"
    {
        return Err("DRIVE:identity_mismatch".into());
    }
    Ok(id.into())
}
pub fn choose(rows: &[Value], subject: &str, selection: Option<&str>) -> Res<Option<String>> {
    if let Some(id) = selection {
        check_id(id)?;
        let m = rows
            .iter()
            .find(|m| m["id"] == id)
            .ok_or("DRIVE:selected_root_unavailable")?;
        return validate(m, subject).map(Some);
    }
    match rows {
        [] => Ok(None),
        [one] => validate(one, subject).map(Some),
        _ => Err("DRIVE:duplicate_roots".into()),
    }
}
pub fn query(subject: &str) -> Res<String> {
    if subject.is_empty()
        || subject.len() > 255
        || !subject
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("DRIVE:identity_mismatch".into());
    }
    Ok(format!("trashed = false and appProperties has {{ key='nevisKind' and value='root' }} and appProperties has {{ key='owner' and value='{subject}' }}"))
}
fn protect_bindings(data: &Path, subject: &str, id: &str) -> Res<()> {
    let entries = match fs::read_dir(data.join("drive")) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    for entry in entries {
        let entry = entry.map_err(err)?;
        let name = entry.file_name();
        let Some(vault) = name.to_str().filter(|s| uuid::Uuid::parse_str(s).is_ok()) else {
            continue;
        };
        if let Some(b) = super::binding(data, vault)? {
            if b.subject == subject && b.root_id != id {
                return Err("DRIVE:root_has_other_bindings".into());
            }
        }
    }
    Ok(())
}
pub fn list(data: &Path) -> Res<Value> {
    let subject = auth::subject()?;
    let mut d = Drive::new()?;
    let rows = d.list(&query(&subject)?)?;
    let chosen = selected(data, &subject)?;
    let mut out = vec![];
    for m in rows {
        let id = m["id"].as_str().ok_or("DRIVE:invalid_metadata")?;
        let valid =
            validate(&m, &subject).and_then(|_| super::root_descriptor(&mut d, id, &subject, None));
        let error = valid.as_ref().err().cloned();
        let vaults = if valid.is_ok() {
            Some(d.list(&format!("trashed = false and '{id}' in parents and appProperties has {{ key='nevisKind' and value='vault' }}"))?.len())
        } else {
            None
        };
        out.push(json!({"id":id,"name":m["name"].as_str().unwrap_or("Nevis"),"vaults":vaults,"selected":chosen.as_deref()==Some(id),"verified":valid.is_ok(),"error":error}));
    }
    Ok(json!(out))
}
pub fn open(id: &str) -> Res<()> {
    check_id(id)?;
    let subject = auth::subject()?;
    let metadata = Drive::new()?.metadata(id)?;
    validate(&metadata, &subject)?;
    auth::open_drive_folder(id)
}
pub fn select(data: &Path, id: &str) -> Res<Value> {
    check_id(id)?;
    let subject = auth::subject()?;
    let mut d = Drive::new()?;
    let metadata = d.metadata(id)?;
    validate(&metadata, &subject)?;
    super::root_descriptor(&mut d, id, &subject, None)?;
    persist_verified(data, &subject, id)?;
    Ok(json!({"id":id,"name":metadata["name"].as_str().unwrap_or("Nevis")}))
}
fn persist_verified(data: &Path, subject: &str, id: &str) -> Res<()> {
    check_id(id)?;
    protect_bindings(data, subject, id)?;
    write_atomic(
        &path(data, subject),
        &bytes(&Choice {
            schema_version: 1,
            subject: subject.into(),
            id: id.into(),
        })?,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn root(id: &str) -> Value {
        json!({"id":id,"name":"Nevis","mimeType":"application/vnd.google-apps.folder","trashed":false,"appProperties":{"owner":"subject","nevisKind":"root","nevisProtocol":"1"}})
    }
    #[test]
    fn duplicate_names_require_explicit_verified_identity_and_never_fall_back() {
        let rows = [root("first"), root("second")];
        assert_eq!(
            choose(&rows, "subject", None).unwrap_err(),
            "DRIVE:duplicate_roots"
        );
        assert_eq!(
            choose(&rows, "subject", Some("second")).unwrap(),
            Some("second".into())
        );
        let mut renamed = root("second");
        renamed["name"] = json!("Moved personal folder");
        assert_eq!(
            choose(&[renamed], "subject", Some("second")).unwrap(),
            Some("second".into())
        );
        assert_eq!(
            choose(&[], "subject", Some("second")).unwrap_err(),
            "DRIVE:selected_root_unavailable"
        );
        assert!(choose(&rows, "another-account", Some("first")).is_err());
        let mut forged = root("fake");
        forged["mimeType"] = json!("text/plain");
        assert!(choose(&[forged], "subject", None).is_err());
    }
    #[test]
    fn choice_is_account_scoped_and_bound_vaults_cannot_be_redirected() {
        let data = std::env::temp_dir().join(format!("nevis-roots-{}", uuid::Uuid::new_v4()));
        persist_verified(&data, "subject", "first").unwrap();
        assert_eq!(selected(&data, "subject").unwrap(), Some("first".into()));
        assert!(selected(&data, "other").unwrap().is_none());
        let b = super::super::Binding {
            schema_version: 1,
            subject: "subject".into(),
            root_id: "first".into(),
            vault_id: uuid::Uuid::new_v4().to_string(),
            folder_id: "v".into(),
            objects_id: "o".into(),
            streams_id: "s".into(),
            checkpoints_id: "c".into(),
            backup: String::new(),
            paused: true,
        };
        super::super::save_binding(&data, &b).unwrap();
        assert_eq!(
            persist_verified(&data, "subject", "second").unwrap_err(),
            "DRIVE:root_has_other_bindings"
        );
        assert_eq!(selected(&data, "subject").unwrap(), Some("first".into()));
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn corrupt_selection_fails_closed_and_subject_cannot_inject_query() {
        let data = std::env::temp_dir().join(format!("nevis-root-bad-{}", uuid::Uuid::new_v4()));
        write_atomic(&path(&data, "subject"), b"{broken").unwrap();
        assert_eq!(
            selected(&data, "subject").unwrap_err(),
            "DRIVE:root_choice_corrupt"
        );
        assert!(query("x' or trashed=true").is_err());
        fs::remove_dir_all(data).unwrap();
    }
}
