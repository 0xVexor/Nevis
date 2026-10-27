# Sync reliability changes

Branch: `fix/sync-reliability`, based on `dev` at `1812042`. Existing layout work is outside this branch. The audit dated 26–27 October described an older checkout; database path support and initial path/symlink validation were already present in this base.

## Contract

The implementation retains the vault marker, accounts, content hashes and file format. Apply the server update before the client update. The server advertises `full_snapshot` and exposes `GET /v1/vaults/:id/snapshot`. Each page returns an epoch, head, root, live files and an `after` cursor. Subsequent pages must send the same epoch and head; a changed generation or head returns `409 snapshot_changed`. The client retries a bounded number of times, verifies the complete root, and publishes the new mirror only on success. An old incremental cursor still returns `410`; that response now leads to a full snapshot instead of repeating the same invalid cursor. Starting without a baseline permits union/conflict resolution, never inferred deletion. A zero sequence immediately after this device's first uploads is not itself evidence that acknowledged baselines were lost; the next snapshot preserves them. End-to-end validation covers this distinction so a local deletion is not resurrected by an unnecessary reset.

Object deletion has a persistent claim (`deleting`) before the first asynchronous storage call. Commits cannot reference claimed blobs; uploads and restore cannot succeed against a claimed vault/account. Interrupted cleanup resumes later. Object-store failure keeps the claim rather than allowing new references to an object whose deletion may still complete. Concurrent collections share a queue. The same content hash has one staging writer at a time. Upload capacity is reserved in SQLite, including across chunks and process restarts; inactive reservations expire after one day. Empty files have an explicit valid path through range validation.

Case-folded uniqueness applies to live paths; tombstones retain their original spelling and revision. Ambiguous live names remain errors. The independent server deletion guard counts a device's deletion burst for a vault over 60 seconds, including separate single-file commits. Crossing `max(5, 20% of initial live files)` requires explicit confirmation. Successful confirmations reset the window's count. Other devices still have their own counters; this is an accidental-delete guard, not authorization against an account owner.

## Local storage and conflict handling

Commands and sync mutations share a reentrant vault lock. Downloads happen outside that lock; the downloaded hash, marker identity, safe local path and scanned local content are checked under it before replacement. Conflict branches use the same checks. Restoring a file is serialized against its conditional remote delete. That delete holds the local mutation lock until its single network request finishes or times out; the background sync uses one HTTP attempt rather than nested retries. A global network/authentication failure ends transfer processing and holds deletions.

Atomic writes use unique temporary files, file synchronization and, on Unix, parent-directory synchronization. Opening an existing vault no longer recreates absent subtrees. Enumeration errors stop the scan; a missing tracked subtree is unknown, not evidence of deletion. Existing symlinks beneath a sync path are rejected. This does not claim protection against an adversarial external process changing path components during a system call; handle-relative filesystem operations would be needed for that stronger guarantee.

Every conflict loser is kept before replacement. Archive failures propagate and retain the source conflict file. Corrupt existing JSON is copied as raw bytes to sync trash before conflict replacement; ordinary page saves refuse to replace unreadable JSON. Conflict snapshots include the complete page, including folders and metadata, and are pinned against normal 40-version trimming. Ordinary history remains limited to 40 entries. Complete snapshots can be restored through version history; legacy snapshots retain their content-only format. Invalid or cyclic restored parents fall back to the workspace root.

Pages retain the existing `updatedAt` ordering, with a stable content tie-break for equal timestamps. This is a deterministic policy, not a claim that a device's wall clock identifies the user's preferred edit. Both versions are retained and the interface reports a conflict. Arbitrary files without trustworthy edit metadata use a stable content-hash choice with the other bytes in sync trash. A save supplies its complete baseline page as well as the legacy timestamp so equal-timestamp external changes do not bypass preservation. Desktop save results return what was actually persisted; an archived stale write is not recorded as the active disk version.

The editor fingerprints page/database bytes, compares complete page data during refresh, and samples before and after reading. It never marks an unrelated remote change as observed merely by sampling after its own save. This increases local reads on very large workspaces; performance must be measured rather than assumed. Desktop attachment collection is conservatively suspended because current page references alone cannot prove that pinned or deleted-page history no longer uses a file. Browser collection includes retained history references. Explicit deletion and server storage retention remain separate policies.

## Scheduling, backups and remaining limits

Retry deadlines wake the worker without another edit. All registered sync-enabled vaults are visited, including closed workspaces; the files on disk are the durable work queue. The active workspace is prioritized and background vaults do not replace its displayed status. A changed remote epoch wakes sync even if the sequence fell after a restore.

Index backups now publish reference manifests. Snapshot publication and collection are serialized. Orphan collection retains objects referenced by retained index backups; missing legacy manifests cause conservative retention. This protects ordinary revision expiry from invalidating index backups. Explicit permanent vault/account deletion still deletes their content. These manifests are not an independent object-store backup: storage versioning, corruption recovery and restore drills on the deployed storage remain operational requirements.

The client still commits files individually and downloads full objects into memory. Batch uploads, streaming, real latency benchmarks and mobile lifecycle tests are not completed here. Their audit entries are performance/operational follow-ups rather than falsely marked resolved. Cross-device testing on real networks and production object storage is still required before claiming release readiness.

## Audit disposition

| Findings | Disposition |
|---|---|
| 01 | Already fixed in the base branch; shared path fixtures retained. |
| 02 | Verified paged full snapshot and epoch checks. |
| 03–08 | Archive error propagation, local serialization, guarded mutations, quarantine and complete snapshots. |
| 09 | Stable tie-break and preserved selectable versions; wall-clock preference remains a documented policy. |
| 10–11 | Actual persisted results, full baseline comparison, content fingerprints and consistent refresh. |
| 12–14 | Deadline-driven retry, one-attempt sync, early global-error stop, all-vault scheduling. |
| 15–17 | Existing path protection plus missing-subtree handling, local path checks and all-branch hash verification. |
| 18–19 | Conservative attachment retention and pinned conflict history; normal retention remains explicit. |
| 20 | Nested retries reduced; per-file commits, streaming and large-workspace measurement remain open. |
| 21 | Backup reference manifests protect ordinary GC; independent storage recovery remains operational. |
| 22–27 | Empty objects, durable quota reservation, deletion claims, live-path case uniqueness and cross-request deletion guard. |

## Validation record

Tests were written during implementation and deliberately not run until the final validation stage. The final results and any unavailable checks are recorded below after that stage. Added coverage includes snapshot generation/head changes, compaction with old live files, zero-byte objects, concurrent quota/staging, cleanup failures and retries, restore/account races, retained-backup references, per-request deletion splitting, archive failures, full metadata history, equal-time ties, concurrent local saves, missing subtrees, edits during conflict download, stale deletion plans and repository refresh/persistence behavior.

Final validation on 27 October 2026 (macOS, isolated local server and disposable vaults):

| Check | Result |
|---|---|
| Server `npm test` | 77 passed, no failures. |
| Rust `cargo test --locked --bin nevis` | 77 passed; the 11 integration tests are run separately. |
| Rust `e2e -- --ignored --test-threads=1` | 11 passed against a local HTTP server; includes a 501-record paged snapshot and a 5 MiB attachment. |
| Database suite | 173 passed after installing its test-only IndexedDB dependency. |
| Repository refresh/persistence, text direction and update controller | 16 passed. |
| Web `npm run build` | TypeScript and production build passed. |
| Diagnostic script | 8 probes; 0 original hazards observed with the updated snapshot path. |
| Diff whitespace check | Passed. |

End-to-end validation initially detected an unnecessary baseline reset after the first uploads. It was corrected, documented and all affected integration tests passed on repetition. Review also covered a later GC candidate restored while an earlier purge awaited storage, equal-time complete baselines, short legacy page IDs, metadata fields absent from a restored version, and an editor refresh overtaken by a queued write.

These results cover local HTTP and temporary storage, not physical power loss, Windows file locks, mobile background execution, real intermittent connectivity or deployed S3. The application and production service have not been deployed by this change. Performance/operational follow-ups in findings 20–21 remain open.
