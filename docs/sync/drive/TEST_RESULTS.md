# Validation results — 2026-10-29

**Production-ready: NO.** TEST_MATRIX.md computes all 104 acceptance rows from observed test names: **46 PASS / 0 FAIL / 58 NOT_RUN**. A synthetic PASS is not real Google/OS certification. Unmapped/partial cases stay NOT_RUN.

| Check | Result | Evidence |
|---|---|---|
| Full corrected native suite | PASS | 198 passed, 0 failed, 11 ignored; 132.65s |
| Final durable exponential quota-backoff regression | PASS | 5 schedule tests, including 1 new test, after the full suite |
| Final root-display hardening regression | PASS | 3 root tests |
| Unique native results across final logs | PASS | 199 passed, 0 failed, 11 ignored; 94 Drive tests, no ignored Drive tests |
| `npm run test:layout` | PASS | 43 passed, including editor identity and settings policy |
| `npm run test:db` | PASS | 173 passed |
| `npm run test:direction` | PASS | 4 passed |
| `npm run test:updates` | PASS | 7 passed |
| Unique JS total | PASS | 227 passed, 0 failed |
| `npm run build` / native beforeBuild | PASS | TypeScript and Vite, warnings retained |
| `npm run lint` | PASS with warnings | 236 warnings, zero errors |
| New Rust modules rustfmt / git diff whitespace | PASS | Check output retained in validation |
| macOS ARM64 debug app | PASS | com.vexor.nevis.drive-preview, approximately 86.65MiB, independent data/credential identity |
| Initial native setup smoke | PASS, limited | Missing client, disabled sign-in, Persian/RTL, Escape, GitHub access; earlier screenshot retained |
| Corrected OAuth Preview setup smoke | PASS, limited | Full-path CUA launch, welcome → Drive dialog, Import Desktop OAuth JSON and sign-in visible; no real Vault touched |
| Native GUI local-save / connected conflict/history flows | NOT_RUN | Earlier OS picker automation timed out; real configured client; successful connected authorization still unverified |
| Actual Google OAuth | FAILED in prior build; corrected build NOT_RUN | Live diagnostic returned client_secret is missing; corrected native import/keychain exchange awaits user retest |
| Actual Keychain credential lifecycle / cross-device drive.file | NOT_RUN | User authorization and real two-device verification required |
| Windows packaging/startup; signed/notarized release | NOT_RUN | macOS host/debug package only |

The 11 ignored tests are one explicit GitHub public diagnostic and ten legacy Hub E2E tests needing their external server. They are not passes.

## New regression evidence

- 100 immutable publication response-loss/restart cycles; exact reserved ID/sequence/hash retained.
- Null versus absence, externalized large JSON and one logical atomic capture split into multiple markers.
- Page-wide moved block + offline edit, concurrent moves, independent inserts, parent deletion + appended child, reserved/opaque fields.
- Actual no-op causal resolution followed by the *same values* conflicting again produces a new conflict identity.
- Same database ID created independently archives whole candidates; DB soft delete/edit resurrects; independent fields merge; allocator token collisions reject before apply; sequential migration is idempotent and preserves existing allocations.
- Global theme / local font values remain separate across transfer and checkpoint, including recursive cloud-payload inspection and policy changes.
- Checkpoint after covered stream removal, offline preimage rebase/new sequence, open conflicts after pruning, covered-sequence fork rejection, dominance without timestamp selection, unchanged stale-device rebootstrap.
- Durable GC proof/verification, stale proof rejection, history-only media retention and guarded no-delete recovery.
- Real subprocess Vault lock acquisition/release, immutable marker identity and legacy format fence.
- Two-page changes failure before cursor commit, expired-token rescan and removed uncovered history without page deletion.
- Pause signal prevents a new HTTP request; publication throttle retains outbox while incoming independent changes still apply.
- PKCE RFC vector, bounded expiry and callback state/path/duplicate parameter validation. These are not a real token/Keychain exchange.
- HTTP 403/404/409/429/503 classification/redaction, corrupt media; resumable 308 probe + uncertain response + restart sends only unacknowledged bytes, rejects overflow/malformed/out-of-bounds ranges.
- Interrupted owned staging resumes; an unrelated existing target is never replaced.
- Media apply redo after partial JSON installation, unexpected third-version refusal, hash-cache invalidation after atomic replacement.
- Incremental delivery of 100 concurrent/causal batches in 20 generated orders converges. The older 10,000-permutation test still uses only a small three-batch fixture; it is not 10,000 independent structural histories.

## Measurements

Debug macOS ARM64; FakeDrive/disk storage, not Google:

| Fixture | Observation |
|---|---|
| 10,000 successive edits | capture 5487ms; through replay 6611ms; journal 18,699,610 bytes |
| 1000 pages / 10,000 blocks / 1000 small assets | publish including fixture setup 77,306ms; through cold restore 114,720ms |
| Synthetic remote inventory | 16 immutable batches, 4,335,481 aggregate bytes |
| 128MiB media, isolated test binary under `/usr/bin/time -l` | PASS in 25.66s; maximum RSS 16,039,936 bytes (15.3MiB); no media body in Bundle.bytes; destination SHA/length match |

The large-media fixture includes capture, disk-backed publication, cold restore and restart capture. It is not a live HTTP bandwidth or GUI latency measurement. Its initial uncached implementation took 158.47s; repeated hashing was reduced using a bounded metadata/identity cache. Cache assumptions and deep verification are documented in PROTOCOL.md. Initial hashing/copying can still hold the native writer mutex; release editor-latency measurement remains a gate.

An older Cargo/compiler-inclusive job reported 649,691,136 bytes RSS. That was not an engine measurement; it is superseded for the specific 128MiB pipeline by the isolated binary measurement, not generalized away.

## Corrected failures

Presence/null encoding, structural ancestor repair, checkpoint notification on the changes feed, legacy sync marker preflight, vanished-root capture preflight, canonical JSON comparison during redo and resumable onboarding all received regression coverage. A GC proof fixture initially lacked checkpoint-object cache files and was corrected to model completed publication. Initial DB tests lacked declared fake-indexeddb; installation fixed the environment. Source/build errors during implementation were corrected before the successful final runs.

## Remaining limits

See EXECUTION_REPORT.md for exact internal and external gaps. No destructive GC/retention is enabled; Picker permission repair is absent; explicit verified-root selection is implemented; not every DB business invariant or fault boundary is tested. JSON/journals remain memory bounded and expensive rather than fully incremental. Live OAuth, actual drive.file discovery, Windows, final connected GUI and release packaging remain unverified. The provider stays off by default.

## Continuation regressions

Verified root selection/account isolation, original-root loss without replacement, safe history title/count preview and fresh-name local restore, graph cardinality/duplicate/cycle/filter validation, explicit reviewed concurrent link decisions, one bounded 401 refresh and revoked refresh redaction, bounded Desktop JSON identity validation, HTTP-date/overflow/durable Retry-After, repeated exponential quota backoff, journal commit-point failure with no publication, reserved JSON/blob context separation, three-candidate late-actor checkpoint replay, deterministic/bounded gzip archive, and late referenced GIF recovery after covered-stream pruning all passed.

The journal fault uses a directory at the rename destination, not an actual full/read-only filesystem. The archive decompression-limit test uses a small injected bound; production uses 95MiB. Historical performance/RSS figures above were measured on the earlier implementation and are not relabeled as measurements of replay-archive overhead. Final large fixtures passed but were not separately profiled for release latency/RSS.
