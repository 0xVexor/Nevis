//! Versioned per-setting policy. Device values never enter batches, preimages or checkpoints.
use super::{
    super::snapshot::{self, Bundle},
    core::{bytes, Documents},
};
use crate::vault::{err, write_atomic, Res, Vault};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs};
pub const FIELDS: &[&str] = &[
    "lang",
    "dir",
    "theme",
    "accent",
    "bg",
    "radius",
    "font",
    "fontSize",
    "textColor",
    "sidebar",
    "pagesView",
    "sideGlass",
    "mainGlass",
    "bgStrength",
    "showCovers",
    "showIcons",
    "cardReminders",
    "compressImages",
    "reduceMotion",
    "prereleaseUpdates",
];
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    Global,
    DeviceLocal,
}
pub type Policy = BTreeMap<String, Scope>;
pub fn policy(settings: Option<&Value>) -> Res<Policy> {
    let mut policy: Policy = FIELDS
        .iter()
        .map(|k| ((*k).to_string(), Scope::Global))
        .collect();
    let Some(record) = settings.and_then(|s| s.get("nevisDriveSyncPolicy")) else {
        return Ok(policy);
    };
    if record["schemaVersion"] != 1 {
        return Err("DRIVE:settings_policy_schema".into());
    }
    let fields: Policy = serde_json::from_value(record["fields"].clone())
        .map_err(|_| "DRIVE:settings_policy_invalid")?;
    for (key, scope) in fields {
        if !FIELDS.contains(&key.as_str()) {
            return Err("DRIVE:settings_policy_unknown_key".into());
        }
        policy.insert(key, scope);
    }
    Ok(policy)
}
fn appearance(value: &Value) -> Res<Option<Value>> {
    if value.is_null() {
        return Ok(None);
    }
    if let Some(object) = value.get("$nevisSettingsV1") {
        if !object.is_object() || value.as_object().is_none_or(|o| o.len() != 1) {
            return Err("DRIVE:settings_invalid".into());
        }
        return Ok(Some(super::stable::denormalize(object)?));
    }
    let text = value.as_str().ok_or("DRIVE:settings_invalid")?;
    let value: Value = serde_json::from_str(text).map_err(|_| "DRIVE:settings_invalid")?;
    if !value.is_object() {
        return Err("DRIVE:settings_invalid".into());
    }
    Ok(Some(value))
}
fn strip(appearance: &mut Value, policy: &Policy) {
    if let Some(object) = appearance.as_object_mut() {
        for (key, scope) in policy {
            if *scope == Scope::DeviceLocal {
                object.remove(key);
            }
        }
    }
}
pub fn encode(raw: &Value, policy: &Policy) -> Res<Value> {
    let mut value = raw.clone();
    if let Some(raw) = raw.get("not.settings") {
        if let Some(mut fields) = appearance(raw)? {
            strip(&mut fields, policy);
            value["not.settings"] = json!({"$nevisSettingsV1":super::stable::normalize(&fields)});
        }
    }
    Ok(value)
}
pub fn decode(wire: &Value, local: &Value, policy: &Policy) -> Res<Value> {
    let mut value = wire.clone();
    if let Some(raw) = wire.get("not.settings") {
        if let Some(mut fields) = appearance(raw)? {
            strip(&mut fields, policy);
            let current = local
                .get("not.settings")
                .map(appearance)
                .transpose()?
                .flatten();
            for (key, scope) in policy {
                if *scope == Scope::DeviceLocal {
                    if let Some(v) = current.as_ref().and_then(|v| v.get(key)) {
                        fields[key] = v.clone();
                    }
                }
            }
            value["not.settings"] = json!(String::from_utf8(bytes(&fields)?).map_err(err)?);
        }
    }
    Ok(value)
}
pub fn sanitize(documents: &mut Documents) -> Res<()> {
    let policy = policy(documents.get("kv/settings.json"))?;
    if let Some(preferences) = documents.get_mut("kv/preferences.json") {
        *preferences = encode(preferences, &policy)?;
    }
    Ok(())
}
pub fn read(v: &Vault) -> Res<Policy> {
    snapshot::checked_parents(&v.root, "kv/settings.json")?;
    let value = match fs::read(v.root.join("kv/settings.json")) {
        Ok(b) => {
            Some(serde_json::from_slice::<Value>(&b).map_err(|_| "DRIVE:settings_policy_invalid")?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(err(e)),
    };
    policy(value.as_ref())
}
pub fn set(v: &Vault, key: &str, scope: Scope) -> Res<()> {
    if !FIELDS.contains(&key) {
        return Err("DRIVE:settings_policy_unknown_key".into());
    }
    snapshot::checked_parents(&v.root, "kv/settings.json")?;
    let path = v.root.join("kv/settings.json");
    let mut value = match fs::read(&path) {
        Ok(b) => {
            serde_json::from_slice::<Value>(&b).map_err(|_| "DRIVE:settings_policy_invalid")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(err(e)),
    };
    if !value.is_object() {
        return Err("DRIVE:settings_policy_requires_object".into());
    }
    let mut policy = policy(Some(&value))?;
    policy.insert(key.into(), scope);
    value["nevisDriveSyncPolicy"] = json!({"schemaVersion":1,"fields":policy});
    write_atomic(&path, &bytes(&value)?)
}
pub fn cloud_bundle(bundle: &Bundle) -> Res<Bundle> {
    let mut files = bundle.decode_metadata()?;
    let config = files
        .get("kv/settings.json")
        .map(|b| serde_json::from_slice::<Value>(b).map_err(err))
        .transpose()?;
    let policy = policy(config.as_ref())?;
    if let Some(data) = files.get_mut("kv/preferences.json") {
        let raw: Value = serde_json::from_slice(data).map_err(err)?;
        let wire = encode(&raw, &policy)?;
        let safe = decode(&wire, &Value::Null, &policy)?;
        *data = snapshot::canonical(&safe)?;
    }
    let mut safe = Bundle::new(
        &bundle.manifest.vault,
        &files,
        bundle.manifest.tombstones.clone(),
    );
    safe.sources = bundle.sources.clone();
    for (p, _) in &safe.sources {
        safe.manifest
            .files
            .insert(p.clone(), bundle.manifest.files[p].clone());
    }
    safe.decode_metadata()?;
    Ok(safe)
}
