//! Provider-independent publication protocol. Revision strings are opaque outside the adapter.
use super::snapshot::{self, Bundle};
use crate::vault::{err, write_atomic, Res};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
#[derive(Clone)]
pub struct Pinned {
    pub revision: String,
    pub snapshot: Bundle,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ErrorKind {
    Offline,
    Unauthorized,
    RateLimited,
    ConcurrentChange,
    Policy,
    Integrity,
    Recovery,
    Other,
}
pub fn error_kind(e: &str) -> ErrorKind {
    if e == "GITHUB:network" {
        ErrorKind::Offline
    } else if e.contains("sign_in_required") || e.contains("account_mismatch") {
        ErrorKind::Unauthorized
    } else if e.contains("rate_limited") {
        ErrorKind::RateLimited
    } else if e.contains("head_changed") || e.contains("local_changed") {
        ErrorKind::ConcurrentChange
    } else if e.contains("permission") || e.contains("privacy") {
        ErrorKind::Policy
    } else if e.contains("recovery") || e.contains("pending_corrupt") {
        ErrorKind::Recovery
    } else if e.contains("hash_mismatch") || e.contains("incomplete") || e.contains("corrupt") {
        ErrorKind::Integrity
    } else {
        ErrorKind::Other
    }
}
#[derive(Clone, Copy)]
pub struct Capabilities {
    pub conditional_publish: bool,
    pub max_file_bytes: usize,
}
pub trait SnapshotProvider {
    fn capabilities(&self) -> Capabilities;
    fn check(&mut self) -> Res<()>;
    fn head(&mut self) -> Res<String>;
    fn read(&mut self, known: Option<&Pinned>) -> Res<Pinned>;
    /// Prove a candidate is published, including when current head is a descendant.
    fn published(&mut self, candidate: &str, head: &str) -> Res<bool>;
    /// Build an immutable candidate with exactly the pinned revision as its parent.
    fn stage(&mut self, pinned: &Pinned, next: &Bundle) -> Res<String>;
    /// Only publish a fast-forward candidate; never overwrite a competing revision.
    fn publish(&mut self, candidate: &str) -> Res<()>;
}
#[derive(Serialize, Deserialize)]
struct Pending {
    parent: String,
    commit: String,
    before: Bundle,
    after: Bundle,
}
#[derive(Serialize, Deserialize)]
struct Checkpoint {
    revision: String,
    snapshot: Bundle,
}
fn checkpoint(path: &Path, revision: &str, snapshot: &Bundle) -> Res<()> {
    write_atomic(
        path,
        &serde_json::to_vec(&Checkpoint {
            revision: revision.into(),
            snapshot: snapshot.clone(),
        })
        .map_err(err)?,
    )
}
fn load(path: &Path, vault: &str) -> Res<Pinned> {
    match fs::read(path) {
        Ok(b) => {
            let v: Checkpoint = serde_json::from_slice(&b).map_err(|_| "SYNC:state_corrupt")?;
            v.snapshot.decode()?;
            if v.snapshot.manifest.vault != vault {
                return Err("VAULT_MISMATCH".into());
            }
            Ok(Pinned {
                revision: v.revision,
                snapshot: v.snapshot,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Pinned {
            revision: String::new(),
            snapshot: Bundle::new(vault, &Default::default(), Default::default()),
        }),
        Err(e) => Err(err(e)),
    }
}
pub fn synchronize(
    p: &mut impl SnapshotProvider,
    vault: &str,
    state: &Path,
    allow_create: bool,
    mut capture: impl FnMut() -> Res<Bundle>,
    mut apply: impl FnMut(&Bundle, &Bundle) -> Res<()>,
) -> Res<usize> {
    let caps = p.capabilities();
    if !caps.conditional_publish {
        return Err("SYNC:unsafe_provider".into());
    }
    p.check()?;
    let base_path = state.join("base.json");
    let pending_path = state.join("pending.json");
    if pending_path.exists() {
        let pending: Pending = serde_json::from_slice(&fs::read(&pending_path).map_err(err)?)
            .map_err(|_| "SYNC:pending_corrupt")?;
        pending.before.decode()?;
        pending.after.decode()?;
        if pending.before.manifest.vault != vault || pending.after.manifest.vault != vault {
            return Err("VAULT_MISMATCH".into());
        }
        let head = p.head()?;
        let published = p.published(&pending.commit, &head)?;
        let published = if !published && head == pending.parent {
            p.publish(&pending.commit)?;
            true
        } else {
            published
        };
        if published {
            let current = capture()?;
            // On restart, replayed local post-images may already exist. Merge preserves any later edits as well.
            if current.manifest != pending.after.manifest {
                let combined = if current.manifest == pending.before.manifest {
                    pending.after.clone()
                } else {
                    snapshot::reconcile(vault, &pending.before, &current, &pending.after)?
                };
                apply(&current, &combined)?;
            }
            checkpoint(&base_path, &pending.commit, &pending.after)?;
        }
        if published {
            fs::remove_file(&pending_path).map_err(err)?;
        } else {
            fs::rename(
                &pending_path,
                pending_path.with_extension(format!("unpublished-{}.json", crate::vault::now_ms())),
            )
            .map_err(err)?;
        }
    }
    for _ in 0..3 {
        p.check()?;
        let local = capture()?;
        let local_files = local.decode()?;
        if local_files.values().any(|b| b.len() > caps.max_file_bytes) {
            return Err("SYNC:too_large".into());
        }
        let known = load(&base_path, vault)?;
        let base = known.snapshot.clone();
        let pinned = p.read(Some(&known))?;
        if pinned.snapshot.manifest.vault != vault {
            return Err("VAULT_MISMATCH".into());
        }
        let remote = &pinned.snapshot;
        if !allow_create
            && remote.manifest.files.is_empty()
            && remote.manifest.tombstones.is_empty()
        {
            return Err("SYNC:remote_snapshot_missing".into());
        }
        if !base.manifest.files.is_empty()
            && remote.manifest.files.is_empty()
            && remote.manifest.tombstones.is_empty()
        {
            return Err("SYNC:remote_snapshot_missing".into());
        }
        let next = snapshot::reconcile(vault, &base, &local, remote)?;
        let count = next
            .manifest
            .files
            .keys()
            .filter(|p| p.starts_with("conflicts/"))
            .count();
        if next.manifest == remote.manifest {
            apply(&local, &next)?;
            checkpoint(&base_path, &pinned.revision, &next)?;
            return Ok(count);
        }
        let candidate = p.stage(&pinned, &next)?;
        let pending = Pending {
            parent: pinned.revision.clone(),
            commit: candidate.clone(),
            before: local.clone(),
            after: next.clone(),
        };
        write_atomic(&pending_path, &serde_json::to_vec(&pending).map_err(err)?)?;
        match p.publish(&candidate) {
            Ok(()) => {
                apply(&local, &next)?;
                checkpoint(&base_path, &candidate, &next)?;
                fs::remove_file(&pending_path).map_err(err)?;
                return Ok(count);
            }
            Err(e) if error_kind(&e) == ErrorKind::ConcurrentChange => {
                let head = p.head()?;
                if p.published(&candidate, &head)? {
                    return Err("SYNC:publication_recovery_pending".into());
                }
                if head == pinned.revision {
                    return Err(e);
                }
                fs::rename(
                    &pending_path,
                    pending_path.with_extension(format!("race-{}.json", crate::vault::now_ms())),
                )
                .map_err(err)?;
            }
            Err(e) => return Err(e),
        }
    }
    Err("SYNC:head_race_retry".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        collections::{BTreeMap, BTreeSet},
    };
    struct Mock {
        current: Pinned,
        staged: Option<Bundle>,
        lost_reply: bool,
        race: bool,
        commits: usize,
    }
    impl SnapshotProvider for Mock {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                conditional_publish: true,
                max_file_bytes: 95 * 1024 * 1024,
            }
        }
        fn check(&mut self) -> Res<()> {
            Ok(())
        }
        fn head(&mut self) -> Res<String> {
            Ok(self.current.revision.clone())
        }
        fn read(&mut self, _: Option<&Pinned>) -> Res<Pinned> {
            Ok(self.current.clone())
        }
        fn published(&mut self, c: &str, h: &str) -> Res<bool> {
            Ok(c == h)
        }
        fn stage(&mut self, p: &Pinned, b: &Bundle) -> Res<String> {
            assert_eq!(p.revision, self.current.revision);
            self.staged = Some(b.clone());
            self.commits += 1;
            Ok(format!("commit{}", self.commits))
        }
        fn publish(&mut self, c: &str) -> Res<()> {
            if self.race {
                self.race = false;
                self.current.revision = "competing".into();
                return Err("GITHUB:head_changed_or_branch_policy".into());
            }
            self.current = Pinned {
                revision: c.into(),
                snapshot: self.staged.clone().unwrap(),
            };
            if self.lost_reply {
                self.lost_reply = false;
                return Err("GITHUB:network".into());
            }
            Ok(())
        }
    }
    fn empty() -> Bundle {
        Bundle::new("v", &BTreeMap::new(), BTreeSet::new())
    }
    fn local() -> Bundle {
        Bundle::new("v",&BTreeMap::from([("pages/p.json".into(),snapshot::canonical(&serde_json::json!({"id":"p","title":"local","content":{"type":"doc","content":[]}})).unwrap())]),BTreeSet::new())
    }
    fn mock() -> Mock {
        Mock {
            current: Pinned {
                revision: "head".into(),
                snapshot: empty(),
            },
            staged: None,
            lost_reply: false,
            race: false,
            commits: 0,
        }
    }
    fn state() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("provider-test-{}", uuid::Uuid::new_v4()))
    }
    #[test]
    fn lost_publication_reply_recovers_without_duplicate_commit() {
        let mut p = mock();
        p.lost_reply = true;
        let state = state();
        let local = RefCell::new(local());
        let first = synchronize(
            &mut p,
            "v",
            &state,
            true,
            || Ok(local.borrow().clone()),
            |_, b| {
                *local.borrow_mut() = b.clone();
                Ok(())
            },
        );
        assert!(first.is_err());
        assert!(state.join("pending.json").exists());
        synchronize(
            &mut p,
            "v",
            &state,
            true,
            || Ok(local.borrow().clone()),
            |_, b| {
                *local.borrow_mut() = b.clone();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(p.commits, 1);
        assert!(!state.join("pending.json").exists());
        fs::remove_dir_all(state).unwrap();
    }
    #[test]
    fn competing_head_reconciles_and_never_force_overwrites() {
        let mut p = mock();
        p.race = true;
        let state = state();
        let local = RefCell::new(local());
        synchronize(
            &mut p,
            "v",
            &state,
            true,
            || Ok(local.borrow().clone()),
            |_, b| {
                *local.borrow_mut() = b.clone();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(p.commits, 2);
        fs::remove_dir_all(state).unwrap();
    }
    #[test]
    fn local_apply_failure_keeps_pending_and_unadvanced_base() {
        let mut p = mock();
        let state = state();
        let l = local();
        assert!(synchronize(
            &mut p,
            "v",
            &state,
            true,
            || Ok(l.clone()),
            |_, _| Err("SYNC:local_changed".into())
        )
        .is_err());
        assert!(state.join("pending.json").exists());
        assert!(!state.join("base.json").exists());
        fs::remove_dir_all(state).unwrap();
    }
    #[test]
    fn download_cannot_invent_an_absent_remote_vault() {
        let mut p = mock();
        let state = state();
        assert_eq!(
            synchronize(&mut p, "v", &state, false, || Ok(empty()), |_, _| Ok(())).unwrap_err(),
            "SYNC:remote_snapshot_missing"
        );
        assert_eq!(p.commits, 0);
    }
    #[test]
    fn corrupt_base_fails_closed() {
        let mut p = mock();
        let state = state();
        write_atomic(&state.join("base.json"), b"bad").unwrap();
        assert!(synchronize(&mut p, "v", &state, true, || Ok(local()), |_, _| Ok(())).is_err());
        assert_eq!(p.commits, 0);
        fs::remove_dir_all(state).unwrap();
    }
}

/// A new device downloads an existing snapshot read-only. A chosen local folder name is not an authored remote edit.
pub fn initialize_from_remote(
    provider: &mut impl SnapshotProvider,
    vault: &str,
    state: &Path,
    mut capture: impl FnMut() -> Res<Bundle>,
    mut apply: impl FnMut(&Bundle, &Bundle) -> Res<()>,
) -> Res<usize> {
    provider.check()?;
    let pinned = provider.read(None)?;
    if pinned.snapshot.manifest.vault != vault {
        return Err("VAULT_MISMATCH".into());
    }
    let remote = pinned.snapshot.decode()?;
    if remote.is_empty() && pinned.snapshot.manifest.tombstones.is_empty() {
        return Err("SYNC:remote_snapshot_missing".into());
    }
    let local = capture()?;
    if local
        .manifest
        .files
        .keys()
        .any(|p| p != "kv/workspace.json")
    {
        return Err("SYNC:initialization_requires_empty_workspace".into());
    }
    apply(&local, &pinned.snapshot)?;
    // An earlier forgotten copy may have runtime state here. Retain it for recovery; do not replay it into a new download.
    if state.exists() {
        fs::rename(
            state,
            state.with_extension(format!("prior-import-{}", uuid::Uuid::new_v4())),
        )
        .map_err(err)?;
    }
    checkpoint(&state.join("base.json"), &pinned.revision, &pinned.snapshot)?;
    Ok(remote
        .keys()
        .filter(|p| p.starts_with("conflicts/"))
        .count())
}

#[cfg(test)]
mod initialization_tests {
    use super::*;
    use std::cell::RefCell;
    struct ReadOnly {
        snapshot: Bundle,
    }
    impl SnapshotProvider for ReadOnly {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                conditional_publish: true,
                max_file_bytes: snapshot::MAX_FILE,
            }
        }
        fn check(&mut self) -> Res<()> {
            Ok(())
        }
        fn head(&mut self) -> Res<String> {
            Ok("H".into())
        }
        fn read(&mut self, _: Option<&Pinned>) -> Res<Pinned> {
            Ok(Pinned {
                revision: "H".into(),
                snapshot: self.snapshot.clone(),
            })
        }
        fn published(&mut self, _: &str, _: &str) -> Res<bool> {
            panic!("initialization must not publish")
        }
        fn stage(&mut self, _: &Pinned, _: &Bundle) -> Res<String> {
            panic!("initialization must not stage a commit")
        }
        fn publish(&mut self, _: &str) -> Res<()> {
            panic!("initialization must not publish")
        }
    }
    #[test]
    fn download_adopts_remote_name_and_baseline_without_publishing_or_creating_conflicts() {
        use std::collections::{BTreeMap, BTreeSet};
        let local = Bundle::new(
            "v",
            &BTreeMap::from([(
                "kv/workspace.json".into(),
                snapshot::canonical(&serde_json::json!({"name":"Chosen local folder"})).unwrap(),
            )]),
            BTreeSet::new(),
        );
        let remote = Bundle::new(
            "v",
            &BTreeMap::from([(
                "kv/workspace.json".into(),
                snapshot::canonical(&serde_json::json!({"name":"Existing remote workspace"}))
                    .unwrap(),
            )]),
            BTreeSet::new(),
        );
        let state = std::env::temp_dir().join(format!("initialize-test-{}", uuid::Uuid::new_v4()));
        let local = RefCell::new(local);
        let mut provider = ReadOnly {
            snapshot: remote.clone(),
        };
        initialize_from_remote(
            &mut provider,
            "v",
            &state,
            || Ok(local.borrow().clone()),
            |_, after| {
                *local.borrow_mut() = after.clone();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(local.borrow().manifest, remote.manifest);
        assert_eq!(load(&state.join("base.json"), "v").unwrap().revision, "H");
        fs::remove_dir_all(state).unwrap();
    }
}
