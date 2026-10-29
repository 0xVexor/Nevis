//! Drive coordinator. Shares local apply/backup invariants, never the GitHub HEAD protocol.
pub mod auth;
pub mod checkpoint;
pub mod core;
pub mod database;
pub mod diagnostics;
pub mod gc;
pub mod history;
pub mod onboarding;
pub mod relation_conflicts;
pub mod roots;
pub mod schedule;
pub mod settings;
pub mod stable;
pub mod streaming;
pub mod transport;
use super::snapshot::{self, Bundle, Files};
use crate::vault::{err, write_atomic, Res};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use core::{blob_hash, bytes, Batch, Documents, Journal};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use transport::Drive;

pub fn feature_enabled() -> bool {
    option_env!("NEVIS_DRIVE_SYNC_ENABLED") == Some("1")
}
pub fn dir(data: &Path, id: &str) -> PathBuf {
    data.join("drive").join(id)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub schema_version: u32,
    pub subject: String,
    pub root_id: String,
    pub vault_id: String,
    pub folder_id: String,
    pub objects_id: String,
    pub streams_id: String,
    pub checkpoints_id: String,
    pub backup: String,
    pub paused: bool,
}
pub fn enabled(data: &Path, id: &str) -> bool {
    dir(data, id).join("binding.json").exists()
}
pub fn binding(data: &Path, id: &str) -> Res<Option<Binding>> {
    crate::vault::check_id(id)?;
    match fs::read(dir(data, id).join("binding.json")) {
        Ok(b) => {
            let mut b: Binding = serde_json::from_slice(&b).map_err(|_| "DRIVE:binding_corrupt")?;
            if b.schema_version != 1 || b.vault_id != id {
                return Err("DRIVE:binding_identity".into());
            }
            if dir(data, id).join("pause-request").exists() {
                b.paused = true;
            }
            Ok(Some(b))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("DRIVE:binding_unreadable".into()),
    }
}
pub fn save_binding(data: &Path, b: &Binding) -> Res<()> {
    write_atomic(&dir(data, &b.vault_id).join("binding.json"), &bytes(b)?)
}
static DEVICE_IDENTITY: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn device(data: &Path) -> Res<String> {
    let _guard = DEVICE_IDENTITY
        .lock()
        .map_err(|_| "DRIVE:device_unavailable")?;
    let p = data.join("drive/device.json");
    match fs::read(&p) {
        Ok(b) => {
            let id: String = serde_json::from_slice(&b).map_err(|_| "DRIVE:device_corrupt")?;
            uuid::Uuid::parse_str(&id).map_err(|_| "DRIVE:device_corrupt")?;
            Ok(id)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(data.join("drive")).map_err(err)?;
            let lock = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(data.join("drive/identity.lock"))
                .map_err(|_| "DRIVE:device_unavailable")?;
            let mut locked = false;
            for _ in 0..100 {
                match lock.try_lock() {
                    Ok(()) => {
                        locked = true;
                        break;
                    }
                    Err(fs::TryLockError::WouldBlock) => {
                        std::thread::sleep(std::time::Duration::from_millis(10))
                    }
                    Err(_) => return Err("DRIVE:device_unavailable".into()),
                }
            }
            if !locked {
                return Err("DRIVE:device_initializing".into());
            }
            if let Ok(bytes) = fs::read(&p) {
                let id: String =
                    serde_json::from_slice(&bytes).map_err(|_| "DRIVE:device_corrupt")?;
                uuid::Uuid::parse_str(&id).map_err(|_| "DRIVE:device_corrupt")?;
                return Ok(id);
            }
            let id = uuid::Uuid::new_v4().to_string();
            write_atomic(&p, &bytes(&id)?)?;
            Ok(id)
        }
        Err(_) => Err("DRIVE:device_unreadable".into()),
    }
}
fn folder(
    d: &mut Drive,
    receipt: &Path,
    name: &str,
    parent: Option<&str>,
    props: &Value,
) -> Res<String> {
    let id = match fs::read(receipt) {
        Ok(b) => serde_json::from_slice::<String>(&b).map_err(|_| "DRIVE:setup_corrupt")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let id = d.generate_id()?;
            write_atomic(receipt, &bytes(&id)?)?;
            id
        }
        Err(_) => return Err("DRIVE:setup_unreadable".into()),
    };
    d.create_folder(&id, name, parent, props)?;
    Ok(id)
}
/// Immutable protocol descriptors, independent of mutable folder names/metadata.
fn descriptor(
    d: &mut Drive,
    parent: &str,
    kind: &str,
    vault: &str,
    expected: &Value,
    receipt: Option<&Path>,
) -> Res<()> {
    let payload = bytes(expected)?;
    let digest = snapshot::hash(&payload);
    let rows = d.list(&format!("trashed = false and '{parent}' in parents and appProperties has {{ key='nevisKind' and value='{kind}' }}"))?;
    if rows.is_empty() {
        let receipt = receipt.ok_or("DRIVE:descriptor_missing")?;
        let id: String = match fs::read(receipt) {
            Ok(b) => serde_json::from_slice(&b).map_err(|_| "DRIVE:setup_corrupt")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let id = d.generate_id()?;
                write_atomic(receipt, &bytes(&id)?)?;
                id
            }
            Err(_) => return Err("DRIVE:setup_unreadable".into()),
        };
        return d.put(&id, parent, kind, vault, "descriptor-v1.json", &payload);
    }
    // Simultaneous identical creates are harmless. Divergent descriptors always stop writes.
    for row in rows {
        if row["appProperties"]["nevisProtocol"] != "1"
            || row["appProperties"]["nevisVault"] != vault
            || row["appProperties"]["sha256"] != digest
        {
            return Err("DRIVE:descriptor_identity".into());
        }
        let id = row["id"].as_str().ok_or("DRIVE:invalid_response")?;
        if d.download(id, &digest, payload.len())? != payload {
            return Err("DRIVE:descriptor_identity".into());
        }
    }
    Ok(())
}
fn root_descriptor(d: &mut Drive, id: &str, subject: &str, receipt: Option<&Path>) -> Res<()> {
    descriptor(
        d,
        id,
        "root-descriptor",
        "root",
        &json!({"protocol":"nevis-drive-sync","schemaVersion":1,"minimumReaderVersion":1,"owner":subject,"rootId":id}),
        receipt,
    )
}
fn vault_descriptor(
    d: &mut Drive,
    root: &str,
    folder: &str,
    vault: &str,
    subject: &str,
    receipt: Option<&Path>,
) -> Res<()> {
    descriptor(
        d,
        folder,
        "vault-descriptor",
        vault,
        &json!({"protocol":"nevis-drive-sync","schemaVersion":1,"minimumReaderVersion":1,"owner":subject,"rootId":root,"folderId":folder,"vaultId":vault}),
        receipt,
    )
}
fn root(d: &mut Drive, data: &Path, subject: &str) -> Res<String> {
    let rows = d.list(&roots::query(subject)?)?;
    let selection = roots::selected(data, subject)?;
    let existing = roots::choose(&rows, subject, selection.as_deref())?;
    let id = match existing {
        Some(id) => {
            let receipt = data.join("drive").join(format!("root-{subject}.json"));
            let locally_reserved = fs::read(&receipt)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok())
                .as_deref()
                == Some(&id);
            let descriptor_receipt = data
                .join("drive")
                .join(format!("root-descriptor-{subject}.json"));
            root_descriptor(
                d,
                &id,
                subject,
                if locally_reserved {
                    Some(descriptor_receipt.as_path())
                } else {
                    None
                },
            )?;
            id
        }
        None => {
            let id = folder(
                d,
                &data.join("drive").join(format!("root-{subject}.json")),
                "Nevis",
                None,
                &json!({"nevisKind":"root","nevisProtocol":"1","owner":subject}),
            )?;
            root_descriptor(
                d,
                &id,
                subject,
                Some(
                    &data
                        .join("drive")
                        .join(format!("root-descriptor-{subject}.json")),
                ),
            )?;
            id
        }
    };
    Ok(id)
}
pub fn discover(data: &Path) -> Res<Value> {
    let mut d = Drive::new()?;
    let sub = auth::subject()?;
    let roots = d.list(&roots::query(&sub)?)?;
    let selection = roots::selected(data, &sub)?;
    let Some(root) = roots::choose(&roots, &sub, selection.as_deref())? else {
        return Ok(json!([]));
    };
    root_descriptor(&mut d, &root, &sub, None)?;
    let rows=d.list(&format!("trashed = false and '{root}' in parents and appProperties has {{ key='nevisKind' and value='vault' }}"))?;
    let mut out = vec![];
    for row in rows {
        if row["appProperties"]["owner"] != sub || row["appProperties"]["nevisProtocol"] != "1" {
            return Err("DRIVE:identity_mismatch".into());
        }
        let id = row["appProperties"]["nevisVault"]
            .as_str()
            .ok_or("DRIVE:invalid_response")?;
        uuid::Uuid::parse_str(id).map_err(|_| "DRIVE:invalid_vault")?;
        vault_descriptor(
            &mut d,
            &root,
            row["id"].as_str().ok_or("DRIVE:invalid_response")?,
            id,
            &sub,
            None,
        )?;
        out.push(json!({"id":id,"folderId":row["id"],"name":row["name"]}));
    }
    Ok(json!(out))
}
pub fn prepare(data: &Path, vault: &str, name: &str, existing: Option<&str>) -> Res<Binding> {
    if !feature_enabled() {
        return Err("DRIVE:feature_disabled".into());
    }
    uuid::Uuid::parse_str(vault).map_err(|_| "DRIVE:invalid_vault")?;
    let subject = auth::subject()?;
    let mut d = Drive::new()?;
    let root = if existing.is_some() {
        let rows = d.list(&roots::query(&subject)?)?;
        let selection = roots::selected(data, &subject)?;
        let id = roots::choose(&rows, &subject, selection.as_deref())?
            .ok_or("DRIVE:root_unavailable")?;
        root_descriptor(&mut d, &id, &subject, None)?;
        id
    } else {
        root(&mut d, data, &subject)?
    };
    let props = json!({"nevisKind":"vault","nevisProtocol":"1","owner":subject,"nevisVault":vault});
    let f = if let Some(id) = existing {
        let m = d.metadata(id)?;
        if m["appProperties"] != props
            || !m["parents"]
                .as_array()
                .is_some_and(|p| p.contains(&json!(root)))
        {
            return Err("DRIVE:identity_mismatch".into());
        }
        id.into()
    } else {
        let rows=d.list(&format!("trashed = false and '{root}' in parents and appProperties has {{ key='nevisVault' and value='{vault}' }}"))?;
        if rows.len() > 1 {
            return Err("DRIVE:duplicate_vaults".into());
        }
        match rows.first() {
            Some(m) => {
                if m["appProperties"] != props {
                    return Err("DRIVE:identity_mismatch".into());
                }
                m["id"].as_str().ok_or("DRIVE:invalid_response")?.into()
            }
            None => folder(
                &mut d,
                &dir(data, vault).join(format!("setup-{subject}-vault.json")),
                name,
                Some(&root),
                &props,
            )?,
        }
    };
    vault_descriptor(
        &mut d,
        &root,
        &f,
        vault,
        &subject,
        Some(&dir(data, vault).join(format!("setup-{subject}-descriptor.json"))),
    )?;
    let mut child = |kind: &str| -> Res<String> {
        let rows=d.list(&format!("trashed = false and '{f}' in parents and appProperties has {{ key='nevisKind' and value='{kind}' }}"))?;
        if rows.len() > 1 {
            return Err("DRIVE:duplicate_folders".into());
        }
        let props = json!({"nevisKind":kind,"nevisProtocol":"1","nevisVault":vault});
        if let Some(m) = rows.first() {
            if m["appProperties"] != props {
                return Err("DRIVE:identity_mismatch".into());
            }
            Ok(m["id"].as_str().ok_or("DRIVE:invalid_response")?.into())
        } else {
            folder(
                &mut d,
                &dir(data, vault).join(format!("setup-{subject}-{kind}.json")),
                kind,
                Some(&f),
                &props,
            )
        }
    };
    Ok(Binding {
        schema_version: 1,
        subject: subject.clone(),
        root_id: root,
        vault_id: vault.into(),
        folder_id: f.clone(),
        objects_id: child("objects")?,
        streams_id: child("streams")?,
        checkpoints_id: child("checkpoints")?,
        backup: String::new(),
        paused: false,
    })
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RemoteBatch {
    pub id: String,
    pub digest: String,
    pub key: String,
}
#[derive(Clone)]
pub struct ChangePage {
    pub files: Vec<RemoteBatch>,
    pub next: Option<String>,
    pub final_cursor: Option<String>,
    pub removed: BTreeSet<String>,
    pub checkpoint_changed: bool,
}
/// Independent immutable-storage contract; no shared mutable HEAD and no delete method.
pub struct Bootstrap {
    pub seed: core::ReplaySeed,
    pub objects: BTreeMap<String, Vec<u8>>,
}
pub trait SyncStorageAdapter {
    fn can_publish(&self) -> bool {
        true
    }
    fn bootstrap(&mut self) -> Res<Option<Bootstrap>> {
        Ok(None)
    }
    fn check(&mut self) -> Res<()>;
    fn reserve(&mut self) -> Res<String>;
    fn start(&mut self) -> Res<String>;
    fn inventory(&mut self) -> Res<Vec<RemoteBatch>>;
    fn changes(&mut self, cursor: &str) -> Res<ChangePage>;
    fn read_batch(&mut self, file: &RemoteBatch) -> Res<Vec<u8>>;
    fn publish(&mut self, id: &str, batch: &Batch) -> Res<()>;
    fn object(&mut self, hash: &str, local: Option<&[u8]>) -> Res<Vec<u8>>;
    fn object_file(&mut self, hash: &str, target: &Path, local: bool) -> Res<()> {
        let data = if local {
            Some(fs::read(target).map_err(err)?)
        } else {
            None
        };
        let remote = self.object(hash, data.as_deref())?;
        if snapshot::hash(&remote) != hash {
            return Err("DRIVE:integrity".into());
        }
        write_atomic(target, &remote)
    }
}
pub struct VaultDrive {
    allow_publish: bool,
    publication_clock: PathBuf,
    pub drive: Drive,
    pub binding: Binding,
    pub state_dir: PathBuf,
}
impl VaultDrive {
    pub fn new(binding: Binding, state_dir: PathBuf) -> Res<Self> {
        Ok(Self {
            drive: Drive::new()?,
            binding,
            publication_clock: state_dir.join("publication-at.json"),
            state_dir,
            allow_publish: true,
        })
    }
    fn file(&self, m: &Value) -> Res<Option<RemoteBatch>> {
        if m["appProperties"]["nevisKind"] != "batch"
            || m["appProperties"]["nevisVault"] != self.binding.vault_id
        {
            return Ok(None);
        }
        let key = m["appProperties"]["nevisKey"]
            .as_str()
            .ok_or("DRIVE:invalid_metadata")?;
        let digest = m["appProperties"]["sha256"]
            .as_str()
            .ok_or("DRIVE:invalid_metadata")?;
        transport::verify(
            m,
            &self.binding.streams_id,
            "batch",
            &self.binding.vault_id,
            key,
            digest,
        )?;
        Ok(Some(RemoteBatch {
            id: m["id"].as_str().ok_or("DRIVE:invalid_metadata")?.into(),
            digest: digest.into(),
            key: key.into(),
        }))
    }
}
impl SyncStorageAdapter for VaultDrive {
    fn can_publish(&self) -> bool {
        self.allow_publish
    }
    fn bootstrap(&mut self) -> Res<Option<Bootstrap>> {
        checkpoint::bootstrap(&mut self.drive, &self.binding, &self.state_dir)
    }
    fn check(&mut self) -> Res<()> {
        if auth::subject()? != self.binding.subject {
            return Err("DRIVE:account_mismatch".into());
        }
        let root = self.drive.metadata(&self.binding.root_id)?;
        let vault = self.drive.metadata(&self.binding.folder_id)?;
        if root["appProperties"]["owner"] != self.binding.subject
            || root["appProperties"]["nevisKind"] != "root"
            || vault["appProperties"]["nevisVault"] != self.binding.vault_id
            || vault["appProperties"]["owner"] != self.binding.subject
        {
            return Err("DRIVE:identity_mismatch".into());
        }
        root_descriptor(
            &mut self.drive,
            &self.binding.root_id,
            &self.binding.subject,
            None,
        )?;
        vault_descriptor(
            &mut self.drive,
            &self.binding.root_id,
            &self.binding.folder_id,
            &self.binding.vault_id,
            &self.binding.subject,
            None,
        )?;
        for (id, kind) in [
            (&self.binding.streams_id, "streams"),
            (&self.binding.objects_id, "objects"),
            (&self.binding.checkpoints_id, "checkpoints"),
        ] {
            let m = self.drive.metadata(id)?;
            if m["appProperties"]["nevisKind"] != kind
                || m["appProperties"]["nevisVault"] != self.binding.vault_id
                || !m["parents"]
                    .as_array()
                    .is_some_and(|p| p.contains(&json!(self.binding.folder_id)))
            {
                return Err("DRIVE:identity_mismatch".into());
            }
        }
        Ok(())
    }
    fn reserve(&mut self) -> Res<String> {
        self.drive.generate_id()
    }
    fn start(&mut self) -> Res<String> {
        self.drive.start_token()
    }
    fn inventory(&mut self) -> Res<Vec<RemoteBatch>> {
        let rows=self.drive.list(&format!("trashed = false and '{}' in parents and appProperties has {{ key='nevisKind' and value='batch' }}",self.binding.streams_id))?;
        rows.iter()
            .filter_map(|m| self.file(m).transpose())
            .collect()
    }
    fn changes(&mut self, cursor: &str) -> Res<ChangePage> {
        let v = self.drive.changes(cursor)?;
        let mut files = vec![];
        let mut removed = BTreeSet::new();
        let mut checkpoint_changed = false;
        for c in v["changes"].as_array().ok_or("DRIVE:invalid_response")? {
            if c["removed"] == true {
                if let Some(id) = c["fileId"].as_str() {
                    removed.insert(id.into());
                }
                continue;
            }
            let file = &c["file"];
            if file["appProperties"]["nevisKind"] == "checkpoint"
                && file["appProperties"]["nevisVault"] == self.binding.vault_id
                && file["parents"]
                    .as_array()
                    .is_some_and(|p| p.contains(&json!(self.binding.checkpoints_id)))
            {
                checkpoint_changed = true;
            }
            if let Some(f) = self.file(&c["file"])? {
                files.push(f);
            }
        }
        Ok(ChangePage {
            files,
            next: v["nextPageToken"].as_str().map(str::to_string),
            final_cursor: v["newStartPageToken"].as_str().map(str::to_string),
            removed,
            checkpoint_changed,
        })
    }
    fn read_batch(&mut self, f: &RemoteBatch) -> Res<Vec<u8>> {
        let m = self.drive.metadata(&f.id)?;
        if self.file(&m)?.as_ref().map(|m| (&m.key, &m.digest)) != Some((&f.key, &f.digest)) {
            return Err("DRIVE:integrity".into());
        }
        self.drive.download(&f.id, &f.digest, core::MAX_BATCH)
    }
    fn publish(&mut self, id: &str, b: &Batch) -> Res<()> {
        // Persist the attempt before I/O: an unknown result also consumes the automatic interval.
        write_atomic(&self.publication_clock, &bytes(&crate::vault::now_ms())?)?;
        self.drive.put(
            id,
            &self.binding.streams_id,
            "batch",
            &b.vault_id,
            &b.batch_id,
            &bytes(b)?,
        )
    }
    fn object_file(&mut self, h: &str, target: &Path, local: bool) -> Res<()> {
        self.drive.object_file(
            &self.binding.objects_id,
            &self.binding.vault_id,
            h,
            target,
            local,
            &self.state_dir,
        )
    }
    fn object(&mut self, h: &str, local: Option<&[u8]>) -> Res<Vec<u8>> {
        self.drive.object_with_state(
            &self.binding.objects_id,
            &self.binding.vault_id,
            h,
            local,
            &self.state_dir,
        )
    }
}
fn documents(b: &Bundle) -> Res<(Documents, BTreeMap<String, Vec<u8>>)> {
    let mut docs = Documents::new();
    let mut blobs = BTreeMap::new();
    let decoded = b.decode_metadata()?;
    database::validate(&decoded)?;
    for (p, b) in decoded {
        if p.starts_with("conflicts/") {
            let archive: Value = serde_json::from_slice(&b).map_err(err)?;
            if archive["provider"] == "drive" {
                continue;
            }
        }
        if p.starts_with("files/") && !p.ends_with(".json") {
            let h = snapshot::hash(&b);
            docs.insert(p, json!({"$nevisBlob":h}));
            blobs.insert(h, b);
        } else {
            let value: Value = serde_json::from_slice(&b).map_err(err)?;
            docs.insert(p, stable::normalize(&value));
        }
    }
    for (p, h) in &b.manifest.files {
        if b.sources.contains_key(p) && !p.ends_with(".json") {
            docs.insert(p.clone(), json!({"$nevisBlob":h}));
        }
    }
    settings::sanitize(&mut docs)?;
    Ok((docs, blobs))
}
fn bundle(
    vault: &str,
    state: &core::Materialized,
    local: &Bundle,
    mut blob: impl FnMut(&str) -> Res<PathBuf>,
) -> Res<Bundle> {
    let mut files = Files::new();
    let local_files = local.decode_metadata()?;
    let local_preferences: Value = local_files
        .get("kv/preferences.json")
        .map(|b| serde_json::from_slice(b).map_err(err))
        .transpose()?
        .unwrap_or(Value::Null);
    let policy = settings::policy(state.documents.get("kv/settings.json"))?;
    let mut sources = BTreeMap::new();
    let mut source_hashes = BTreeMap::new();
    for (p, v) in &state.documents {
        if let Some(h) = blob_hash(v) {
            sources.insert(p.clone(), blob(h)?);
            source_hashes.insert(p.clone(), h.to_string());
            continue;
        }
        let b = {
            let value = if p == "kv/preferences.json" {
                settings::decode(v, &local_preferences, &policy)?
            } else {
                stable::denormalize(v)?
            };
            if p.starts_with("pages/") {
                stable::validate(&value)?;
            }
            snapshot::canonical(&value)?
        };
        snapshot::validate(p, &b)?;
        files.insert(p.clone(), b);
    }
    for c in state.conflicts.values() {
        // UI uses full documents, not partial JSON/HTML. Preserve complete candidates in the log as well.
        let encode = |v: &Option<Value>| -> Res<Option<String>> {
            v.as_ref()
                .map(|v| Ok(B64.encode(bytes(&stable::denormalize(v)?)?)))
                .transpose()
        };
        let archive = json!({"id":c.id,"path":c.path,"createdAt":0,"base":encode(&c.base)?,"local":encode(&c.a)?,"remote":encode(&c.b)?,"pointer":c.pointer,"provider":"drive","deleted":c.a.is_none() || c.b.is_none() || c.a.as_ref().is_some_and(|v|!v["deletedAt"].is_null()) || c.b.as_ref().is_some_and(|v|!v["deletedAt"].is_null())});
        if files
            .insert(format!("conflicts/{}.json", c.id), bytes(&archive)?)
            .is_some()
        {
            return Err("DRIVE:conflict_identity_collision".into());
        }
    }
    let tombstones = state
        .tombstones
        .iter()
        .filter(|p| !files.contains_key(*p) && !sources.contains_key(*p))
        .cloned()
        .collect();
    database::validate(&files)?;
    let mut b = Bundle::new(vault, &files, tombstones);
    b.sources = sources;
    b.manifest.files.extend(source_hashes);
    b.decode_metadata()?;
    Ok(b)
}
fn record_files(
    j: &mut Journal,
    files: Vec<RemoteBatch>,
    index: &mut BTreeMap<String, RemoteBatch>,
) -> Res<()> {
    for f in files {
        if !core::valid_hash(&f.digest) || !core::valid_hash(&f.key) {
            return Err("DRIVE:invalid_metadata".into());
        }
        j.inbox.insert(f.id.clone());
        index.insert(f.id.clone(), f);
    }
    Ok(())
}
fn install_bootstrap(j: &mut Journal, path: &Path, vault: &str, bootstrap: Bootstrap) -> Res<()> {
    bootstrap.seed.validate(vault)?;
    if j.seed.as_ref().is_some_and(|old| {
        old.state
            .frontier
            .iter()
            .any(|(d, n)| bootstrap.seed.state.frontier.get(d).copied().unwrap_or(0) < *n)
    }) {
        return Err("DRIVE:checkpoint_regression".into());
    }
    // Verify every covered local sequence against the checkpoint ledger before adopting it.
    for batch in j.batches.values() {
        bootstrap.seed.covers(batch)?;
    }
    for (h, data) in bootstrap.objects {
        if snapshot::hash(&data) != h {
            return Err("DRIVE:integrity".into());
        }
        write_atomic(&path.with_extension("objects").join(h), &data)?;
    }
    j.seed = Some(bootstrap.seed);
    j.save(path)?;
    Ok(())
}
/// Network is outside capture/apply closures; the caller only holds the vault writer mutex inside them.
pub fn synchronize(
    storage: &mut impl SyncStorageAdapter,
    path: &Path,
    vault: &str,
    device: &str,
    mut capture: impl FnMut() -> Res<Bundle>,
    mut apply: impl FnMut(&Bundle, &Bundle) -> Res<()>,
) -> Res<usize> {
    let mut j = Journal::load(path, vault, device)?;
    storage.check()?;
    let local = capture()?;
    let (current, local_blobs) = documents(&local)?;
    if let Some(expected) = j.apply_pending.take() {
        if current != expected && current != j.baseline && j.apply_before.as_ref() != Some(&current)
        {
            return Err("DRIVE:apply_recovery_required".into());
        }
        if current == expected {
            j.baseline = expected;
            j.capture_frontier =
                core::replay_seeded(vault, &j.batches, &j.preimages, j.seed.as_ref())?.frontier;
        } else {
            j.baseline = current.clone();
        }
        j.apply_before = None;
        j.save(path)?;
    }
    // Local capture precedes remote discovery: old offline edits keep their own preimages.
    j.capture(&current)?;
    for (h, b) in &local_blobs {
        let destination = path.with_extension("objects").join(h);
        if !destination.is_file() {
            write_atomic(&destination, b)?;
        }
    }
    j.save(path)?;
    let index_path = path.with_extension("inbox.json");
    let mut index: BTreeMap<String, RemoteBatch> = match fs::read(&index_path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "DRIVE:inbox_corrupt")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(_) => return Err("DRIVE:inbox_unreadable".into()),
    };
    if j.cursor.is_none() {
        let start = storage.start()?;
        if let Some(bootstrap) = storage.bootstrap()? {
            install_bootstrap(&mut j, path, vault, bootstrap)?;
        }
        let inventory = storage.inventory()?;
        let present: BTreeSet<_> = inventory.iter().map(|f| f.id.as_str()).collect();
        if index.keys().any(|id| !present.contains(id.as_str())) {
            return Err("DRIVE:remote_history_removed".into());
        }
        record_files(&mut j, inventory, &mut index)?;
        write_atomic(&index_path, &bytes(&index)?)?;
        j.save(path)?;
        j.cursor = Some(start);
        j.save(path)?;
    }
    let mut page = j.cursor.clone().unwrap();
    let mut pages = BTreeSet::new();
    loop {
        if !pages.insert(page.clone()) {
            return Err("DRIVE:pagination_cycle".into());
        }
        let changes = match storage.changes(&page) {
            Err(e) if e == "DRIVE:cursor_expired" => {
                j.cursor = None;
                j.save(path)?;
                return Err("DRIVE:rescan_required".into());
            }
            r => r?,
        };
        if changes.checkpoint_changed {
            if let Some(bootstrap) = storage.bootstrap()? {
                install_bootstrap(&mut j, path, vault, bootstrap)?;
            }
        }
        if changes.removed.iter().any(|id| {
            index.get(id).is_some_and(|file| {
                !j.seed
                    .as_ref()
                    .is_some_and(|s| s.covered_batches.values().any(|h| h == &file.key))
            })
        }) {
            return Err("DRIVE:remote_history_removed".into());
        }
        record_files(&mut j, changes.files, &mut index)?;
        write_atomic(&index_path, &bytes(&index)?)?;
        j.save(path)?;
        if let Some(next) = changes.next {
            page = next;
        } else {
            j.cursor = Some(changes.final_cursor.ok_or("DRIVE:invalid_cursor")?);
            j.save(path)?;
            break;
        }
    }
    for id in j.inbox.clone() {
        let file = index.get(&id).ok_or("DRIVE:inbox_corrupt")?;
        if j.seed
            .as_ref()
            .is_some_and(|s| s.covered_batches.values().any(|h| h == &file.key))
        {
            j.inbox.remove(&id);
            j.save(path)?;
            continue;
        }
        let b = storage.read_batch(file)?;
        let b: Batch = serde_json::from_slice(&b).map_err(|_| "DRIVE:invalid_batch")?;
        if b.batch_id != file.key {
            return Err("DRIVE:integrity".into());
        }
        j.ingest(b)?;
        j.inbox.remove(&id);
        j.save(path)?;
    }
    if j.batches.is_empty() && j.seed.is_none() {
        return Err("DRIVE:remote_empty_or_missing".into());
    }
    // Validate dependencies before publishing further local work. Missing remote objects defer the whole apply.
    let cache_dir = path.with_extension("objects");
    fs::create_dir_all(&cache_dir).map_err(err)?;
    let mut cache = local_blobs;
    for (h, v) in &j.preimages {
        cache.insert(h.clone(), bytes(v)?);
    }
    for (h, b) in &cache {
        if !cache_dir.join(h).is_file() {
            write_atomic(&cache_dir.join(h), b)?;
        }
    }
    let mut required: BTreeSet<_> = j
        .batches
        .values()
        .flat_map(|b| b.required_objects.iter().cloned())
        .collect();
    if let Some(seed) = &j.seed {
        required.extend(
            seed.state
                .documents
                .values()
                .filter_map(core::blob_hash)
                .map(str::to_string),
        );
    }
    let pending_required: BTreeSet<_> = j
        .outbox
        .iter()
        .flat_map(|o| o.batch.required_objects.iter().cloned())
        .collect();
    let json_dependencies: BTreeSet<_> = j
        .batches
        .values()
        .flat_map(|b| {
            b.operations.iter().flat_map(|o| {
                [
                    o.delta.as_ref().map(|d| d.base_hash.clone()),
                    o.base_object.clone(),
                    o.next_object.clone(),
                ]
                .into_iter()
                .flatten()
            })
        })
        .collect();
    for h in required {
        let target = cache_dir.join(&h);
        let present = target.is_file();
        if (storage.can_publish() && pending_required.contains(&h)) || !present {
            storage.object_file(&h, &target, present)?;
        }
        if streaming::file_hash(&target)? != h {
            return Err("DRIVE:integrity".into());
        }
        if json_dependencies.contains(&h) {
            if fs::metadata(&target).map_err(err)?.len() > snapshot::MAX_FILE as u64 {
                return Err("DRIVE:response_too_large".into());
            }
            let data = fs::read(&target).map_err(err)?;
            j.preimages.insert(
                h,
                serde_json::from_slice(&data).map_err(|_| "DRIVE:invalid_preimage")?,
            );
        }
    }
    j.save(path)?;
    let result = core::replay_seeded(vault, &j.batches, &j.preimages, j.seed.as_ref())?;
    while storage.can_publish() && !j.outbox.is_empty() {
        if j.outbox[0].remote_id.is_none() {
            j.outbox[0].remote_id = Some(storage.reserve()?);
            j.save(path)?;
        }
        let o = &j.outbox[0];
        storage.publish(o.remote_id.as_deref().unwrap(), &o.batch)?;
        let remote_id = o.remote_id.as_ref().unwrap().clone();
        index.insert(
            remote_id.clone(),
            RemoteBatch {
                id: remote_id,
                digest: snapshot::hash(&bytes(&o.batch)?),
                key: o.batch.batch_id.clone(),
            },
        );
        write_atomic(&index_path, &bytes(&index)?)?;
        j.outbox.remove(0);
        j.save(path)?;
    }
    let after = bundle(vault, &result, &local, |h| {
        let p = cache_dir.join(h);
        if p.is_file() {
            Ok(p)
        } else {
            Err("DRIVE:missing_dependency".into())
        }
    })?;
    let (after_docs, _) = documents(&after)?;
    j.apply_pending = Some(after_docs.clone());
    j.apply_before = Some(current.clone());
    j.save(path)?;
    if local.manifest != after.manifest {
        if let Err(error) = apply(&local, &after) {
            if error == "SYNC:local_changed" {
                j.apply_pending = None;
                j.apply_before = None;
                j.save(path)?;
            }
            return Err(error);
        }
    }
    j.baseline = after_docs;
    j.capture_frontier = result.frontier.clone();
    j.apply_pending = None;
    j.apply_before = None;
    j.last_verified_at = crate::vault::now_ms();
    j.save(path)?;
    Ok(result.conflicts.len())
}
pub fn run(
    data: &Path,
    b: &Binding,
    automatic: bool,
    mut capture: impl FnMut() -> Res<Bundle>,
    apply: impl FnMut(&Bundle, &Bundle) -> Res<()>,
) -> Res<usize> {
    if !feature_enabled() {
        return Err("DRIVE:feature_disabled".into());
    }
    if b.paused {
        return Err("DRIVE:paused".into());
    }
    let state_dir = dir(data, &b.vault_id);
    fs::create_dir_all(&state_dir).map_err(err)?;
    let process_lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state_dir.join("worker.lock"))
        .map_err(|_| "DRIVE:lock_unavailable")?;
    process_lock
        .try_lock()
        .map_err(|_| "DRIVE:another_process_syncing")?;
    let retry_file = state_dir.join("retry-after.json");
    schedule::enforce(&retry_file, crate::vault::now_ms())?;
    let publication_clock = state_dir.join("publication-at.json");
    let last: Option<i64> = match fs::read(&publication_clock) {
        Ok(b) => Some(serde_json::from_slice(&b).map_err(|_| "DRIVE:publication_state_corrupt")?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("DRIVE:publication_state_unreadable".into()),
    };
    let mut storage = VaultDrive {
        allow_publish: schedule::publication_allowed(last, crate::vault::now_ms(), automatic),
        publication_clock,
        drive: Drive::new()?.cancellable(state_dir.join("pause-request")),
        binding: b.clone(),
        state_dir,
    };
    let mut result = synchronize(
        &mut storage,
        &dir(data, &b.vault_id).join("journal.json"),
        &b.vault_id,
        &device(data)?,
        &mut capture,
        apply,
    );
    if result.is_ok() {
        let state = dir(data, &b.vault_id);
        let j = Journal::load(&state.join("journal.json"), &b.vault_id, &device(data)?)?;
        let last: Option<checkpoint::Checkpoint> =
            match fs::read(state.join("checkpoint-last.json")) {
                Ok(data) => Some(
                    serde_json::from_slice(&data).map_err(|_| "DRIVE:checkpoint_state_corrupt")?,
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err("DRIVE:checkpoint_state_unreadable".into()),
            };
        if (!j.batches.is_empty() || j.seed.is_some())
            && j.outbox.is_empty()
            && storage.allow_publish
            && checkpoint::due(&j.capture_frontier, last.as_ref(), crate::vault::now_ms())
        {
            let snapshot = capture()?;
            if documents(&snapshot)?.0 == j.baseline {
                if let Err(error) =
                    checkpoint::publish(&mut storage.drive, b, &state, &snapshot, &j)
                {
                    result = Err(error);
                }
            }
        }
    }
    if let Err(message) = &result {
        schedule::record(&retry_file, message, crate::vault::now_ms())?;
    } else {
        schedule::success(&retry_file)?;
    }
    let cumulative = match diagnostics::record(
        data,
        &b.subject,
        crate::vault::now_ms(),
        &storage.drive.meter,
    ) {
        Ok(v) => v,
        Err(e) => json!({"unavailable":e}),
    };
    write_atomic(
        &dir(data, &b.vault_id).join("metrics.json"),
        &bytes(&json!({"lastRun":storage.drive.meter,"accountUsage":cumulative}))?,
    )?;
    result
}
pub fn status(data: &Path, id: &str) -> Res<Value> {
    let b = binding(data, id)?;
    let j = if b.is_some() {
        Some(Journal::load(
            &dir(data, id).join("journal.json"),
            id,
            &device(data)?,
        )?)
    } else {
        None
    };
    let metrics = fs::read(dir(data, id).join("metrics.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    Ok(
        json!({"currentVaultId":if id=="none"{Value::Null}else{json!(id)},"driveSyncEnabled":feature_enabled(),"auth":auth::status(),"binding":b,"pending":j.as_ref().map_or(0,|j|j.outbox.len()),"lastVerifiedAt":j.as_ref().map_or(0,|j|j.last_verified_at),"gc":j.as_ref().map(core::gc_plan),"metrics":metrics,"releaseReady":false}),
    )
}
#[cfg(test)]
mod tests;
/// Journal the resolution before touching local content. Replays and publication carry it causally.
pub fn resolve(data: &Path, vault: &str, id: &str, choice: &str, current: &Bundle) -> Res<Bundle> {
    let path = dir(data, vault).join("journal.json");
    let mut j = Journal::load(&path, vault, &device(data)?)?;
    let (docs, blobs) = documents(current)?;
    j.capture(&docs)?;
    let state = core::replay_seeded(vault, &j.batches, &j.preimages, j.seed.as_ref())?;
    let c = state.conflicts.get(id).ok_or("DRIVE:conflict_changed")?;
    let selected = match choice {
        "local" => c.a.clone(),
        "remote" | "both" => c.b.clone(),
        "delete" if c.a.is_none() || c.a.as_ref().is_some_and(|v| !v["deletedAt"].is_null()) => {
            c.a.clone()
        }
        "delete" if c.b.is_none() || c.b.as_ref().is_some_and(|v| !v["deletedAt"].is_null()) => {
            c.b.clone()
        }
        _ => return Err("DRIVE:unsupported_resolution".into()),
    };
    let mut desired = docs.clone();
    if choice == "both" {
        let mut copy = stable::denormalize(c.a.as_ref().ok_or("DRIVE:keep_both_not_supported")?)?;
        let other = stable::denormalize(c.b.as_ref().ok_or("DRIVE:keep_both_not_supported")?)?;
        if !c.path.starts_with("pages/")
            || !copy["database"].is_null()
            || !other["database"].is_null()
            || copy["content"]["type"] != "doc"
            || other["content"]["type"] != "doc"
        {
            return Err("DRIVE:keep_both_not_supported".into());
        }
        fn fresh_ids(v: &mut Value) {
            if let Some(attrs) = v.get_mut("attrs").and_then(Value::as_object_mut) {
                if attrs.contains_key("stableBlockId") {
                    attrs.insert(
                        "stableBlockId".into(),
                        json!(uuid::Uuid::new_v4().to_string()),
                    );
                }
            }
            if let Some(children) = v.get_mut("content").and_then(Value::as_array_mut) {
                for child in children {
                    fresh_ids(child);
                }
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        copy["id"] = json!(id);
        copy["title"] = json!(format!(
            "{} (conflict copy)",
            copy["title"].as_str().unwrap_or("")
        ));
        copy["deletedAt"] = Value::Null;
        copy["updatedAt"] = json!(crate::vault::now_ms());
        fresh_ids(&mut copy["content"]);
        desired.insert(format!("pages/{id}.json"), stable::normalize(&copy));
    }
    if c.pointer.is_empty() {
        match selected {
            Some(v) => {
                desired.insert(c.path.clone(), v);
            }
            None => {
                desired.remove(&c.path);
            }
        }
    } else {
        let mut v = desired
            .get(&c.path)
            .cloned()
            .ok_or("DRIVE:conflict_changed")?;
        let tokens: Vec<_> = c
            .pointer
            .trim_start_matches('/')
            .split('/')
            .map(|s| s.replace("~1", "/").replace("~0", "~"))
            .collect();
        let candidate = selected
            .as_ref()
            .and_then(|s| s.pointer(&c.pointer))
            .cloned();
        let mut node = &mut v;
        for t in tokens.iter().take(tokens.len() - 1) {
            node = node.get_mut(t).ok_or("DRIVE:conflict_changed")?;
        }
        let object = node.as_object_mut().ok_or("DRIVE:conflict_changed")?;
        let key = tokens.last().unwrap();
        if let Some(value) = candidate {
            object.insert(key.clone(), value);
        } else {
            object.remove(key);
        }
        desired.insert(c.path.clone(), v);
    }
    let seq = j.capture_frontier.get(&j.device_id).copied().unwrap_or(0) + 1;
    let previous = core::local_head(&j);
    let mut operations = vec![];
    let mut required_objects = BTreeSet::new();
    for path in docs
        .keys()
        .chain(desired.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
    {
        if path != c.path && docs.get(&path) == desired.get(&path) {
            continue;
        }
        let mut op = core::Operation {
            path: path.clone(),
            delta: None,
            base_object: None,
            next_object: None,
            base: docs.get(&path).cloned(),
            next: desired.get(&path).cloned(),
            resolves: if path == c.path {
                vec![id.into()]
            } else {
                vec![]
            },
        };
        core::freeze_operation(&mut op, &mut j.preimages)?;
        required_objects.extend(core::operation_objects(&op));
        operations.push(op);
    }
    let batch = Batch {
        protocol: "nevis-drive-sync".into(),
        schema_version: 1,
        vault_id: vault.into(),
        device_id: j.device_id.clone(),
        sequence: seq,
        previous_batch_id: previous,
        seen_frontier: j.capture_frontier.clone(),
        operations,
        atomic_group: None,
        required_objects,
        batch_id: String::new(),
    }
    .seal()?;
    j.batches.insert(batch.batch_id.clone(), batch.clone());
    j.outbox.push(core::Outbox {
        batch,
        remote_id: None,
    });
    j.capture_frontier.insert(j.device_id.clone(), seq);
    j.apply_before = Some(docs);
    j.apply_pending = Some(desired);
    j.save(&path)?;
    let state = core::replay_seeded(vault, &j.batches, &j.preimages, j.seed.as_ref())?;
    bundle(vault, &state, current, |h| {
        let p = path.with_extension("objects").join(h);
        if !p.exists() {
            if let Some(data) = blobs.get(h) {
                write_atomic(&p, data)?;
            }
        }
        if !p.exists() {
            for (name, source) in &current.sources {
                if current
                    .manifest
                    .files
                    .get(name)
                    .is_some_and(|value| value == h)
                {
                    streaming::copy_verified(source, &p, h)?;
                    break;
                }
            }
        }
        if p.exists() {
            Ok(p)
        } else {
            Err("DRIVE:missing_dependency".into())
        }
    })
}
/// Complete a new-device initialization without capturing the empty stage as an edit.
pub fn initialize(
    data: &Path,
    b: &Binding,
    initial: &Bundle,
    capture: impl FnMut() -> Res<Bundle>,
    apply: impl FnMut(&Bundle, &Bundle) -> Res<()>,
) -> Res<usize> {
    let path = dir(data, &b.vault_id).join("journal.json");
    if path.exists() {
        return Err("DRIVE:initialization_state_exists".into());
    }
    let mut j = Journal::load(&path, &b.vault_id, &device(data)?)?;
    j.baseline = documents(initial)?.0;
    j.save(&path)?;
    let result = run(data, b, false, capture, apply)?;
    let j = Journal::load(&path, &b.vault_id, &device(data)?)?;
    if j.batches.is_empty() && j.seed.is_none() {
        return Err("DRIVE:remote_empty_or_missing".into());
    }
    Ok(result)
}
pub fn has_local_changes(v: &crate::vault::Vault, j: &Journal, state: &Path) -> Res<bool> {
    Ok(documents(&streaming::capture(v, state)?)?.0 != j.baseline)
}
