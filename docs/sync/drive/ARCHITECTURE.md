# Drive Sync implementation

Source combines GitHub sync e061895 and origin/dev 45069f2 in integration merge e140ce7, on `feature/drive-sync`. A later fetch confirmed dev unchanged. User edits in the original checkout were preserved. The provider is off by default and `releaseReady` remains false.

| Component | Responsibility |
|---|---|
| auth.rs | PKCE/system browser/loopback, bounded callback validation, cancellable generation, OS-only credentials, serialized refresh |
| transport.rs | Drive IDs/list/changes/metadata, bounded JSON, redacted errors, immutable publication, verified streaming/resumable media, pause signal |
| core.rs | immutable batches, atomic groups, null-safe patches/full-object references, causal replay, provenance, conflicts, journals/coverage |
| stable.rs | backup-following block-ID migration, page-wide identities/parents/orders, structural repair and validation |
| database.rs | cross-file references, source/cell/relation checks, allocator collision checks and resumable sequential-to-partitioned migration |
| settings.rs | versioned global/device-local policy; stripping device values before batches/preimages/checkpoints |
| streaming.rs | file-backed capture/apply, verified copy, source-path-free redo receipts and local hash cache/deep check |
| checkpoint.rs | manifest-last restore points, dependency retention, independent reconstruction, dominating seed selection |
| onboarding.rs | owned staging folder, resumable download receipt, no replacement of an unrelated destination |
| gc.rs | persisted dry-run/verify/deferred execute/recovery; destructive mode unavailable |
| diagnostics.rs | per-account daily raw HTTP totals, operation counts, bytes, bounded header-latency p50/p95, informational budget warning |
| vault_lock.rs / Vault | live-process OS lock, shared local handles, immutable identity, marker/lock replacement detection, legacy format fence |
| main.rs | native commands, provider single-writer routing, capture/apply coordination, rate deadlines and scheduling |
| DriveSync / ConflictReview | setup/policy/pause/history/copy restore/conflicts/diagnostics; A/B and supported Keep both |
| driveLifecycle / stableBlockIds | save-before-wake/close, focus/online/background triggers; block IDs/paste repair |

Local save remains independent of Google. Drive uses its own SyncStorageAdapter, without reusing GitHub's overwritten-head protocol. The existing provider operation mutex serializes mutations. Native networking runs outside the Vault writer mutex. Only the active Vault is scheduled. A Drive binding, including a paused/corrupt binding, never silently falls back to another provider.

Local capture is durable before discovery. Start token precedes inventory; discovered files/inbox are saved before cursor advancement. Required objects precede marker publication; reserved IDs survive uncertain results. Replay validates the complete group and graph before apply. An edit made during HTTP fails the apply precondition and is captured on retry. Unexpected third versions after a partial application require recovery rather than overwrite.

Remote-only scheduling uses 45 s quiet time, 5 min maximum edit wait, 90 s minimum automatic publication interval, and polling around 60 s with jitter. The publication throttle still permits incoming changes to apply. Sync Now/background wake can bypass the automatic interval but cannot bypass persisted Retry-After. Backoff uses jitter; storage-full automatic retries are slowed. Pause is signaled before waiting for the provider mutex and stops subsequent requests/chunks; a current HTTP call remains bounded by its timeout.

Backups precede migration. Google preparation succeeds before the format fence; a provider-switch receipt is persisted before fencing. Fenced-but-unbound Vaults cannot use GitHub/legacy writers. Portable history restore creates a fresh local UUID with sync off. Download staging is owned by a receipt/token and can resume after interruption or after the final rename.

All target acceptance criteria have not been demonstrated. Real OAuth/credential lifecycle, cross-device drive.file discovery, Windows, connected GUI paths, signed release, exhaustive filesystem/crash tests, root-selection repair UX and destructive retention/GC remain gates. JSON/journal memory and replay costs are still bounded/conservative rather than an incremental database engine. See EXECUTION_REPORT.md, TEST_RESULTS.md and the computed 104-case matrix.
