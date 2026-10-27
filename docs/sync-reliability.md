# Sync reliability changes

Branch: `fix/sync-reliability`, based on `dev` at `1812042`. Existing layout work is outside this branch. The audit dated 26–27 October described an older checkout; database path support and initial path/symlink validation were already present in this base.

## Contract

The implementation retains the vault identity, page JSON and content hashes. The follow-up uses protocol 2 and profile-scoped credentials; shared legacy sessions require signing in again and unbound workspaces require an explicit link. Apply the server update before the client update and coordinate release availability: protocol-1 writers are rejected by the updated server. No deployment has been performed. The server advertises `full_snapshot` and exposes `GET /v1/vaults/:id/snapshot`. Each page returns an epoch, head, root, live files and an `after` cursor. Subsequent pages must send the same epoch and head; a changed generation or head returns `409 snapshot_changed`. The client retries a bounded number of times, verifies the complete root, and publishes the new mirror only on success. An old incremental cursor still returns `410`; that response now leads to a full snapshot instead of repeating the same invalid cursor. Starting without a baseline permits union/conflict resolution, never inferred deletion. A zero sequence immediately after this device's first uploads is not itself evidence that acknowledged baselines were lost; the next snapshot preserves them. End-to-end validation covers this distinction so a local deletion is not resurrected by an unnecessary reset.

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

The follow-up batches ordinary uploads into at most 200 operations and 8 MiB per commit payload group. Ordinary attachment downloads stream into verified temporary files and large attachment uploads read from a stable file handle in bounded pieces. JSON/conflict processing still materializes its inputs; real latency benchmarks and mobile lifecycle tests are not completed here. Their audit entries are performance/operational follow-ups rather than falsely marked resolved. Cross-device testing on real networks and production object storage is still required before claiming release readiness.

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
| 20 | Nested retries reduced, small-file commits batched, ordinary attachment transfers streamed; conflict/JSON materialization and large-workspace measurement remain explicit. |
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

The [supplemental session and concurrent-edit review](sync-session-review-2026-10-27.md) identifies additional boundaries outside that validation scope, including an unflushed editor buffer, independent device sessions, account transitions and mixed-version writers. Prior test totals must not be interpreted as complete coverage of those scenarios.


## Session and editor follow-up

The editor captures each document transaction in the repository immediately. Debounced text outside the repository is no longer eligible to be replaced by a refresh. A successful save indicator follows storage acknowledgement, and failed writes remain retryable. Leaving a page never reads a destroyed editor or writes an unchanged editor snapshot. Unknown JSON nodes, marks, attributes, fields and invalid structure open without write access, preserving the raw page. Opening legacy HTML alone no longer rewrites it. History restore validates content and restores complete metadata without triggering a second editor write. Drawing buffers hold repository refresh while their asynchronous attachment/page save is pending; detached editor saves remain drainable and retryable before switching workspaces or installing.

Account transitions and complete sync rounds share a serialization boundary, independent of local typing. A command reserves a generation before entering the blocking queue. A superseded login cannot publish a session, and a late logout cannot clear a newer session. Authenticated HTTP requests check their generation before dispatch and before accepting the response; quick requests have a 30-second bound. Credential references are unique to a session and scoped to the canonical profile directory. The token is staged before atomically publishing the account file; failed publication removes only the new credential, and successful replacement removes only this profile's previous credential. Copied/legacy shared sessions require a fresh sign-in without deleting vaults. Credential-store outage retains the existing local-file fallback behavior.

A registry entry now stores its owner as stable user ID plus normalized server. A different account, server or reused username cannot automatically attach the local vault. Unknown legacy ownership pauses with `ACCOUNT_MISMATCH`; the account panel offers an explicit link action and explains that the signed-in account will receive the local files. Reauthentication to the same account retains the association and baseline. Queued account/cloud commands reject an intervening account transition instead of retargeting it.

Server authentication revalidates password/recovery snapshots and device validity after expensive asynchronous verification, inside the synchronous mutation boundary. Recovery keys cannot be consumed by two concurrent recoveries. Concurrent password changes cannot both succeed using the old credential. Protocol 2 is required for authenticated operations; discovery stays available to health checks without a header. The client checks the server's `session_safe_writes` capability before creating or modifying a cloud vault. A legacy client gets `426 upgrade_required`; the new client refuses an old server with a clear update message.

Database merges use a complete content tie-break, canonical merge identity and complete cell stamp rank. Reversing the two inputs produces the same JSON, including metadata. A cyclic or missing parent is displayed at a deterministic root without silently rewriting its original parent. Recursive deletion/restoration/purge and move validation have visited sets. Conflict history uses content-addressed, nonnumeric names that older numeric retention does not trim; existing local numeric pinned conflicts are migrated by copying before removal. Repeated conflict delivery is idempotent.

Kernel file locks protect each profile and each vault across cooperating processes and release after process death. They supplement the existing in-process reentrant lock. An already-released older binary that does not acquire these locks cannot be retroactively made cooperative; it must be closed before opening the same local folder in the new version. Protocol enforcement protects the updated server from such an old writer, not a folder directly written by an uncooperative process.

Installation drains registered and detached editors, pauses new database commands, drains accepted database work (including undo persistence), pauses new repository mutations, drains the complete evolving write queue, and only then freezes storage. Failed drains reopen the gates. Frozen writes fail explicitly instead of returning success. The backend waits for account/sync and local vault work before pausing operations for installation. A failed install reopens writes. Editors become read-only while saving/installing. Workspace switching uses the same editor/database/repository drain. Local scanning verifies content even if a copy/restore preserved size and mtime, using a 64 KiB hashing buffer; this trades additional disk reads for detection correctness. Ordinary small-file uploads now use conditional batches bounded by 200 operations and 8 MiB; every member has its own result, so a conflict cannot overwrite another version or roll back unrelated successful members. Large attachments upload through a stable open file handle with 64 KiB hash reads and 1 MiB pieces, and ordinary attachment downloads stream into a unique temporary file with SHA-256/MD5 verification before publication. A copy restored with unchanged mtime/size is still detected. A full staged blob whose final storage publication failed replays its last piece instead of incorrectly committing a missing blob. Temporary downloads are removed on ordinary failures and never replace a local edit made during the transfer. Vault identity is captured when opened and revalidated after network waits; changing the marker cannot retarget an existing handle. JSON/conflict paths still need whole inputs, and large-workspace operational measurements remain separate work.

The explicit scenario matrix and the original user report remain in [the supplemental review](sync-session-review-2026-10-27.md). Five controlled reproductions from that review are historical evidence before this follow-up, not claims that they remain unfixed. New regression coverage is recorded only after the final validation stage.


## Follow-up final validation — 27 October 2026

Tests were not run until implementation and review reached the final validation stage. The current totals replace the earlier totals for this follow-up:

| Check | Result |
|---|---|
| Server suite | 84 passed, including independent sessions, recovery/password races, stale credential verification, revocation during request preparation and protocol fencing. |
| Rust unit suite | 90 passed; 18 HTTP integration tests and one scale benchmark run separately. Includes a real child-process vault lock check, session generation/profile ownership checks, equal-rank merge symmetry, legacy history retention and refusing an old server before creating a vault. |
| Rust HTTP integration | 18 passed against disposable memory storage on localhost, using independent device logins. Includes untouched offline copies, independent files edited offline, same-file conflicts, remote deletion versus offline edits, revoked device reauthentication, three equal-time writers, a 501-record snapshot, a 405-file batched initial upload, a mixed successful/conflicting batch and a streamed 5 MiB attachment. |
| Database suite | 176 passed, including pausing new commands while accepted commands drain, storage failure blocking installation, and undo persistence retry. |
| Repository/editor/update/direction suites | 29 passed, including capturing the production editor callback before refresh, retryable failed saves, visible cyclic trees, detached editor draining and stopping new writes before installation. |
| Production web build | Passed; existing bundle-size and ineffective-dynamic-import warnings remain. |
| Original diagnostic script | 8 probes; 0 original hazards observed. |
| Diff whitespace | Passed. |

Total passing tests in the functional suites: **397** (84 + 90 + 18 + 176 + 29). The diagnostic probes and the separately run scale benchmark are not included in that total. An initial TypeScript check caught a page-object/id mismatch in subtree restore, and the live-handler test initially needed a newline after an extracted source comment; both were corrected and the affected suites/build passed on repetition.

Manual local browser verification used a separate localhost origin with fresh IndexedDB, not the user's vault: write Persian text, create/visit two other pages, return, reload the app, and reopen the original page. The original text remained present and the UI showed saved. This verifies that navigation scenario in the browser persistence adapter; it does not establish the historical incident's cause or replace desktop/multi-device integration.

The normal CI sync script now includes the new repository, content-safety, editor-drain and transition tests, and CI installs the isolated IndexedDB test dependency and runs the full database suite. The HTTP suite remains in its own CI job. Local tests were on macOS; actual Windows CI execution, native installer execution/signing, physical interruption, mobile suspension, deployed S3/independent backup restore and deployed network/S3 latency measurements were not performed here; the isolated scale measurements below cover local files and an in-memory remote. Interactive OS credential-store/login flows were not exercised against the installed application. Old uncooperative binaries must be closed before sharing the same local folder. The installed application and production service remain unchanged until a coordinated release.


### Scale measurements and final scan safeguards

The ignored `benchmark_workspace_batches` test passed for all three data sets below. It uses tiny JSON records on the real local filesystem and an in-memory remote, without simulated HTTP RTT. Times measure `sync_once`; fixture creation and removal are outside those timings. The full timed command took 395 seconds, including creating and removing 61,000 durable files. Its maximum resident set size was 130,891,776 bytes (about 125 MiB), measured for the timed command/test invocation, not as a mobile or deployed-app memory guarantee.

| Files, excluding marker | First sync | Quiet sync | Conditional upload batches |
|---|---:|---:|---:|
| 1,000 | 103 ms | 25 ms | 6 |
| 10,000 | 733 ms | 295 ms | 51 |
| 50,000 | 7,548 ms | 1,718 ms | 251 |

These samples were recorded before the final read-lock tuning; they are not production network latency predictions or a before/after speed ratio. The payloads are deliberately small; a separate regression test exercises the 8 MiB batch-byte boundary with ten 1.5 MiB attachments. The 5 MiB HTTP attachment test exercises streamed large-file upload and download against the real local API.

Final tuning moves read-only fingerprint work off the UI command thread and avoids holding the writer mutex for an entire sync scan. Each mutation still verifies identity, content and conditional remote revision under its applicable boundary. A regression test runs a writer concurrently with scanning and verifies that its last edit survives and reaches the remote. The open vault captures its identity rather than re-reading a potentially replaced marker as its own identity. Download publication and conflict archiving reject a missing or replaced marker. A local mutation that overtakes a round, or a skipped race, keeps sync pending; it does not announce an up-to-date result and is retried on a short deadline.

The final validation also caught two fixture/setup issues: the in-memory device fixture used to rewrite an already-open vault's ID and now correctly creates that ID up front; one HTTP integration run had no listening fixture server and was rerun successfully after restarting the disposable server. Neither was resolved by weakening the identity or revision guards. All final functional suites pass. No merge, push, release or deployment was performed.
