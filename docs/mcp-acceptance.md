# MCP read/write acceptance

This record covers the MCP feature PR through tasks 17–20. Tests use synthetic notes. No personal vault or normal client configuration is part of acceptance.

## Automated final gate

| Check | Result |
| --- | --- |
| Document contracts, projections, services, search, persistence, retry/history/undo, MCP policy, table operations and final admission | 101 passed |
| Database suite | 175 passed |
| Layout/editor suite, repeated after upstream caret/scroll integration | 35 passed |
| Direction / updates | 4 / 7 passed |
| MCP SDK, Inspector, source/bundle/lifecycle and HTTP fixture | 6 passed |
| Sync server | 64 passed |
| Native suite | 77 passed |
| Normally ignored native sync integration tests against a disposable local server | 10 passed |
| macOS installer scripts and package structure | 5 passed |
| TypeScript app/core checks, production frontend build and lint | Passed |

There are 484 unique passing automated tests across these groups. Lint retains 239 warnings and no errors. The inherited backup helper was renamed from `useFolder` to `setBackupFolder` so it is not misidentified as a React hook. Release compilation retains the existing unused `changed` and `copy_into` warnings. Vite retains existing chunk-size and dynamic/static import warnings.

The final admission change also passed focused checks after its cancellation/heartbeat lock handling was adjusted. Only the affected layout suite and frontend build were repeated after resolving upstream `45069f2`. Full suites were run at the final implementation gate rather than after every checkpoint.

## Desktop package

The acceptance bundle is a release build of the same source with identifier `com.vexor.nevis.mcp-acceptance`, copied into a disposable `Applications` directory. That isolates its registry, local operations and settings from a normal Nevis installation. The UI launches with the synthetic vault and exposes the expected connection controls.

The product build uses identifier `com.vexor.noviq`. After acceptance enabled the normal write opt-in, the final arm64 `.app` was rebuilt. It received a local ad-hoc signature and passed strict deep signature verification. The generated `.pkg` was expanded without installation. Its identity, fixed install location and exact executable bytes matched the source app, and the expanded app signature verified.

Artifact: `spike/tiptap/src-tauri/target/release/bundle/Nevis-mcp-preview-arm64.pkg`

SHA-256: `4b690a5204699f1bc5bdb7e18c8592475e59c7bdc830fb5207d4bf39e045a209`

The app is approximately 32.46 MiB; the compressed package is approximately 26 MiB. The product contains the native HTTP bridge and embedded frontend, with no separate Node MCP runtime. Node is used by the acceptance clients and developer tooling only.

This is a local arm64 preview, not a notarized public release. Windows/Intel Mac installer execution, Gatekeeper on a downloaded artifact, mobile/web MCP hosting and physical power-loss behavior are not established by this Mac run. Recovery and concurrent writer behavior have automated native/portable evidence; that is distinct from hardware power-loss evidence. No release tag or public installer publication is part of this PR completion.

## Reproduce the desktop workflow

1. Run `node tools/mcp-spike/fixture.mjs /tmp/nevis-mcp-acceptance/<new-run>` to create a fresh synthetic vault and manifest. It refuses existing destinations and personal paths.
2. From `spike/tiptap`, run `npm run tauri -- build --features mcp-write-acceptance --config ../../tools/mcp-spike/tauri.acceptance.json` to build the isolated acceptance app. Apply a local ad-hoc bundle signature when required, then open the synthetic vault in that test app. Normal builds now expose the same tested write opt-in through the default `mcp-writes` Cargo feature. `mcp-write-acceptance` remains an alias for existing acceptance commands; the acceptance app identifier supplies isolation. Connections and write permission still start disabled. In Settings → Agent connections, select **Allowed acceptance**, exclude **Excluded fixture sentinel**, and opt into editing. This is an explicit permission grant.
3. Record the displayed loopback endpoint and the grant ID from the isolated app's per-device MCP configuration. Never add its token to source, reports or logs.
4. Run `node tools/mcp-spike/workflow.mjs <endpoint> <fixture.json> <grant-id> <report.json>`. On macOS, the runner reads this test token directly into memory from Keychain. Handle any OS prompt yourself. It validates all eight tools, exact saved content, original retry receipts, conflicts, exclusions, history, merged-cell editing/row insertion and undo.
5. Run `node tools/mcp-spike/agent-workflow.mjs <endpoint> <fixture.json> <grant-id> <output-directory-under-/tmp/nevis-mcp-acceptance/>` for an ephemeral Codex CLI session. It overrides only that session's MCP configuration and uses the approved test token. The prompt restricts work to the synthetic target and requires preview/apply/retry/read/history/undo.
6. Run `node tools/mcp-spike/lifecycle.mjs <endpoint> <fixture.json> <grant-id> <output-directory>`. After it prints `saved-before-restart`, quit/reopen the isolated app, verify access starts disabled, and enable only the same approved scope. Write `reconnected.json` in that output directory with `endpoint` and `grantId`. The controller verifies old endpoint/token rejection, retained receipt replay/history and exact disk restoration after undo. It stores a credential-free restart checkpoint before reading the rotated token; if that OS prompt times out, rerun with an additional `--resume` argument. Finally disconnect/revoke and confirm the port is closed.

The scripted report records per-call wall time and returned bytes, including structured and text representations. It excludes credentials and note bodies. Its total excludes the Keychain prompt. The agent run includes model/network time and is recorded separately. A single local run is a reproducible observation, not a throughput benchmark or a competitor comparison.

## Live-client evidence, 2026-10-29

The user resumed acceptance and approved the macOS Keychain prompt. The isolated release app used only the **Allowed acceptance** root, with **Excluded fixture sentinel** excluded, and an explicit temporary write grant.

| Workflow | Result | Calls | Returned JSON bytes | Elapsed |
| --- | --- | ---: | ---: | ---: |
| Official TypeScript SDK 2.4.0 | All 13 assertions passed; all eight tools exercised | 24 | 102,812 | 3,051.66 ms |
| Codex CLI, explicitly approved test tools | Preview, apply, original retry receipt, read-back, history and undo passed | 12 | 52,814 | 47,799 ms |

The SDK median call took 24.205 ms and the slowest took 139.95 ms. The largest result was 7,682 bytes. Total elapsed includes deterministic pacing below the host's 16 requests/second budget; individual call times exclude pacing. Credential prompts are excluded. The two rejected SDK calls are expected tests of excluded-document access and stale revisions. There were no failed calls in the successful Codex run. Its elapsed time includes model/network work, so it is not server latency.

The SDK verified merged-cell replacement and row insertion, preservation of neighboring structure, creation, metadata, original retry receipts, conflicts, history and full undo. Codex discovered the intended note through the tools, searched Persian text, read outline/section/full content, previewed and applied an append, repeated the original request, then undid it. Parsed tool results establish completion; a zero CLI exit alone is insufficient. Native before/after operation snapshots independently confirm exact structured-content restoration and the expected document target.

The SDK and agent runs have independent baselines. Opening the fixture in the editor between runs added schema-default attributes and an empty trailing paragraph. Comparing the agent undo against the earlier SDK snapshot therefore fails; comparing its native before snapshot with its undo after snapshot passes exactly. This distinction is recorded in the disk evidence rather than being hidden by projection equality.

Earlier Codex attempts were blocked by client tool approval before mutation. One attempt also supplied an invalid read budget and recovered by reading within the contract. The final ephemeral session explicitly preapproves only the four write tools for this already authorized disposable grant and includes the append shape and budget limits in its prompt. It changes no normal client configuration. The runner checks actual tool receipts, target, full structured reads and disk restoration.

Sanitized reports are retained under [acceptance/2026-10-29](acceptance/2026-10-29/). Raw model events and synthetic note bodies remain in the disposable local run directory; credentials are never included in reports.

Restart closed the original endpoint and reopened with access disabled. Reconnecting retained the same grant identity but rotated the token; the old token received HTTP 401. The original metadata operation replayed from its durable receipt after restart, retained history was available, and undo restored the exact disk content and original title. Final UI revocation showed no local endpoint, and the last port was confirmed closed. The root and excluded note remained byte-identical to their baselines.

Two Keychain reads timed out during the lifecycle check. After the user approved a fresh prompt, the controller resumed from the durable native operation. Its recovered receipt initially used the native storage shape rather than the public receipt shape; mapping the persisted revision and retention deadline to the public contract corrected that harness comparison. The subsequent replay/history/undo assertions passed. The runner now checkpoints without credentials before the rotated-token read and allows a bounded five-minute OS prompt wait on lifecycle runs. SDK/agent credential reads retain a one-minute default.

Following acceptance, the default native `mcp-writes` feature permits an explicit user write grant in normal builds. A build with `--no-default-features` stays read-only. The shared session also requires the host to advertise support; a policy alone cannot enable writes. The full native suite (77), focused document MCP checks (5), app/core typechecks, frontend build and lint passed again after this gate change. The MCP client/config suite (6) was repeated for the harness changes.

## Measured follow-up priorities

1. **Client setup and contract discovery:** document explicit per-tool approval for noninteractive clients, publish valid budget examples and expose discoverable operation examples. The blocked attempts and invalid-budget recovery establish the need; weakening the host grant is unnecessary.
2. **Broader desktop distribution:** execute the installed Windows and Intel Mac packages, then complete signing/notarization and downloaded-artifact checks before claiming those distribution targets. Current evidence supports the local arm64 preview only.
3. **Larger fixed fixtures:** measure long notes, many documents, cancellation under load and suspended/background webviews with the same client/model/configuration recorded. This single small local fixture does not establish throughput or population-level agent success rates.

Tasks 17–20 are complete for the documented macOS arm64 preview scope. The evidence does not establish other desktop installations or a notarized public release. No competitor comparison was performed.
