# Validation results — 2026-10-29

Latest UI/responsiveness follow-up: **208 native PASS / 0 FAIL / 11 ignored**, including **102 Drive tests** and both heavy media/cold-restore fixtures, 110.19s. JavaScript **234 PASS** (50 controller/layout, 173 database, 4 direction, 7 updater). TypeScript/Vite and configured macOS ARM64 debug bundle PASS. Lint 237 warnings / 0 errors; no new unique warning categories compared with the retained baseline. See [the follow-up report](UI_PERFORMANCE_FA.md). Real-account latency with the new binary remains NOT_RUN; do not infer a speed multiplier from unit tests.


**Production-ready: NO.** TEST_MATRIX.md computes all 104 acceptance rows from observed test names: **46 PASS / 0 FAIL / 58 NOT_RUN**. A synthetic PASS is not real Google/OS certification. Unmapped/partial cases stay NOT_RUN.

| Check | Result | Evidence |
|---|---|---|
| Full corrected native suite | PASS | 198 passed, 0 failed, 11 ignored; 132.65s |
| Final durable exponential quota-backoff regression | PASS | 5 schedule tests, including 1 new test, after the full suite |
| Final root-display hardening regression | PASS | 3 root tests |
| Unique native results across final logs | PASS | 206 passed, 0 failed, 11 ignored; 100 Drive tests, no ignored Drive tests |
| `npm run test:layout` | PASS | 47 passed, including editor identity and settings policy |
| `npm run test:db` | PASS | 173 passed |
| `npm run test:direction` | PASS | 4 passed |
| `npm run test:updates` | PASS | 7 passed |
| Unique JS total | PASS | 231 passed, 0 failed |
| `npm run build` / native beforeBuild | PASS | TypeScript and Vite, warnings retained |
| `npm run lint` | PASS with warnings | 236 warnings, zero errors |
| New Rust modules rustfmt / git diff whitespace | PASS | Check output retained in validation |
| macOS ARM64 debug app | PASS | com.vexor.nevis.drive-preview, approximately 86.65MiB, independent data/credential identity |
| Initial native setup smoke | PASS, limited | Missing client, disabled sign-in, Persian/RTL, Escape, GitHub access; earlier screenshot retained |
| Corrected OAuth Preview setup smoke | PASS, limited | Full-path CUA launch, welcome → Drive dialog, Import Desktop OAuth JSON and sign-in visible; no real Vault touched |
| Native GUI local-save / connected conflict/history flows | NOT_RUN | Earlier OS picker automation timed out; real configured client; real sign-in user-reported PASS; connected conflict/history workflows still unverified |
| Actual Google OAuth | User-reported PASS on developer-configured Preview | Publisher-configured fresh-install sign-in/refresh remain unverified |
| Stored-account reload | PASS, limited | Previously signed-in identity reloaded in the publisher-configured GUI |
| Actual refresh/revocation / cross-device drive.file | NOT_RUN | Real lifecycle and two-device verification required |
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

## Saved Desktop secret entry correction

After the user's Console screenshot showed existing-secret downloads are unavailable, added direct password entry into the existing client-scoped OS keyring. All 5 OAuth tests passed, including the new manual-input bounds/redaction assertion. Combined unique results: **200 native passes, 0 failures, 11 ignored; 95 Drive passes**. No complete-suite rerun is claimed after this localized auth/UI correction. TypeScript/Vite and lint passed again; the user subsequently confirmed successful real sign-in. No real client secret was entered by automation.

## Publisher-configured customer UX

User reported successful real sign-in using the prior developer-configured Preview. Customer builds now bundle the publisher's Desktop public-client parameter; per-user JSON/secret setup is hidden and its IPC commands are gated by explicit developer mode. Enabled customer builds require complete publisher configuration. Seven auth tests and two build-config tests passed, adding three unique tests: **203 unique native passes, 0 failures, 11 ignored; 97 Drive passes** across the observed logs. TypeScript/Vite, lint and macOS packaging passed again. Packaged ID/parameter presence and build-output redaction were verified without printing the value. Fresh-install Google sign-in, real refresh and cross-device transfer remain pending; no full suite rerun after this localized packaging/auth change is claimed.

The publisher-build GUI smoke encountered an OS Keychain read that did not complete. A process sample showed repeated status jobs blocked inside SecKeychainFindGenericPassword. Status was changed to one asynchronous read with a generation-protected identity cache; a regression covers single-flight and stale read completion after logout. Native auth tests: 7/7. Final GUI completion/retained-session validation is still pending; neither OS permissions nor release signing was bypassed. The build/configuration fix does not claim those gates passed.

Later in the publisher-build GUI smoke, the Keychain read completed: the previously signed-in identity and Reconnect Google were visible, with no Secret or JSON setup controls. No Vault was open. This verifies a basic stored-account reload and the normal customer UI in that build; it does not verify automatic token refresh or two-device transfer. The following single-flight status change has unit regression coverage; no full connected GUI certification is claimed.

## Workspace startup integration

Native regression suite excluding the two unchanged heavy fixtures: 202 passed, 0 failed, 11 ignored, 2 filtered, 30.40s. Final onboarding subset: 3 passed. Resume binding account/folder guard: 1 passed. Combined unique observed native results, retaining the prior heavy-fixture evidence: **206 passed, 0 failed, 11 ignored; 100 Drive passes**. Layout/editor/controller suite: **46 passed**, with three new routing/cancellation/failure tests; latest combined JS evidence is **231 passes** (DB/direction/updates were unchanged and not rerun in this localized startup correction). Build and lint passed.

New native assertions cover new-folder allocation without overwriting unrelated files, activation before remote connection, local retention when cloud setup fails, no remote mutation if local registration fails, and resume refusal for a different Google subject/folder. Controller tests cover actual provider command routing, preserved remote folder ID, cancelled folder choice with no create call, and no success result after a cloud error. Legacy commands are unchanged in the routing test. Live cloud create/download in the new GUI remains pending OS Keychain completion; no such success is claimed.

## Final startup validation and user-driven live success

Final native suite: **204 passed, 0 failed, 11 ignored, 2 unchanged heavy fixtures filtered**, 29.59s. Retaining their prior full-suite results gives **206 unique native passes; 100 Drive passes**. All JS suites reran after the final UI changes: **47 layout/controller + 173 database + 4 direction + 7 updates = 231 passes, 0 failures**. Build/lint passed. The receipt regression now also rejects a lost completed target or missing partially downloaded stage instead of silently creating an empty local input.

After the user authorized Keychain, the editor opened My notes and UI showed Synced. App-data inspection, with only counts/booleans retained, found a saved Drive binding/provider-switch receipt, one baseline page, two retained batches, zero outbox entries and a saved checkpoint. This is real user-driven create/connect/open/first-publication evidence, not a second-device download or long-duration refresh test. No actual user note was edited by automation.

The Workspaces dialog now uses the same provider-aware list/download helpers as startup. Legacy cloud-delete/everywhere actions are hidden for Drive, and legacy native cloud-delete/reupload reject Drive/GitHub binding IDs before mutation. Drive New workspace routes through the safe picker; existing editor/repo/preferences flush before switching. Cloud retention/deletion remains unavailable rather than falling through to the old server.

The final extra controller assertion covers safe switching: drain editor/repo/preferences before activation, freeze writes during the change, thaw only after a failed native action, and never resume the old editor after a successful activation. It is used by both Drive account and Workspaces switching paths. Layout/controller total is now 47.
