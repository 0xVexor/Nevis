use super::*;
use std::sync::{Arc, Mutex};
const VAULT: &str = "11111111-1111-4111-8111-111111111111";
const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
#[derive(Default)]
struct Cloud {
    ids: u64,
    files: BTreeMap<String, Vec<u8>>,
    objects: BTreeMap<String, Vec<u8>>,
    lost: bool,
    rate: bool,
    writes: usize,
    bootstrap: Option<core::ReplaySeed>,
    expired: bool,
    paginated: bool,
    fail_second_page: bool,
    removed: BTreeSet<String>,
}
#[derive(Clone, Default)]
struct FakeDrive(Arc<Mutex<Cloud>>);
impl SyncStorageAdapter for FakeDrive {
    fn bootstrap(&mut self) -> Res<Option<Bootstrap>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .bootstrap
            .clone()
            .map(|seed| Bootstrap {
                seed,
                objects: BTreeMap::new(),
            }))
    }
    fn check(&mut self) -> Res<()> {
        Ok(())
    }
    fn reserve(&mut self) -> Res<String> {
        let mut c = self.0.lock().unwrap();
        c.ids += 1;
        Ok(format!("file-{}", c.ids))
    }
    fn start(&mut self) -> Res<String> {
        Ok("0".into())
    }
    fn inventory(&mut self) -> Res<Vec<RemoteBatch>> {
        let c = self.0.lock().unwrap();
        Ok(c.files
            .iter()
            .rev()
            .map(|(id, b)| {
                let batch: Batch = serde_json::from_slice(b).unwrap();
                RemoteBatch {
                    id: id.clone(),
                    digest: snapshot::hash(b),
                    key: batch.batch_id,
                }
            })
            .collect())
    }
    fn changes(&mut self, cursor: &str) -> Res<ChangePage> {
        let files = self.inventory()?;
        let mut c = self.0.lock().unwrap();
        if c.expired {
            c.expired = false;
            return Err("DRIVE:cursor_expired".into());
        }
        if c.paginated {
            let half = (files.len() + 1) / 2;
            if cursor == "second" {
                if c.fail_second_page {
                    c.fail_second_page = false;
                    return Err("DRIVE:network".into());
                }
                return Ok(ChangePage {
                    files: files[half..].to_vec(),
                    next: None,
                    final_cursor: Some("final".into()),
                    removed: c.removed.clone(),
                    checkpoint_changed: false,
                });
            }
            return Ok(ChangePage {
                files: files[..half].to_vec(),
                next: Some("second".into()),
                final_cursor: None,
                removed: c.removed.clone(),
                checkpoint_changed: false,
            });
        }
        Ok(ChangePage {
            files,
            next: None,
            final_cursor: Some("current".into()),
            removed: c.removed.clone(),
            checkpoint_changed: c.bootstrap.is_some(),
        })
    }
    fn read_batch(&mut self, f: &RemoteBatch) -> Res<Vec<u8>> {
        let c = self.0.lock().unwrap();
        let b = c
            .files
            .get(&f.id)
            .ok_or("DRIVE:remote_unavailable")?
            .clone();
        if snapshot::hash(&b) != f.digest {
            return Err("DRIVE:integrity".into());
        }
        Ok(b)
    }
    fn publish(&mut self, id: &str, b: &Batch) -> Res<()> {
        let mut c = self.0.lock().unwrap();
        if c.rate {
            return Err("DRIVE:rate_limited:60".into());
        }
        let data = bytes(b)?;
        if let Some(old) = c.files.get(id) {
            if old != &data {
                return Err("DRIVE:id_collision".into());
            }
            return Ok(());
        }
        c.files.insert(id.into(), data);
        c.writes += 1;
        if c.lost {
            c.lost = false;
            return Err("DRIVE:network".into());
        }
        Ok(())
    }
    fn object(&mut self, h: &str, local: Option<&[u8]>) -> Res<Vec<u8>> {
        let mut c = self.0.lock().unwrap();
        if let Some(data) = c.objects.get(h) {
            return Ok(data.clone());
        }
        let data = local.ok_or("DRIVE:missing_dependency")?;
        if snapshot::hash(data) != h {
            return Err("DRIVE:integrity".into());
        }
        c.objects.insert(h.into(), data.to_vec());
        Ok(data.to_vec())
    }
}
struct Device {
    root: PathBuf,
    v: crate::vault::Vault,
    id: &'static str,
}
impl Device {
    fn new(id: &'static str) -> Self {
        let root = std::env::temp_dir().join(format!("nevis-drive-test-{}", uuid::Uuid::new_v4()));
        let v = crate::vault::Vault::create_with_id(root.join("vault"), "Test", VAULT).unwrap();
        Self { root, v, id }
    }
    fn path(&self) -> PathBuf {
        self.root.join("journal.json")
    }
    fn put(&self, title: &str, body: &str) {
        let p = json!({"id":VAULT,"title":title,"updatedAt":1,"deletedAt":null,"content":{"type":"doc","content":[{"type":"paragraph","attrs":{"stableBlockId":"first"},"content":[{"type":"text","text":body}]}]}});
        write_atomic(
            &self.v.pages_dir().join(format!("{VAULT}.json")),
            &bytes(&p).unwrap(),
        )
        .unwrap();
    }
    fn sync(&self, cloud: &FakeDrive) -> Res<usize> {
        synchronize(
            &mut cloud.clone(),
            &self.path(),
            VAULT,
            self.id,
            || streaming::capture(&self.v, &self.root),
            |a, b| streaming::apply(&self.v, &self.root, a, b),
        )
    }
    fn cold(&self, cloud: &FakeDrive) -> Res<usize> {
        let mut j = Journal::load(&self.path(), VAULT, self.id)?;
        j.baseline = documents(&streaming::capture(&self.v, &self.root)?)?.0;
        j.save(&self.path())?;
        self.sync(cloud)
    }
    fn docs(&self) -> Documents {
        documents(&streaming::capture(&self.v, &self.root).unwrap())
            .unwrap()
            .0
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn immutable_publish_unknown_response_and_restart_100_times() {
    for _ in 0..100 {
        let cloud = FakeDrive::default();
        let a = Device::new(A);
        a.put("فارسی 🧪", "offline");
        cloud.0.lock().unwrap().lost = true;
        assert_eq!(a.sync(&cloud).unwrap_err(), "DRIVE:network");
        let pending = Journal::load(&a.path(), VAULT, A).unwrap();
        assert_eq!(pending.outbox.len(), 1);
        let seq = pending.outbox[0].batch.sequence;
        let id = pending.outbox[0].remote_id.clone();
        a.sync(&cloud).unwrap();
        let done = Journal::load(&a.path(), VAULT, A).unwrap();
        assert!(done.outbox.is_empty());
        assert_eq!(done.batches.values().next().unwrap().sequence, seq);
        assert!(id.is_some());
        assert_eq!(cloud.0.lock().unwrap().writes, 1);
    }
}
#[test]
fn two_devices_independent_fields_and_cold_restore() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    a.put("title A", "old");
    b.put("base", "متن ب");
    a.sync(&cloud).unwrap();
    b.sync(&cloud).unwrap();
    a.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    let doc = a
        .docs()
        .get(&format!("pages/{VAULT}.json"))
        .unwrap()
        .clone();
    assert_eq!(doc["title"], "title A");
    assert!(bytes(&doc)
        .unwrap()
        .windows("متن ب".len())
        .any(|x| x == "متن ب".as_bytes()));
    let c = Device::new(C);
    c.cold(&cloud).unwrap();
    assert_eq!(a.docs(), c.docs());
}
#[test]
fn same_block_conflict_and_resolution_is_durable() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    a.put("base", "A");
    b.put("base", "B");
    a.sync(&cloud).unwrap();
    b.sync(&cloud).unwrap();
    a.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    let state = core::replay(VAULT, &j.batches, &j.preimages).unwrap();
    assert!(!state.conflicts.is_empty());
    let c = state.conflicts.values().next().unwrap();
    let before = snapshot::capture(&a.v).unwrap();
    // Use the pure journal resolver with app-data device identity matching this fixture.
    let data = a.root.join("app");
    write_atomic(&data.join("drive/device.json"), &bytes(&A).unwrap()).unwrap();
    let p = dir(&data, VAULT).join("journal.json");
    j.save(&p).unwrap();
    let after = resolve(&data, VAULT, &c.id, "remote", &before).unwrap();
    snapshot::apply(&a.v, &before, &after).unwrap();
    let resolved = Journal::load(&p, VAULT, A).unwrap();
    let result = core::replay(VAULT, &resolved.batches, &resolved.preimages).unwrap();
    assert!(!result.conflicts.contains_key(&c.id));
    assert!(!resolved.outbox.is_empty());
    assert!(resolved.batches.len() > j.batches.len());
}
#[test]
fn no_changes_produces_zero_remote_writes() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    let count = cloud.0.lock().unwrap().writes;
    for _ in 0..20 {
        a.sync(&cloud).unwrap();
    }
    assert_eq!(cloud.0.lock().unwrap().writes, count);
}
#[test]
fn quota_preserves_outbox_and_local_edit() {
    let cloud = FakeDrive::default();
    cloud.0.lock().unwrap().rate = true;
    let a = Device::new(A);
    a.put("base", "offline");
    let before = a.docs();
    assert!(a
        .sync(&cloud)
        .unwrap_err()
        .starts_with("DRIVE:rate_limited:"));
    assert_eq!(a.docs(), before);
    assert!(!Journal::load(&a.path(), VAULT, A)
        .unwrap()
        .outbox
        .is_empty());
    cloud.0.lock().unwrap().rate = false;
    a.sync(&cloud).unwrap();
}
#[test]
fn page_delete_offline_edit_resurrects_and_archives() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    let p = a.v.pages_dir().join(format!("{VAULT}.json"));
    let mut page: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    page["deletedAt"] = json!(999);
    write_atomic(&p, &bytes(&page).unwrap()).unwrap();
    b.put("base", "offline edit");
    a.sync(&cloud).unwrap();
    b.sync(&cloud).unwrap();
    a.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    assert!(a.docs()[&format!("pages/{VAULT}.json")]["deletedAt"].is_null());
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    assert!(!core::replay(VAULT, &j.batches, &j.preimages)
        .unwrap()
        .conflicts
        .is_empty());
}
#[test]
fn reject_schema_hash_and_device_sequence_collision() {
    let a = Device::new(A);
    a.put("x", "y");
    let mut j = Journal::load(&a.path(), VAULT, A).unwrap();
    j.capture(&a.docs()).unwrap();
    let b = j.batches.values().next().unwrap().clone();
    let mut bad = b.clone();
    bad.schema_version = 99;
    assert!(bad.validate(VAULT).is_err());
    let mut bad = b.clone();
    bad.batch_id = "00".repeat(32);
    assert!(bad.validate(VAULT).is_err());
    let mut collision = b.clone();
    collision.operations[0].next = Some(json!({"bad":true}));
    collision = collision.seal().unwrap();
    assert_eq!(
        j.ingest(collision).unwrap_err(),
        "DRIVE:device_id_collision"
    );
}
#[test]
fn missing_sequence_and_previous_hash_fail_closed() {
    let a = Device::new(A);
    a.put("x", "y");
    let mut j = Journal::load(&a.path(), VAULT, A).unwrap();
    j.capture(&a.docs()).unwrap();
    let mut b = j.batches.values().next().unwrap().clone();
    b.sequence = 2;
    b.previous_batch_id = Some("ff".repeat(32));
    b.seen_frontier.insert(A.into(), 1);
    b = b.seal().unwrap();
    assert_eq!(
        core::replay(
            VAULT,
            &BTreeMap::from([(b.batch_id.clone(), b)]),
            &BTreeMap::new()
        )
        .unwrap_err(),
        "DRIVE:waiting_dependency"
    );
}
#[test]
fn canonical_seeded_10000_permutations() {
    let d = Device::new(A);
    d.put("base", "old");
    let mut base = Journal::load(&d.path(), VAULT, A).unwrap();
    base.capture(&d.docs()).unwrap();
    let mut batches = base.batches.clone();
    let mut images = base.preimages.clone();
    for (id, text) in [(B, "B"), (C, "C")] {
        let mut j = base.clone();
        j.device_id = id.into();
        d.put("base", text);
        j.capture(&d.docs()).unwrap();
        batches.extend(j.batches);
        images.extend(j.preimages);
    }
    let expected = core::replay(VAULT, &batches, &images).unwrap();
    let values: Vec<_> = batches.values().cloned().collect();
    let mut seed = 0x4e45564953u64;
    for _ in 0..10_000 {
        let mut reordered = BTreeMap::new();
        let mut pending = values.clone();
        while !pending.is_empty() {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let b = pending.remove((seed as usize) % pending.len());
            reordered.insert(b.batch_id.clone(), b);
        }
        assert_eq!(core::replay(VAULT, &reordered, &images).unwrap(), expected);
    }
}
#[test]
fn stable_identity_migration_and_copy_preservation() {
    let a = Device::new(A);
    a.put("فارسی", "🧪");
    stable::migrate(&a.v).unwrap();
    let one = fs::read(a.v.pages_dir().join(format!("{VAULT}.json"))).unwrap();
    stable::migrate(&a.v).unwrap();
    assert_eq!(
        one,
        fs::read(a.v.pages_dir().join(format!("{VAULT}.json"))).unwrap()
    );
    let value: Value = serde_json::from_slice(&one).unwrap();
    assert_eq!(
        stable::denormalize(&stable::normalize(&value)).unwrap(),
        value
    );
}
#[test]
fn small_edit_batch_contains_delta_and_recoverable_preimage() {
    let a = Device::new(A);
    a.put("a", "long body");
    let mut j = Journal::load(&a.path(), VAULT, A).unwrap();
    j.capture(&a.docs()).unwrap();
    a.put("b", "long body");
    j.capture(&a.docs()).unwrap();
    let b = &j.outbox.last().unwrap().batch;
    assert!(b.operations.iter().any(|o| o.delta.is_some()));
    for o in &b.operations {
        if let Some(d) = &o.delta {
            assert!(j.preimages.contains_key(&d.base_hash));
            assert!(b.required_objects.contains(&d.base_hash));
        }
    }
    let state = core::replay(VAULT, &j.batches, &j.preimages).unwrap();
    assert_eq!(state.documents, a.docs());
}
#[test]
fn local_changed_during_http_does_not_overwrite() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("a", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    b.put("remote", "changed");
    b.sync(&cloud).unwrap();
    let result = synchronize(
        &mut cloud.clone(),
        &a.path(),
        VAULT,
        A,
        || snapshot::capture(&a.v),
        |before, after| {
            a.put("typed during upload", "new");
            snapshot::apply(&a.v, before, after)
        },
    );
    assert_eq!(result.unwrap_err(), "SYNC:local_changed");
    assert_eq!(
        a.docs()[&format!("pages/{VAULT}.json")]["title"],
        "typed during upload"
    );
    a.sync(&cloud).unwrap();
    b.sync(&cloud).unwrap();
    a.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
}
#[test]
fn unsafe_paths_and_gc_fail_closed() {
    for p in [
        "../pages/a.json",
        "pages/CON.json",
        "pages/a.json/../b.json",
        "/pages/a.json",
        "kv/token.json",
        "files/ab/../../bad",
    ] {
        assert!(snapshot::safe_path(p).is_err());
    }
    let j = Journal::default();
    let plan = core::gc_plan(&j);
    assert_eq!(plan["destructiveEnabled"], false);
    assert_eq!(plan["candidates"], 0);
}
#[test]
fn http_error_taxonomy_redacts_response_details() {
    assert_eq!(
        transport::classify(429, "private title access_token=secret", 99),
        "DRIVE:rate_limited:99"
    );
    assert_eq!(
        transport::classify(403, "rateLimitExceeded", 1),
        "DRIVE:rate_limited:60"
    );
    assert_eq!(
        transport::classify(403, "storageQuotaExceeded", 1),
        "DRIVE:storage_full"
    );
    assert_eq!(
        transport::classify(403, "forbidden", 1),
        "DRIVE:permission_denied"
    );
    assert_eq!(
        transport::classify(401, "secret", 1),
        "DRIVE:sign_in_required"
    );
    assert_eq!(transport::classify(404, "", 1), "DRIVE:remote_unavailable");
    assert_eq!(transport::classify(409, "", 1), "DRIVE:id_collision");
    assert_eq!(transport::classify(410, "", 1), "DRIVE:cursor_expired");
    assert_eq!(transport::classify(503, "", 1), "DRIVE:service_unavailable");
}
#[test]
fn benchmark_1000_pages_1000_assets_cold_restore() {
    let started = std::time::Instant::now();
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    for i in 0..1000 {
        let id = uuid::Uuid::new_v4().to_string();
        let content:Vec<_>=(0..10).map(|n|json!({"type":"paragraph","attrs":{"stableBlockId":format!("block-{i}-{n}")},"content":[{"type":"text","text":format!("متن آزمایشی 🧪 {i}/{n}")}]})).collect();
        let page = json!({"id":id,"title":format!("صفحه {i}"),"content":{"type":"doc","content":content},"updatedAt":1,"deletedAt":null});
        write_atomic(
            &a.v.pages_dir().join(format!("{id}.json")),
            &bytes(&page).unwrap(),
        )
        .unwrap();
        let asset = format!("attachment-{i}").repeat(100).into_bytes();
        let hash = snapshot::hash(&asset);
        a.v.file_put(&hash, &asset, "text/plain", "fixture", 0)
            .unwrap();
    }
    a.sync(&cloud).unwrap();
    let published = started.elapsed();
    let b = Device::new(B);
    b.cold(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    assert_eq!(a.v.files_list().len(), 1000);
    assert_eq!(b.v.files_list().len(), 1000);
    let c = cloud.0.lock().unwrap();
    let wire: usize = c.files.values().map(Vec::len).sum::<usize>()
        + c.objects.values().map(Vec::len).sum::<usize>();
    println!("DRIVE_BENCH pages=1000 blocks=10000 assets=1000 publish_ms={} total_restore_ms={} immutable_batches={} remote_bytes={wire}",published.as_millis(),started.elapsed().as_millis(),c.files.len());
}
#[test]
fn benchmark_10000_changes_replay() {
    let started = std::time::Instant::now();
    let a = Device::new(A);
    let mut j = Journal::load(&a.path(), VAULT, A).unwrap();
    for i in 0..10000 {
        j.capture(&Documents::from([("kv/tags.json".into(), json!({"n":i}))]))
            .unwrap();
    }
    let captured = started.elapsed();
    let state = core::replay(VAULT, &j.batches, &j.preimages).unwrap();
    assert_eq!(state.documents["kv/tags.json"]["n"], 9999);
    assert_eq!(state.frontier[A], 10000);
    println!(
        "DRIVE_BENCH changes=10000 capture_ms={} total_ms={} batches={} journal_bytes={}",
        captured.as_millis(),
        started.elapsed().as_millis(),
        j.batches.len(),
        bytes(&j).unwrap().len()
    );
}
#[test]
fn all_13_record_types_retain_identity_and_field_values() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    for (kind, dir) in crate::database::KINDS {
        let id = format!("fixture-{kind}");
        let record =
            json!({"format":1,"id":id,"kind":kind,"revision":"1","values":{"فارسی":"🧪","n":42}});
        write_atomic(
            &a.v.root
                .join("databases")
                .join(dir)
                .join(format!("{}.json", crate::database::enc(&id).unwrap())),
            &bytes(&record).unwrap(),
        )
        .unwrap();
    }
    a.sync(&cloud).unwrap();
    let b = Device::new(B);
    b.cold(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    for (_, dir) in crate::database::KINDS {
        assert!(
            fs::read_dir(b.v.root.join("databases").join(dir))
                .unwrap()
                .count()
                > 0
        );
    }
}
#[test]
fn patch_null_and_missing_have_distinct_canonical_encoding() {
    let a = core::Patch {
        pointer: vec!["deletedAt".into()],
        base: Some(Value::Null),
        next: None,
    };
    let b: core::Patch = serde_json::from_slice(&bytes(&a).unwrap()).unwrap();
    assert_eq!(b, a);
    assert!(b.base.is_some());
    assert!(b.next.is_none());
}
#[test]
fn corrupt_journal_fails_closed_without_resetting_sequence() {
    let a = Device::new(A);
    write_atomic(&a.path(), b"{truncated").unwrap();
    assert!(Journal::load(&a.path(), VAULT, A).is_err());
    assert_eq!(fs::read(a.path()).unwrap(), b"{truncated");
}
#[test]
fn missing_asset_defers_entire_apply_and_preserves_inbox_log() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("asset", "text");
    let data = b"attachment";
    a.v.file_put(&snapshot::hash(data), data, "text/plain", "fixture", 0)
        .unwrap();
    a.sync(&cloud).unwrap();
    cloud.0.lock().unwrap().objects.clear();
    let before = b.docs();
    assert_eq!(b.cold(&cloud).unwrap_err(), "DRIVE:missing_dependency");
    assert_eq!(b.docs(), before);
    let j = Journal::load(&b.path(), VAULT, B).unwrap();
    assert!(!j.batches.is_empty());
}
#[test]
fn vanished_vault_never_recreates_or_publishes_deletes() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    a.put("safe", "text");
    a.sync(&cloud).unwrap();
    let writes = cloud.0.lock().unwrap().writes;
    fs::remove_dir_all(&a.v.root).unwrap();
    assert!(a.sync(&cloud).is_err());
    assert!(!a.v.root.exists());
    assert_eq!(cloud.0.lock().unwrap().writes, writes);
}
#[test]
fn capture_coalesces_1000_raw_local_edits() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    for i in 0..1000 {
        a.put("title", &format!("edit {i}"));
    }
    a.sync(&cloud).unwrap();
    assert_eq!(cloud.0.lock().unwrap().writes, 1);
    assert!(bytes(&a.docs())
        .unwrap()
        .windows(8)
        .any(|s| s == b"edit 999"));
}
#[test]
fn legacy_migration_is_deterministic_without_existing_ids() {
    let a = Device::new(A);
    let b = Device::new(B);
    let value = json!({"id":VAULT,"title":"legacy","content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"فارسی 🧪"}]},{"type":"paragraph","content":[]}]},"updatedAt":1});
    for v in [&a.v, &b.v] {
        write_atomic(
            &v.pages_dir().join(format!("{VAULT}.json")),
            &bytes(&value).unwrap(),
        )
        .unwrap();
        stable::migrate(v).unwrap();
    }
    assert_eq!(a.docs(), b.docs());
    let page = &a.docs()[&format!("pages/{VAULT}.json")];
    assert!(bytes(page).unwrap().windows(3).any(|s| s == b"v1-"));
}
#[test]
fn checkpoint_scheduler_requires_age_or_causal_budget() {
    let m = checkpoint::Checkpoint {
        protocol: "nevis-drive-sync".into(),
        schema_version: 1,
        vault_id: VAULT.into(),
        frontier: BTreeMap::from([(A.into(), 10)]),
        heads: Default::default(),
        covered_batches: Default::default(),
        audit_tombstones: Default::default(),
        provenance: Default::default(),
        replay_archive: None,
        retained_objects: BTreeSet::new(),
        inventory: Default::default(),
        tombstones: Default::default(),
        created_at: 1000,
        manifest_digest: String::new(),
    };
    assert!(!checkpoint::due(
        &BTreeMap::from([(A.into(), 999)]),
        Some(&m),
        2000
    ));
    assert!(checkpoint::due(
        &BTreeMap::from([(A.into(), 1010)]),
        Some(&m),
        2000
    ));
    assert!(checkpoint::due(
        &m.frontier,
        Some(&m),
        1000 + 24 * 3600 * 1000
    ));
}
#[test]
fn empty_remote_bootstrap_is_not_a_valid_empty_vault() {
    let cloud = FakeDrive::default();
    let b = Device::new(B);
    let before = b.docs();
    assert_eq!(b.cold(&cloud).unwrap_err(), "DRIVE:remote_empty_or_missing");
    assert_eq!(before, b.docs());
    assert_eq!(cloud.0.lock().unwrap().writes, 0);
}
#[test]
fn existing_provider_conflict_archives_survive_migration_and_cold_restore() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    let id = uuid::Uuid::new_v4().to_string();
    let archive = json!({"id":id,"path":format!("pages/{VAULT}.json"),"createdAt":1,"base":null,"local":B64.encode(bytes(&json!({"id":VAULT,"title":"losing edit","content":{"type":"doc","content":[]}})).unwrap()),"remote":null});
    write_atomic(
        &a.v.root.join("conflicts").join(format!("{id}.json")),
        &bytes(&archive).unwrap(),
    )
    .unwrap();
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    let received: Value = serde_json::from_slice(
        &fs::read(b.v.root.join("conflicts").join(format!("{id}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(received, archive);
}

fn paragraph(id: &str, text: &str) -> Value {
    json!({"type":"paragraph","attrs":{"stableBlockId":id},"content":[{"type":"text","text":text}]})
}
fn columns() -> Value {
    json!({"type":"doc","content":[{"type":"layoutGroup","attrs":{"stableBlockId":"group","widths":[33,34,33],"direction":"rtl"},"content":[{"type":"layoutColumn","attrs":{"stableBlockId":"left"},"content":[paragraph("moving","original"),paragraph("left-stay","left")]},{"type":"layoutColumn","attrs":{"stableBlockId":"middle"},"content":[paragraph("middle-stay","middle")]},{"type":"layoutColumn","attrs":{"stableBlockId":"right"},"content":[paragraph("right-stay","right")]}]}]})
}
fn document(d: &Device, content: Value) {
    let page =
        json!({"id":VAULT,"title":"ساختار 🧪","updatedAt":1,"deletedAt":null,"content":content});
    let data = bytes(&page).unwrap();
    snapshot::validate(&format!("pages/{VAULT}.json"), &data).unwrap();
    write_atomic(&d.v.pages_dir().join(format!("{VAULT}.json")), &data).unwrap();
}
fn read_content(d: &Device) -> Value {
    let page: Value =
        serde_json::from_slice(&fs::read(d.v.pages_dir().join(format!("{VAULT}.json"))).unwrap())
            .unwrap();
    page["content"].clone()
}
fn move_to(content: &mut Value, column: usize) {
    let node = content["content"][0]["content"][0]["content"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    content["content"][0]["content"][column]["content"]
        .as_array_mut()
        .unwrap()
        .push(node);
}
fn join_pair(a: &Device, b: &Device, cloud: &FakeDrive) {
    a.sync(cloud).unwrap();
    b.sync(cloud).unwrap();
    a.sync(cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
}
#[test]
fn moved_block_and_offline_text_edit_merge_across_parents() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    document(&a, columns());
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    let mut ca = read_content(&a);
    move_to(&mut ca, 1);
    document(&a, ca);
    let mut cb = read_content(&b);
    cb["content"][0]["content"][0]["content"][0]["content"][0]["text"] = json!("edited offline");
    document(&b, cb);
    join_pair(&a, &b, &cloud);
    let content = read_content(&a);
    assert_eq!(
        content["content"][0]["content"][1]["content"][1]["attrs"]["stableBlockId"],
        "moving"
    );
    assert_eq!(
        content["content"][0]["content"][1]["content"][1]["content"][0]["text"],
        "edited offline"
    );
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    assert!(core::replay(VAULT, &j.batches, &j.preimages)
        .unwrap()
        .conflicts
        .is_empty());
}
#[test]
fn concurrent_moves_have_one_identity_and_both_parent_candidates() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    document(&a, columns());
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    let mut ca = read_content(&a);
    move_to(&mut ca, 1);
    document(&a, ca);
    let mut cb = read_content(&b);
    move_to(&mut cb, 2);
    document(&b, cb);
    join_pair(&a, &b, &cloud);
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    let state = core::replay(VAULT, &j.batches, &j.preimages).unwrap();
    let conflict = state
        .conflicts
        .values()
        .find(|c| c.pointer.ends_with("/parent"))
        .unwrap();
    let aa = stable::denormalize(conflict.a.as_ref().unwrap()).unwrap();
    let bb = stable::denormalize(conflict.b.as_ref().unwrap()).unwrap();
    assert_ne!(aa, bb);
    stable::validate(&aa).unwrap();
    stable::validate(&bb).unwrap();
    let current = stable::denormalize(&state.documents[&format!("pages/{VAULT}.json")]).unwrap();
    stable::validate(&current).unwrap();
    assert_eq!(
        current["content"]["content"][0]["content"][2]["content"][1]["attrs"]["stableBlockId"],
        "moving"
    );
}
#[test]
fn parent_delete_and_child_append_restore_valid_ancestors_with_archive() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    document(&a, columns());
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    document(
        &a,
        json!({"type":"doc","content":[paragraph("replacement","parent deleted")]}),
    );
    let mut cb = read_content(&b);
    cb["content"][0]["content"][0]["content"]
        .as_array_mut()
        .unwrap()
        .push(paragraph("new-child", "must survive"));
    document(&b, cb);
    join_pair(&a, &b, &cloud);
    let content = read_content(&a);
    assert!(bytes(&content)
        .unwrap()
        .windows(12)
        .any(|b| b == b"must survive"));
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    let state = core::replay(VAULT, &j.batches, &j.preimages).unwrap();
    assert!(state.conflicts.values().any(|c| c.pointer == "/content"));
    snapshot::validate(
        &format!("pages/{VAULT}.json"),
        &fs::read(a.v.pages_dir().join(format!("{VAULT}.json"))).unwrap(),
    )
    .unwrap();
}
#[test]
fn simultaneous_inserts_keep_both_in_deterministic_order_without_conflict() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    document(&a, columns());
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    let mut ca = read_content(&a);
    ca["content"]
        .as_array_mut()
        .unwrap()
        .insert(0, paragraph("insert-a", "A"));
    document(&a, ca);
    let mut cb = read_content(&b);
    cb["content"]
        .as_array_mut()
        .unwrap()
        .insert(0, paragraph("insert-b", "B"));
    document(&b, cb);
    join_pair(&a, &b, &cloud);
    let content = read_content(&a);
    assert_eq!(content["content"][0]["attrs"]["stableBlockId"], "insert-a");
    assert_eq!(content["content"][1]["attrs"]["stableBlockId"], "insert-b");
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    assert!(core::replay(VAULT, &j.batches, &j.preimages)
        .unwrap()
        .conflicts
        .is_empty());
}
#[test]
fn tree_roundtrip_preserves_rich_text_and_reserved_unknown_fields() {
    let content = columns();
    assert_eq!(
        stable::denormalize(&stable::normalize(&content)).unwrap(),
        content
    );
    let opaque = json!({"$nevisTreeV1":{"customer":"literal"},"other":42});
    assert_eq!(
        stable::denormalize(&stable::normalize(&opaque)).unwrap(),
        opaque
    );
    let doc = json!({"type":"doc","content":[{"type":"customPlugin","attrs":{"stableBlockId":"unknown","opaque":{"a":1}},"content":[{"type":"text","text":"فارسی 🧪","marks":[{"type":"strong"},{"type":"link","attrs":{"href":"https://example.test"}}]}]}]});
    assert_eq!(stable::denormalize(&stable::normalize(&doc)).unwrap(), doc);
}

fn checkpoint_cloud(a: &Device, cloud: &FakeDrive) -> checkpoint::Checkpoint {
    let journal = Journal::load(&a.path(), VAULT, a.id).unwrap();
    let bundle = settings::cloud_bundle(&snapshot::capture(&a.v).unwrap()).unwrap();
    let manifest = checkpoint::Checkpoint::from_journal(VAULT, &bundle, &journal, 1).unwrap();
    let replay = core::history(&journal).unwrap();
    let archive = checkpoint::encode_history(&replay).unwrap();
    write_atomic(
        &a.path()
            .with_extension("objects")
            .join(snapshot::hash(&archive)),
        &archive,
    )
    .unwrap();
    let seed = checkpoint::seed(&manifest, &bundle, replay).unwrap();
    cloud.0.lock().unwrap().bootstrap = Some(seed);
    manifest
}
#[test]
fn checkpoint_bootstrap_after_all_covered_streams_removed() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    a.put("base", "all retained");
    let data = b"checkpoint attachment";
    a.v.file_put(&snapshot::hash(data), data, "text/plain", "fixture", 0)
        .unwrap();
    a.sync(&cloud).unwrap();
    let m = checkpoint_cloud(&a, &cloud);
    assert!(!m.covered_batches.is_empty());
    cloud.0.lock().unwrap().files.clear();
    let b = Device::new(B);
    b.cold(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    assert_eq!(b.v.file_get(&snapshot::hash(data)).unwrap(), data);
    assert!(Journal::load(&b.path(), VAULT, B)
        .unwrap()
        .batches
        .is_empty());
}
#[test]
fn checkpoint_tail_preserves_offline_preimage_and_new_device_sequence() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let old = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    old.cold(&cloud).unwrap();
    old.put("base", "offline B");
    a.put("remote title", "old");
    a.sync(&cloud).unwrap();
    checkpoint_cloud(&a, &cloud);
    cloud.0.lock().unwrap().files.clear();
    old.sync(&cloud).unwrap();
    let c = Device::new(C);
    c.cold(&cloud).unwrap();
    assert_eq!(old.docs(), c.docs());
    let page = &c.docs()[&format!("pages/{VAULT}.json")];
    assert_eq!(page["title"], "remote title");
    assert!(bytes(page).unwrap().windows(9).any(|s| s == b"offline B"));
    let journal = Journal::load(&old.path(), VAULT, B).unwrap();
    assert_eq!(journal.capture_frontier[B], 1);
    assert!(journal.outbox.is_empty());
}
#[test]
fn checkpoint_open_conflicts_keep_both_candidates_after_pruning() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    a.put("base", "A");
    b.put("base", "B");
    join_pair(&a, &b, &cloud);
    let m = checkpoint_cloud(&a, &cloud);
    assert!(m.inventory.keys().any(|p| p.starts_with("conflicts/")));
    cloud.0.lock().unwrap().files.clear();
    let c = Device::new(C);
    assert!(c.cold(&cloud).unwrap() > 0);
    let j = Journal::load(&c.path(), VAULT, C).unwrap();
    let seed = j.seed.as_ref().unwrap();
    assert!(!seed.state.conflicts.is_empty());
    for conflict in seed.state.conflicts.values() {
        assert!(conflict.a.is_some() && conflict.b.is_some());
    }
}
#[test]
fn seeded_replay_rejects_covered_sequence_fork() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    checkpoint_cloud(&a, &cloud);
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    let mut fork = j.batches.values().next().unwrap().clone();
    fork.operations[0].next = Some(json!({"fork":true}));
    fork = fork.seal().unwrap();
    let seed = cloud.0.lock().unwrap().bootstrap.clone().unwrap();
    assert_eq!(
        core::replay_seeded(
            VAULT,
            &BTreeMap::from([(fork.batch_id.clone(), fork)]),
            &j.preimages,
            Some(&seed)
        )
        .unwrap_err(),
        "DRIVE:device_id_collision"
    );
}
fn appearance_file(d: &Device, theme: &str, size: u64) {
    write_atomic(
        &d.v.root.join("kv/preferences.json"),
        &bytes(&json!({"not.settings":json!({"theme":theme,"fontSize":size}).to_string()}))
            .unwrap(),
    )
    .unwrap();
}
fn appearance_value(d: &Device) -> Value {
    let raw: Value =
        serde_json::from_slice(&fs::read(d.v.root.join("kv/preferences.json")).unwrap()).unwrap();
    serde_json::from_str(raw["not.settings"].as_str().unwrap()).unwrap()
}
#[test]
fn global_theme_syncs_but_device_local_font_never_enters_cloud_or_checkpoint() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "settings");
    settings::set(&a.v, "fontSize", settings::Scope::DeviceLocal).unwrap();
    appearance_file(&a, "dark", 23);
    a.sync(&cloud).unwrap();
    appearance_file(&b, "light", 31);
    b.cold(&cloud).unwrap();
    assert_eq!(appearance_value(&b), json!({"theme":"dark","fontSize":31}));
    assert_eq!(appearance_value(&a)["fontSize"], 23);
    fn assert_private(v: &Value) {
        match v {
            Value::Object(o) => {
                assert!(!o.get("fontSize").is_some_and(Value::is_number));
                for value in o.values() {
                    assert_private(value);
                }
            }
            Value::Array(a) => {
                for v in a {
                    assert_private(v)
                }
            }
            Value::String(s) => {
                if let Ok(v) = serde_json::from_str::<Value>(s) {
                    if !v.is_string() {
                        assert_private(&v);
                    }
                }
            }
            _ => (),
        }
    }
    let c = cloud.0.lock().unwrap();
    for data in c.files.values().chain(c.objects.values()) {
        if let Ok(v) = serde_json::from_slice::<Value>(data) {
            assert_private(&v);
        }
    }
    drop(c);
    let public = settings::cloud_bundle(&snapshot::capture(&a.v).unwrap()).unwrap();
    let prefs: Value =
        serde_json::from_slice(&public.decode().unwrap()["kv/preferences.json"]).unwrap();
    let fields: Value = serde_json::from_str(prefs["not.settings"].as_str().unwrap()).unwrap();
    assert!(fields.get("fontSize").is_none());
    let before = cloud.0.lock().unwrap().writes;
    appearance_file(&a, "dark", 29);
    a.sync(&cloud).unwrap();
    assert_eq!(cloud.0.lock().unwrap().writes, before);
    assert_eq!(appearance_value(&a)["fontSize"], 29);
}
#[test]
fn switching_settings_back_to_global_preserves_and_publishes_local_value() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "settings");
    settings::set(&a.v, "fontSize", settings::Scope::DeviceLocal).unwrap();
    appearance_file(&a, "dark", 25);
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    settings::set(&a.v, "fontSize", settings::Scope::Global).unwrap();
    join_pair(&a, &b, &cloud);
    assert_eq!(appearance_value(&b)["fontSize"], 25);
    assert_eq!(appearance_value(&a)["fontSize"], 25);
}
#[test]
fn split_capture_is_one_atomic_group_and_partial_publication_never_applies() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    for i in 0..450 {
        let id = uuid::Uuid::new_v4().to_string();
        let page = json!({"id":id,"title":format!("page {i}"),"updatedAt":1,"deletedAt":null,"content":{"type":"doc","content":[]}});
        write_atomic(
            &a.v.pages_dir().join(format!("{id}.json")),
            &bytes(&page).unwrap(),
        )
        .unwrap();
    }
    a.sync(&cloud).unwrap();
    let saved = cloud.0.lock().unwrap().files.clone();
    assert!(saved.len() >= 3);
    let first = saved
        .iter()
        .find(|(_, data)| serde_json::from_slice::<Batch>(data).unwrap().sequence == 1)
        .unwrap();
    cloud.0.lock().unwrap().files = BTreeMap::from([(first.0.clone(), first.1.clone())]);
    let before = b.docs();
    assert_eq!(b.cold(&cloud).unwrap_err(), "DRIVE:waiting_atomic_group");
    assert_eq!(b.docs(), before);
    cloud.0.lock().unwrap().files = saved;
    b.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    assert_eq!(b.v.pages_all().unwrap().len(), 450);
}
#[test]
fn large_json_record_uses_immutable_objects_and_small_batch_markers() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    let record = json!({"format":1,"id":"large","revision":1,"body":"پ".repeat(600_000)});
    write_atomic(
        &a.v.root.join("databases/comments/large.json"),
        &bytes(&record).unwrap(),
    )
    .unwrap();
    a.sync(&cloud).unwrap();
    let c = cloud.0.lock().unwrap();
    assert!(c.files.values().all(|b| b.len() < 512 * 1024));
    assert!(c.objects.values().any(|b| b.len() > 1_000_000));
    drop(c);
    b.cold(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
}
#[test]
fn conflict_identity_changes_when_the_same_values_recur_after_resolution() {
    let a = Device::new(A);
    let path = "kv/settings.json";
    let initial = Documents::from([(path.into(), json!({"value":"base"}))]);
    let mut left = Journal::load(&a.path(), VAULT, A).unwrap();
    left.capture(&initial).unwrap();
    let mut right = left.clone();
    right.device_id = B.into();
    let av = Documents::from([(path.into(), json!({"value":"A"}))]);
    let bv = Documents::from([(path.into(), json!({"value":"B"}))]);
    left.capture(&av).unwrap();
    right.capture(&bv).unwrap();
    left.batches.extend(right.batches);
    left.preimages.extend(right.preimages);
    let first = core::replay(VAULT, &left.batches, &left.preimages).unwrap();
    let first_ids: BTreeSet<_> = first.conflicts.keys().cloned().collect();
    assert_eq!(first_ids.len(), 1);
    // Explicit causal no-op resolves the already visible winner, then both devices observe a reset.
    let seq = first.frontier[A] + 1;
    let resolution = Batch {
        protocol: "nevis-drive-sync".into(),
        schema_version: 1,
        vault_id: VAULT.into(),
        device_id: A.into(),
        sequence: seq,
        previous_batch_id: core::local_head(&left),
        seen_frontier: first.frontier.clone(),
        operations: vec![core::Operation {
            path: path.into(),
            base: first.documents.get(path).cloned(),
            next: first.documents.get(path).cloned(),
            base_object: None,
            next_object: None,
            delta: None,
            resolves: first_ids.iter().cloned().collect(),
        }],
        atomic_group: None,
        required_objects: BTreeSet::new(),
        batch_id: String::new(),
    }
    .seal()
    .unwrap();
    left.batches.insert(resolution.batch_id.clone(), resolution);
    let resolved = core::replay(VAULT, &left.batches, &left.preimages).unwrap();
    assert!(resolved.conflicts.is_empty());
    left.baseline = resolved.documents;
    left.capture_frontier = resolved.frontier;
    left.capture(&initial).unwrap();
    right = left.clone();
    right.device_id = B.into();
    left.capture(&av).unwrap();
    right.capture(&bv).unwrap();
    left.batches.extend(right.batches);
    left.preimages.extend(right.preimages);
    let second = core::replay(VAULT, &left.batches, &left.preimages).unwrap();
    let second_ids: BTreeSet<_> = second.conflicts.keys().cloned().collect();
    assert_eq!(second_ids.len(), 1);
    assert!(first_ids.is_disjoint(&second_ids));
}
#[test]
fn database_same_identity_creation_archives_whole_candidates_and_delete_edit_resurrects() {
    let a = Device::new(A);
    let path = "databases/comments/c.json";
    let mut left = Journal::load(&a.path(), VAULT, A).unwrap();
    let mut right = left.clone();
    right.device_id = B.into();
    let av = Documents::from([(
        path.into(),
        json!({"id":"c","body":"A","onlyA":true,"deletedAt":null}),
    )]);
    let bv = Documents::from([(
        path.into(),
        json!({"id":"c","body":"B","onlyB":true,"deletedAt":null}),
    )]);
    left.capture(&av).unwrap();
    right.capture(&bv).unwrap();
    left.batches.extend(right.batches);
    left.preimages.extend(right.preimages);
    let state = core::replay(VAULT, &left.batches, &left.preimages).unwrap();
    assert!(state.documents == av || state.documents == bv);
    assert!(state
        .conflicts
        .values()
        .any(|c| c.pointer.is_empty() && c.a.is_some() && c.b.is_some()));
    let mut base = Journal::load(&a.path(), VAULT, A).unwrap();
    base.capture(&av).unwrap();
    let mut offline = base.clone();
    offline.device_id = B.into();
    let mut removed = av.clone();
    removed.get_mut(path).unwrap()["deletedAt"] = json!(99);
    base.capture(&removed).unwrap();
    let mut edited = av.clone();
    edited.get_mut(path).unwrap()["body"] = json!("offline edit");
    offline.capture(&edited).unwrap();
    base.batches.extend(offline.batches);
    base.preimages.extend(offline.preimages);
    let recovered = core::replay(VAULT, &base.batches, &base.preimages).unwrap();
    assert!(recovered.documents[path]["deletedAt"].is_null());
    assert_eq!(recovered.documents[path]["body"], "offline edit");
    assert!(recovered
        .conflicts
        .values()
        .any(|c| c.pointer == "/deletedAt"));
}
#[test]
fn gc_proof_is_durable_stale_sensitive_and_never_deletes_without_release_gates() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    a.put("base", "retained");
    a.sync(&cloud).unwrap();
    let manifest = checkpoint_cloud(&a, &cloud);
    let bundle = settings::cloud_bundle(&snapshot::capture(&a.v).unwrap()).unwrap();
    for data in bundle.decode().unwrap().values() {
        let h = snapshot::hash(data);
        write_atomic(&a.path().with_extension("objects").join(h), data).unwrap();
    }
    let mut j = Journal::load(&a.path(), VAULT, A).unwrap();
    j.seed = Some(checkpoint::seed(&manifest, &bundle, core::history(&j).unwrap()).unwrap());
    j.save(&a.path()).unwrap();
    let before = cloud.0.lock().unwrap().files.clone();
    let proof = gc::dry_run(&a.path(), &j).unwrap();
    assert_eq!(proof["coverageVerified"], true);
    assert_eq!(proof["destructiveEnabled"], false);
    assert!(!proof["coveredBatches"].as_object().unwrap().is_empty());
    gc::verify(&a.path(), &j).unwrap();
    let receipt = gc::execute_guarded(&a.path(), &j).unwrap();
    assert_eq!(receipt["state"], "GC_DEFERRED");
    assert_eq!(gc::recover(&a.path()).unwrap(), receipt);
    assert_eq!(cloud.0.lock().unwrap().files, before);
    j.last_verified_at += 1;
    assert_eq!(
        gc::verify(&a.path(), &j).unwrap_err(),
        "DRIVE:gc_proof_stale"
    );
}
#[test]
fn publication_throttle_keeps_outbox_durable_and_still_applies_remote_edits() {
    struct Throttled(FakeDrive);
    impl SyncStorageAdapter for Throttled {
        fn can_publish(&self) -> bool {
            false
        }
        fn check(&mut self) -> Res<()> {
            self.0.check()
        }
        fn reserve(&mut self) -> Res<String> {
            panic!("must not reserve during throttle")
        }
        fn start(&mut self) -> Res<String> {
            self.0.start()
        }
        fn inventory(&mut self) -> Res<Vec<RemoteBatch>> {
            self.0.inventory()
        }
        fn changes(&mut self, c: &str) -> Res<ChangePage> {
            self.0.changes(c)
        }
        fn read_batch(&mut self, f: &RemoteBatch) -> Res<Vec<u8>> {
            self.0.read_batch(f)
        }
        fn publish(&mut self, _: &str, _: &Batch) -> Res<()> {
            panic!("must not publish during throttle")
        }
        fn object(&mut self, h: &str, b: Option<&[u8]>) -> Res<Vec<u8>> {
            self.0.object(h, b)
        }
    }
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    a.put("remote title", "old");
    a.sync(&cloud).unwrap();
    b.put("base", "pending body");
    let before = cloud.0.lock().unwrap().writes;
    synchronize(
        &mut Throttled(cloud.clone()),
        &b.path(),
        VAULT,
        B,
        || snapshot::capture(&b.v),
        |a, c| snapshot::apply(&b.v, a, c),
    )
    .unwrap();
    assert_eq!(cloud.0.lock().unwrap().writes, before);
    let pending = Journal::load(&b.path(), VAULT, B).unwrap();
    assert!(!pending.outbox.is_empty());
    assert_eq!(b.v.pages_all().unwrap()[0]["title"], "remote title");
    b.sync(&cloud).unwrap();
    a.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    assert!(Journal::load(&b.path(), VAULT, B)
        .unwrap()
        .outbox
        .is_empty());
}
#[test]
fn keep_both_creates_a_causal_regular_page_copy_with_fresh_block_ids() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    a.put("base", "A");
    b.put("base", "B");
    join_pair(&a, &b, &cloud);
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    let materialized = core::replay(VAULT, &j.batches, &j.preimages).unwrap();
    let id = materialized.conflicts.keys().next().unwrap();
    let app = a.root.join("app");
    write_atomic(&app.join("drive/device.json"), &bytes(&A).unwrap()).unwrap();
    let path = dir(&app, VAULT).join("journal.json");
    j.save(&path).unwrap();
    let before = snapshot::capture(&a.v).unwrap();
    let after = resolve(&app, VAULT, id, "both", &before).unwrap();
    snapshot::apply(&a.v, &before, &after).unwrap();
    let pages = a.v.pages_all().unwrap();
    assert_eq!(pages.len(), 2);
    assert_ne!(pages[0]["id"], pages[1]["id"]);
    assert_ne!(
        pages[0]["content"]["content"][0]["attrs"]["stableBlockId"],
        pages[1]["content"]["content"][0]["attrs"]["stableBlockId"]
    );
    let r = Journal::load(&path, VAULT, A).unwrap();
    let result = core::replay(VAULT, &r.batches, &r.preimages).unwrap();
    assert!(!result.conflicts.contains_key(id));
    assert_eq!(r.outbox.last().unwrap().batch.operations.len(), 2);
}

#[test]
fn paginated_changes_failure_keeps_durable_inbox_before_advancing_cursor() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    for i in 0..4 {
        a.put(&format!("remote {i}"), "old");
        a.sync(&cloud).unwrap();
    }
    let before = b.docs();
    {
        let mut c = cloud.0.lock().unwrap();
        c.paginated = true;
        c.fail_second_page = true;
    }
    assert_eq!(b.sync(&cloud).unwrap_err(), "DRIVE:network");
    assert_eq!(b.docs(), before);
    let failed = Journal::load(&b.path(), VAULT, B).unwrap();
    assert_eq!(failed.cursor.as_deref(), Some("current"));
    assert!(!failed.inbox.is_empty());
    b.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    assert_eq!(
        Journal::load(&b.path(), VAULT, B)
            .unwrap()
            .cursor
            .as_deref(),
        Some("final")
    );
}
#[test]
fn expired_cursor_rescans_but_missing_uncovered_history_stops_without_deletion() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    a.put("new remote", "old");
    a.sync(&cloud).unwrap();
    cloud.0.lock().unwrap().expired = true;
    let before = b.docs();
    assert_eq!(b.sync(&cloud).unwrap_err(), "DRIVE:rescan_required");
    assert_eq!(b.docs(), before);
    assert!(Journal::load(&b.path(), VAULT, B).unwrap().cursor.is_none());
    b.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    let id = cloud.0.lock().unwrap().files.keys().next().unwrap().clone();
    {
        let mut c = cloud.0.lock().unwrap();
        c.files.remove(&id);
        c.removed.insert(id);
    }
    let before = b.docs();
    assert_eq!(b.sync(&cloud).unwrap_err(), "DRIVE:remote_history_removed");
    assert_eq!(b.docs(), before);
}
#[test]
fn stale_device_without_edits_rebootstraps_after_covered_stream_removal() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    a.put("after offline", "new");
    a.sync(&cloud).unwrap();
    let manifest = checkpoint_cloud(&a, &cloud);
    cloud.0.lock().unwrap().files.clear();
    b.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    let j = Journal::load(&b.path(), VAULT, B).unwrap();
    assert_eq!(j.capture_frontier, manifest.frontier);
    assert!(j.outbox.is_empty());
}
#[test]
fn checkpoint_gc_retains_object_only_referenced_by_older_history() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    a.put("base", "old");
    let asset = b"GIF89a older version";
    let id = snapshot::hash(asset);
    a.v.file_put(&id, asset, "image/gif", "old.gif", 1).unwrap();
    a.sync(&cloud).unwrap();
    let relative = format!("files/{}/{id}", &id[..2]);
    fs::remove_file(a.v.root.join(&relative)).unwrap();
    fs::remove_file(a.v.root.join(format!("{relative}.json"))).unwrap();
    a.sync(&cloud).unwrap();
    let manifest = checkpoint_cloud(&a, &cloud);
    assert!(!manifest.inventory.contains_key(&relative));
    assert!(manifest.retained_objects.contains(&id));
    let snapshot = settings::cloud_bundle(&snapshot::capture(&a.v).unwrap()).unwrap();
    let mut j = Journal::load(&a.path(), VAULT, A).unwrap();
    j.seed = Some(checkpoint::seed(&manifest, &snapshot, core::history(&j).unwrap()).unwrap());
    let proof = gc::dry_run(&a.path(), &j).unwrap();
    assert!(proof["retainedObjects"]
        .as_array()
        .unwrap()
        .contains(&json!(id)));
    assert_eq!(proof["destructiveEnabled"], false);
}
#[test]
fn streaming_media_128mib_capture_cold_restore_and_restart_avoid_bundle_bodies() {
    #[derive(Clone)]
    struct DiskDrive {
        batches: FakeDrive,
        objects: PathBuf,
    }
    impl SyncStorageAdapter for DiskDrive {
        fn check(&mut self) -> Res<()> {
            self.batches.check()
        }
        fn reserve(&mut self) -> Res<String> {
            self.batches.reserve()
        }
        fn start(&mut self) -> Res<String> {
            self.batches.start()
        }
        fn inventory(&mut self) -> Res<Vec<RemoteBatch>> {
            self.batches.inventory()
        }
        fn changes(&mut self, c: &str) -> Res<ChangePage> {
            self.batches.changes(c)
        }
        fn read_batch(&mut self, f: &RemoteBatch) -> Res<Vec<u8>> {
            self.batches.read_batch(f)
        }
        fn publish(&mut self, id: &str, b: &Batch) -> Res<()> {
            self.batches.publish(id, b)
        }
        fn object(&mut self, _: &str, _: Option<&[u8]>) -> Res<Vec<u8>> {
            panic!("streaming boundary must not request media bodies")
        }
        fn object_file(&mut self, h: &str, target: &Path, local: bool) -> Res<()> {
            let remote = self.objects.join(h);
            if !remote.exists() {
                if !local {
                    return Err("DRIVE:missing_dependency".into());
                }
                streaming::copy_verified(target, &remote, h)?;
            }
            if !target.exists() {
                streaming::copy_verified(&remote, target, h)?;
            }
            Ok(())
        }
    }
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("large media", "old");
    let source = a.root.join("media");
    let file = fs::File::create(&source).unwrap();
    file.set_len(128 * 1024 * 1024).unwrap();
    drop(file);
    let h = streaming::file_hash(&source).unwrap();
    let relative = format!("files/{}/{h}", &h[..2]);
    fs::create_dir_all(a.v.root.join(format!("files/{}", &h[..2]))).unwrap();
    fs::rename(source, a.v.root.join(&relative)).unwrap();
    write_atomic(&a.v.root.join(format!("{relative}.json")),&bytes(&json!({"id":h,"type":"application/octet-stream","size":128*1024*1024,"name":"large.bin","addedAt":1})).unwrap()).unwrap();
    let captured = streaming::capture(&a.v, &a.root).unwrap();
    assert!(captured.sources.contains_key(&relative));
    assert!(!captured.bytes.contains_key(&relative));
    assert!(captured.bytes.values().map(String::len).sum::<usize>() < 64 * 1024);
    captured.decode_metadata().unwrap();
    let mut drive = DiskDrive {
        batches: FakeDrive::default(),
        objects: a.root.join("remote-objects"),
    };
    synchronize(
        &mut drive,
        &a.path(),
        VAULT,
        A,
        || streaming::capture(&a.v, &a.root),
        |x, y| streaming::apply(&a.v, &a.root, x, y),
    )
    .unwrap();
    let mut journal = Journal::load(&b.path(), VAULT, B).unwrap();
    journal.baseline = documents(&streaming::capture(&b.v, &b.root).unwrap())
        .unwrap()
        .0;
    journal.save(&b.path()).unwrap();
    synchronize(
        &mut drive,
        &b.path(),
        VAULT,
        B,
        || streaming::capture(&b.v, &b.root),
        |x, y| streaming::apply(&b.v, &b.root, x, y),
    )
    .unwrap();
    assert_eq!(streaming::file_hash(&b.v.root.join(&relative)).unwrap(), h);
    assert_eq!(
        fs::metadata(b.v.root.join(&relative)).unwrap().len(),
        128 * 1024 * 1024
    );
    let restarted = streaming::capture(&b.v, &b.root).unwrap();
    assert!(!restarted.bytes.contains_key(&relative));
    assert_eq!(restarted.manifest, captured.manifest);
    assert!(!b.v.root.join(".noviq/drive-apply.json").exists());
}
#[test]
fn one_hundred_causal_batches_converge_across_twenty_incremental_arrival_orders() {
    let a = Device::new(A);
    let initial = Documents::from([("kv/settings.json".into(), json!({"shared":"base"}))]);
    let mut base = Journal::load(&a.path(), VAULT, A).unwrap();
    base.capture(&initial).unwrap();
    let mut batches = base.batches.clone();
    let mut preimages = base.preimages.clone();
    for device in [
        A,
        B,
        C,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ] {
        let mut j = base.clone();
        j.device_id = device.into();
        for n in 1..=20 {
            let value = json!({"shared":format!("{device}-{n}"),device:n});
            let docs = Documents::from([("kv/settings.json".into(), value)]);
            j.capture(&docs).unwrap();
        }
        batches.extend(j.batches);
        preimages.extend(j.preimages);
    }
    assert_eq!(batches.len(), 101);
    let expected = core::replay(VAULT, &batches, &preimages).unwrap();
    let mut seed = 0x100CA05Au64;
    for _ in 0..20 {
        let mut pending: Vec<_> = batches.values().cloned().collect();
        let mut arriving = Journal::load(&a.path(), VAULT, C).unwrap();
        while !pending.is_empty() {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let batch = pending.remove((seed as usize) % pending.len());
            arriving.ingest(batch).unwrap();
            match core::replay(VAULT, &arriving.batches, &preimages) {
                Ok(_) => (),
                Err(e) => assert_eq!(e, "DRIVE:waiting_dependency"),
            }
        }
        assert_eq!(
            core::replay(VAULT, &arriving.batches, &preimages).unwrap(),
            expected
        );
    }
}
#[test]
fn database_fields_merge_and_same_field_archives_keep_original_identity() {
    let a = Device::new(A);
    let path = "databases/comments/c.json";
    let initial = Documents::from([(
        path.into(),
        json!({"format":1,"id":"c","body":"base","color":"old","revision":1}),
    )]);
    let mut base = Journal::load(&a.path(), VAULT, A).unwrap();
    base.capture(&initial).unwrap();
    let mut left = base.clone();
    let mut right = base.clone();
    right.device_id = B.into();
    let mut l = initial.clone();
    l.get_mut(path).unwrap()["body"] = json!("A");
    l.get_mut(path).unwrap()["revision"] = json!(2);
    let mut r = initial.clone();
    r.get_mut(path).unwrap()["color"] = json!("blue");
    r.get_mut(path).unwrap()["revision"] = json!(2);
    left.capture(&l).unwrap();
    right.capture(&r).unwrap();
    left.batches.extend(right.batches);
    left.preimages.extend(right.preimages);
    let merged = core::replay(VAULT, &left.batches, &left.preimages).unwrap();
    assert_eq!(merged.documents[path]["body"], "A");
    assert_eq!(merged.documents[path]["color"], "blue");
    assert!(merged.conflicts.is_empty());
    let mut left = base.clone();
    let mut right = base;
    right.device_id = B.into();
    r = initial;
    r.get_mut(path).unwrap()["body"] = json!("B");
    left.capture(&l).unwrap();
    right.capture(&r).unwrap();
    left.batches.extend(right.batches);
    left.preimages.extend(right.preimages);
    let merged = core::replay(VAULT, &left.batches, &left.preimages).unwrap();
    assert_eq!(merged.documents.len(), 1);
    assert_eq!(merged.documents[path]["id"], "c");
    let conflict = merged
        .conflicts
        .values()
        .find(|c| c.pointer == "/body")
        .unwrap();
    assert_eq!(conflict.a.as_ref().unwrap()["id"], "c");
    assert_eq!(conflict.b.as_ref().unwrap()["id"], "c");
}
#[test]
fn independent_changes_continue_syncing_while_another_conflict_remains_open() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("base", "old");
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    a.put("base", "A");
    b.put("base", "B");
    join_pair(&a, &b, &cloud);
    let j = Journal::load(&a.path(), VAULT, A).unwrap();
    let conflict = core::replay(VAULT, &j.batches, &j.preimages)
        .unwrap()
        .conflicts;
    assert!(!conflict.is_empty());
    write_atomic(
        &a.v.root.join("kv/tags.json"),
        &bytes(&json!({"new":"independent"})).unwrap(),
    )
    .unwrap();
    join_pair(&a, &b, &cloud);
    let j = Journal::load(&b.path(), VAULT, B).unwrap();
    let state = core::replay(VAULT, &j.batches, &j.preimages).unwrap();
    assert_eq!(state.conflicts, conflict);
    assert_eq!(state.documents["kv/tags.json"]["new"], "independent");
    assert_eq!(a.docs(), b.docs());
}
#[test]
fn concurrent_single_relation_links_require_a_reviewed_atomic_decision() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    let b = Device::new(B);
    a.put("Database host", "body");
    let mut records = vec![
        (
            "databases/containers/c.json".to_string(),
            json!({"format":1,"id":"c","hostPageId":VAULT,"sourceLinks":[{"sourceId":"s","sortKey":"a"}]}),
        ),
        (
            "databases/sources/s.json".into(),
            json!({"format":1,"id":"s","ownerContainerId":"c","titlePropertyId":"title"}),
        ),
        (
            "databases/properties/title.json".into(),
            json!({"format":1,"id":"title","kind":"title","sourceId":"s"}),
        ),
        (
            "databases/properties/p.json".into(),
            json!({"format":1,"id":"p","kind":"relation","sourceId":"s","config":{"definitionId":"r","side":"forward"}}),
        ),
        (
            "databases/relations/r.json".into(),
            json!({"format":1,"id":"r","propertyId":"p","sourceId":"s","targetSourceId":"s","mode":"one_way","cardinality":"one","inverseCardinality":"many","inversePropertyId":null,"displayedPropertyIds":[]}),
        ),
    ];
    for (id, title) in [(A, "From"), (B, "Left"), (C, "Right")] {
        records.push((format!("pages/{id}.json"),json!({"id":id,"title":title,"deletedAt":null,"content":{"type":"doc","content":[]},"database":{"format":1,"sourceId":"s","parentItemId":null,"cells":{},"allocatedIds":{}}})));
    }
    for (path, value) in records {
        write_atomic(&a.v.root.join(path), &bytes(&value).unwrap()).unwrap();
    }
    a.sync(&cloud).unwrap();
    b.cold(&cloud).unwrap();
    for (device, id, to) in [(&a, "ea", B), (&b, "eb", C)] {
        write_atomic(&device.v.root.join(format!("databases/edges/{id}.json")),&bytes(&json!({"format":1,"id":id,"definitionId":"r","fromPageId":A,"toPageId":to,"deletedAt":null})).unwrap()).unwrap();
    }
    a.sync(&cloud).unwrap();
    let before_b = b.docs();
    assert_eq!(b.sync(&cloud).unwrap_err(), "DRIVE:db_relation_cardinality");
    assert_eq!(b.docs(), before_b);
    assert_eq!(a.sync(&cloud).unwrap_err(), "DRIVE:db_relation_cardinality");
    let data = a.root.join("app");
    write_atomic(&data.join("drive/device.json"), &bytes(&A).unwrap()).unwrap();
    let path = dir(&data, VAULT).join("journal.json");
    Journal::load(&a.path(), VAULT, A)
        .unwrap()
        .save(&path)
        .unwrap();
    let state = relation_conflicts::state(&data, VAULT).unwrap();
    let conflicts = relation_conflicts::list(&state).unwrap();
    let id = conflicts[0]["id"].as_str().unwrap();
    let preview = relation_conflicts::preview(&state, id, "eb").unwrap();
    let before = streaming::capture(&a.v, &a.root).unwrap();
    let decision = relation_conflicts::resolve(
        &data,
        VAULT,
        id,
        "eb",
        preview["digest"].as_str().unwrap(),
        &before,
    )
    .unwrap();
    assert_eq!(decision.remaining, 0);
    streaming::apply(&a.v, &a.root, &before, &decision.after.unwrap()).unwrap();
    Journal::load(&path, VAULT, A)
        .unwrap()
        .save(&a.path())
        .unwrap();
    join_pair(&a, &b, &cloud);
    assert_eq!(a.docs(), b.docs());
    let docs = a.docs();
    assert!(docs["databases/edges/eb.json"]["deletedAt"].is_null());
    assert!(!docs["databases/edges/ea.json"]["deletedAt"].is_null());
    assert_eq!(docs["databases/edges/ea.json"]["toPageId"], B);
    assert_eq!(docs["databases/edges/eb.json"]["toPageId"], C);
}
#[test]
fn journal_commit_failure_leaves_local_changes_and_never_starts_publication() {
    let cloud = FakeDrive::default();
    let a = Device::new(A);
    a.put("Saved local", "pending");
    let path = a.path();
    let mut first = true;
    let result = synchronize(
        &mut cloud.clone(),
        &path,
        VAULT,
        A,
        || {
            let bundle = streaming::capture(&a.v, &a.root)?;
            if first {
                fs::create_dir(&path).unwrap();
                first = false;
            }
            Ok(bundle)
        },
        |x, y| streaming::apply(&a.v, &a.root, x, y),
    );
    assert!(result.is_err());
    assert_eq!(cloud.0.lock().unwrap().writes, 0);
    assert_eq!(a.v.pages_all().unwrap()[0]["title"], "Saved local");
    fs::remove_dir(&path).unwrap();
    a.sync(&cloud).unwrap();
    assert_eq!(
        Journal::load(&path, VAULT, A).unwrap().capture_frontier[A],
        1
    );
}

#[test]
fn checkpoint_late_lower_actor_and_three_candidates_match_full_replay() {
    let cloud = FakeDrive::default();
    let b = Device::new(B);
    b.put("base", "base");
    b.sync(&cloud).unwrap();
    let a = Device::new(A);
    let c = Device::new(C);
    a.cold(&cloud).unwrap();
    c.cold(&cloud).unwrap();
    a.put("candidate A", "base");
    b.put("candidate B", "base");
    c.put("candidate C", "base");
    b.sync(&cloud).unwrap();
    c.sync(&cloud).unwrap();
    b.sync(&cloud).unwrap();
    let mut all = Journal::load(&a.path(), VAULT, A).unwrap();
    all.capture(&a.docs()).unwrap();
    {
        let remote = cloud.0.lock().unwrap();
        for raw in remote.files.values() {
            let batch: Batch = serde_json::from_slice(raw).unwrap();
            all.ingest(batch).unwrap();
        }
        for (hash, raw) in &remote.objects {
            if let Ok(value) = serde_json::from_slice(raw) {
                all.preimages.insert(hash.clone(), value);
            }
        }
    }
    let expected = core::replay(VAULT, &all.batches, &all.preimages).unwrap();
    assert!(!expected.conflicts.is_empty());
    checkpoint_cloud(&b, &cloud);
    cloud.0.lock().unwrap().files.clear();
    a.sync(&cloud).unwrap();
    let journal = Journal::load(&a.path(), VAULT, A).unwrap();
    let actual = core::replay_seeded(
        VAULT,
        &journal.batches,
        &journal.preimages,
        journal.seed.as_ref(),
    )
    .unwrap();
    assert_eq!(expected, actual);
    b.sync(&cloud).unwrap();
    let cold = Device::new(C);
    cold.cold(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    assert_eq!(a.docs(), cold.docs());
}

#[test]
fn opaque_blob_keys_roundtrip_without_hiding_database_identity() {
    for value in [
        json!({"$nevisBlob":"customer-data"}),
        json!({"$nevisLiteral":42}),
        json!({"$nevisNodes":{},"$nevisOrder":[]}),
        json!({"id":"record","$nevisTreeV1":{"customer":1},"$nevisBlob":"opaque","nested":{"$nevisBlob":"literal"}}),
    ] {
        let normalized = stable::normalize(&value);
        assert!(core::blob_hash(&normalized).is_none());
        if value["id"].is_string() {
            assert_eq!(normalized["id"], value["id"]);
        }
        assert_eq!(stable::denormalize(&normalized).unwrap(), value);
    }
    let mut journal = Journal::load(&Device::new(A).path(), VAULT, A).unwrap();
    journal
        .capture(&BTreeMap::from([(
            "kv/tags.json".into(),
            stable::normalize(&json!({"$nevisBlob":"opaque"})),
        )]))
        .unwrap();
    let state = core::replay(VAULT, &journal.batches, &journal.preimages).unwrap();
    assert_eq!(
        stable::denormalize(&state.documents["kv/tags.json"]).unwrap(),
        json!({"$nevisBlob":"opaque"})
    );
    let hash = "a".repeat(64);
    let mut invalid = journal.batches.values().next().unwrap().clone();
    invalid.operations[0].next = Some(json!({"$nevisBlob":hash}));
    assert_eq!(invalid.seal().unwrap_err(), "DRIVE:invalid_blob_context");
}

#[test]
fn late_reference_restores_deleted_historical_asset_after_checkpoint_pruning() {
    let cloud = FakeDrive::default();
    let b = Device::new(B);
    b.put("base", "base");
    let media = b"GIF89a historical referenced bytes";
    let id = snapshot::hash(media);
    b.v.file_put(&id, media, "image/gif", "original.gif", 1)
        .unwrap();
    b.sync(&cloud).unwrap();
    let a = Device::new(A);
    a.cold(&cloud).unwrap();
    a.put("base", &format!("offline attachment att:{id}"));
    let relative = format!("files/{}/{id}", &id[..2]);
    fs::remove_file(b.v.root.join(&relative)).unwrap();
    fs::remove_file(b.v.root.join(format!("{relative}.json"))).unwrap();
    b.sync(&cloud).unwrap();
    checkpoint_cloud(&b, &cloud);
    cloud.0.lock().unwrap().files.clear();
    a.sync(&cloud).unwrap();
    b.sync(&cloud).unwrap();
    assert_eq!(a.docs(), b.docs());
    assert_eq!(b.v.file_get(&id).unwrap(), media);
    let metadata: Value =
        serde_json::from_slice(&fs::read(b.v.root.join(format!("{relative}.json"))).unwrap())
            .unwrap();
    assert_eq!(metadata["type"], "image/gif");
    assert_eq!(metadata["name"], "original.gif");
}

#[test]
fn missing_local_workspace_resume_keeps_original_google_account_and_folder() {
    let previous = Binding {
        schema_version: 1,
        subject: "original-account".into(),
        root_id: "root".into(),
        vault_id: VAULT.into(),
        folder_id: "original-folder".into(),
        objects_id: "objects".into(),
        streams_id: "streams".into(),
        checkpoints_id: "checkpoints".into(),
        backup: String::new(),
        paused: true,
    };
    validate_resume_binding(Some(&previous), "original-account", Some("original-folder")).unwrap();
    assert_eq!(
        validate_resume_binding(Some(&previous), "another-account", Some("original-folder"))
            .unwrap_err(),
        "DRIVE:account_mismatch"
    );
    assert_eq!(
        validate_resume_binding(Some(&previous), "original-account", Some("another-folder"))
            .unwrap_err(),
        "DRIVE:identity_mismatch"
    );
    validate_resume_binding(None, "fresh-account", Some("new-folder")).unwrap();
}
