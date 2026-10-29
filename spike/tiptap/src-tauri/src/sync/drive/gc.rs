//! Persisted, reproducible GC assessment. No destructive operation is enabled in this build.
//! Coverage alone does not prove retention, rollback, or stale-device safety.
use super::{
    core::{self, bytes, Journal},
    snapshot, RemoteBatch,
};
use crate::vault::{err, write_atomic, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assessment {
    schema_version: u32,
    vault_id: String,
    journal_digest: String,
    inventory_digest: String,
    covered_batches: BTreeMap<String, String>,
    retained_objects: BTreeSet<String>,
    coverage_verified: bool,
    destructive_enabled: bool,
    deferred_reasons: Vec<String>,
}
fn assess(j: &Journal, index: &BTreeMap<String, RemoteBatch>) -> Res<Assessment> {
    let mut candidates = BTreeMap::new();
    let mut retained = BTreeSet::new();
    let mut reasons = vec![
        "GC_DEFERRED:release_gates_incomplete".into(),
        "GC_DEFERRED:retention_and_stale_device_acknowledgements_unproven".into(),
    ];
    for batch in j.batches.values() {
        retained.extend(batch.required_objects.iter().cloned());
    }
    fn references(v: &Value, out: &mut BTreeSet<String>) {
        if let Some(h) = core::blob_hash(v) {
            out.insert(h.to_string());
        }
        match v {
            Value::Object(o) => {
                for v in o.values() {
                    references(v, out)
                }
            }
            Value::Array(a) => {
                for v in a {
                    references(v, out)
                }
            }
            _ => (),
        }
    }
    if let Some(seed) = &j.seed {
        seed.validate(&j.vault_id)?;
        retained.extend(seed.retained_objects.iter().cloned());
        references(
            &serde_json::to_value(&seed.state).map_err(err)?,
            &mut retained,
        );
        let expected = core::replay_seeded(&j.vault_id, &j.batches, &j.preimages, Some(seed))?;
        let mut tail = j.batches.clone();
        for (id, batch) in &j.batches {
            if seed.covers(batch)? {
                tail.remove(id);
                for (remote_id, file) in index {
                    if file.key == *id {
                        candidates.insert(remote_id.clone(), id.clone());
                    }
                }
            }
        }
        let restored = core::replay_seeded(&j.vault_id, &tail, &j.preimages, Some(seed))?;
        if bytes(&restored)? != bytes(&expected)? {
            return Err("DRIVE:gc_cold_replay_mismatch".into());
        }
    } else {
        reasons.push("GC_DEFERRED:verified_checkpoint_seed_missing".into());
    }
    if !j.outbox.is_empty() {
        reasons.push("GC_DEFERRED:pending_outbox".into());
        candidates.clear();
    }
    Ok(Assessment {
        schema_version: 1,
        vault_id: j.vault_id.clone(),
        journal_digest: snapshot::hash(&bytes(j)?),
        inventory_digest: snapshot::hash(&bytes(index)?),
        covered_batches: candidates,
        retained_objects: retained,
        coverage_verified: j.seed.is_some(),
        destructive_enabled: false,
        deferred_reasons: reasons,
    })
}
fn inventory(path: &Path) -> Res<BTreeMap<String, RemoteBatch>> {
    match fs::read(path.with_extension("inbox.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "DRIVE:inbox_corrupt".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(err(e)),
    }
}
pub fn dry_run(path: &Path, j: &Journal) -> Res<Value> {
    let report = assess(j, &inventory(path)?)?;
    write_atomic(&path.with_extension("gc-proof.json"), &bytes(&report)?)?;
    serde_json::to_value(report).map_err(err)
}
pub fn verify(path: &Path, j: &Journal) -> Res<Value> {
    let saved: Assessment = serde_json::from_slice(
        &fs::read(path.with_extension("gc-proof.json")).map_err(|_| "DRIVE:gc_dry_run_required")?,
    )
    .map_err(|_| "DRIVE:gc_proof_corrupt")?;
    let current = assess(j, &inventory(path)?)?;
    if saved != current {
        return Err("DRIVE:gc_proof_stale".into());
    }
    for h in &current.retained_objects {
        let object = path.with_extension("objects").join(h);
        if super::streaming::file_hash(&object).map_err(|_| "DRIVE:gc_object_unavailable")? != *h {
            return Err("DRIVE:integrity".into());
        }
    }
    Ok(json!({"verified":true,"destructiveEnabled":false,"proof":current}))
}
pub fn execute_guarded(path: &Path, j: &Journal) -> Res<Value> {
    let proof = verify(path, j)?;
    let receipt = json!({"schemaVersion":1,"state":"GC_DEFERRED","deleted":[],"quarantined":[],"reason":"release, retention, rollback and stale-device proofs required","proof":proof});
    write_atomic(&path.with_extension("gc-execution.json"), &bytes(&receipt)?)?;
    Ok(receipt)
}
pub fn recover(path: &Path) -> Res<Value> {
    let receipt: Value = match fs::read(path.with_extension("gc-execution.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "DRIVE:gc_receipt_corrupt")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"state":"nothing_to_recover","destructiveEnabled":false}))
        }
        Err(e) => return Err(err(e)),
    };
    if receipt["schemaVersion"] != 1
        || receipt["deleted"] != json!([])
        || receipt["quarantined"] != json!([])
    {
        return Err("DRIVE:gc_recovery_requires_supported_writer".into());
    }
    Ok(receipt)
}
