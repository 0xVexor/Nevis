# GitHub personal vault sync — validation record

Date: 2026-10-27. Base: `origin/dev` (`6856491`). Branch: `sync/github-personal-vaults`.

## Automated local results

Environment: macOS arm64, Node 24.19, Rust stable 1.99.1. Rust tools and build output were isolated under `/tmp`; the original checkout's source and staged files were not used as a work area.

| Check | Result |
| --- | --- |
| `npm run build` in `spike/tiptap` | Passed: TypeScript and Vite production assets |
| `npm run test:layout` | 36 passed, including 3 new settings rebase/cache tests |
| `npm run test:direction` | 4 passed |
| `npm ci` in `db/tests/tools`, then `npm run test:db` | 173 passed |
| `npm run test:updates` | 7 passed |
| `cargo test --manifest-path spike/tiptap/src-tauri/Cargo.toml` | 97 passed; 10 existing live legacy-server tests ignored |
| GitHub adapter tests after final error-message adjustment | 5 passed (subset of the Rust suite) |
| `cargo check`, `cargo build` for the native app | Passed on macOS arm64; no executable was launched against the user's vault |
| Oxlint on new sync/preferences modules and changed backup/storage boundary | Passed without warnings |
| `git diff --check`, workflow YAML parsing | Passed |

The 220 frontend tests plus 97 Rust tests total **317 passing tests**, excluding the browser fixture checks below. GitHub REST tests use a local HTTP fixture server and a placeholder token, not an actual account. They check pinned single-parent commits, base-tree preservation, non-forced ref updates, private-repo verification, unchanged-head checkpoint reuse, missing/corrupt inventories and redaction of HTTP error bodies. Provider tests cover lost publication replies, retry without duplicate commits, competing heads, durable pending records, local edits during network work, missing remote workspaces, read-only second-device initialization without a spurious folder-name conflict, and corrupt state. Snapshot tests cover complete conflict preimages, explicit resolution preserving newer edits, metadata/body merges, permanent tombstones, stale-byte resurrection, database delete/edit conflicts, redo recovery, layout preservation, path/symlink/hash checks, settings/kv cache races, referenced assets and GIF recovery.

A production-assets Chrome run with the desktop CSP response header loaded the Tiptap editor and Excalidraw without CSP violations. Excalidraw registers its upstream CDN font fallbacks alongside bundled assets; `font-src` permits that font host specifically while remote scripts remain blocked.

A headless Chrome run against the actual browser/IndexedDB app also built and restored a full backup containing pages, page versions, database records/history/kv and a GIF. Corrupt record checksums and corrupt attachment bytes were rejected before restoration. The database record and attachment bytes survived the reload/roundtrip.

The frontend build retains the existing large-bundle/dynamic-import warnings. Rust retains existing unused `changed`/`copy_into` method warnings. No performance/10,000-page benchmark, mobile build, Windows/Linux local execution, installer signing or live GitHub authorization is claimed. Initial validation was local; subsequent preview CI results are recorded below.

## UI and visual verification

Development fixtures are available with `npm run dev`, then `/dev/github-sync-preview.html?state=conflicts&lang=fa`. The fixture entry explicitly mocks native commands and never contacts GitHub. Supported states: `connected`, `conflicts`, `offline`, `signedout`, `device`, `error`, `unconfigured`; `lang=en|fa`, `theme=light|dark`.

Seven state/language/theme combinations rendered in headless installed Chrome without uncaught page errors or horizontal overflow. Additional interactions checked saving 30-second quiet/5-minute poll policies, selecting the remote version of a conflict, cancelling device authorization, and the minimum 820×600 desktop viewport. These checks validate frontend rendering and outgoing command arguments, not real native authentication or repository publication. The screenshots were visually inspected and controls were corrected to use Aurora Paper tokens, consistent borders, radii, focus rings and RTL layout.

- [Persian conflict review](validation/github-sync/conflicts-fa.png)
- [Persian device authorization](validation/github-sync/device-fa.png)
- [Persian dark/offline state](validation/github-sync/offline-dark-fa.png)

## Remaining external acceptance gate

1. The real GitHub App public client ID and slug are bundled in preview builds (completed).
2. In the native UI, authorize an actual account and selected private repository, verify automatic creation/installation access and real token refresh/rotation with the OS credential store.
3. Migrate an actual copy, check the backup completion marker and hashes, download it on a second device, exercise offline edits/conflict resolution, and restore an independent backup.
4. Pause old clients. Keep legacy remote data and backups until this succeeds. Keep the database gateway if public forms, webhooks or background jobs use it.

No remote deletion, production migration, server shutdown or release publication was performed. The preview branch was pushed to build test installers; the user authorized their account independently. See [setup and architecture](github-personal-vaults.md) for size bounds, conservative asset retention, rollback and server retirement conditions.

## Desktop preview follow-up (2026-10-28)

The registered public GitHub App configuration is now bundled in the isolated preview installers. Both macOS Universal and Windows x64 builds succeeded for `b029d5f`; the subsequent user report prompted the transport/setup repairs below. No branch has been merged.

The installed preview showed a connected account and an incomplete repository setup. A read-only metadata probe found the selected private repository existed and was empty. Public native HTTPS probes to GitHub and its API succeeded; these observations do not establish the cause of the earlier offline error.

The repaired client supports OS proxy configuration, SOCKS and native certificate roots while retaining TLS verification. Error details retain safe transport categories, host and operation phase without URLs, response bodies or credentials. A public-endpoint diagnostic does not read the account, vault or keychain. Repository creation writes a durable receipt before access verification, allowing setup to resume without creating again; missing installation access has explicit recovery controls. Uncertain creation responses are never blindly retried.

Validation: the updated Rust suite passed 99 tests (11 ignored external/legacy tests); a manually invoked public HTTPS probe passed. The frontend production build and targeted lint passed. Isolated browser fixtures checked missing-installation recovery, selecting an existing repository, Persian dark diagnostics and preservation of safe raw error details. Actual account refresh and two-device private-vault publication remain user acceptance checks.

## Guided setup and workspace conflict comparison

Missing repository installation access is now a normal guided step: the connect request opens the GitHub permission page, shows the selected repository, and waits for a read-only installation/repository check. After the user grants access, the original request resumes automatically with its durable creation receipt. Cancelling or closing the dialog stops continuation. Other failures stop the continuation rather than blindly retrying writes. No broader repository permission is granted by the application itself.

Conflicts now open in the main workspace with local/GitHub columns, aligned highlighted lines, complete structured-data comparison, common-version inspection and explicit local/remote/deletion selection. Selection sends the archived conflict ID and version choice to the existing durable resolver; it preserves full bytes and newer edits using the resolver's existing safety behavior. The account dialog links to the workspace review. The existing top-bar sync button now flushes pending editor, repository and shared-preference saves before requesting sync; no duplicate Save button was added.

Validation: 100 Rust tests passed (11 external/legacy tests ignored); 39 frontend structural tests passed, including line alignment, large-note fallback, Unicode, metadata preservation and malformed/binary previews. Production TypeScript/Vite build passed. Targeted lint passed for the new/reworked modules; App.tsx retains pre-existing unrelated lint warnings. Isolated Chrome fixtures exercised automatic conflict opening, local/remote/deletion choices, complete raw-data comparison, save-before-sync ordering, installation continuation and cancellation. English 820px and Persian dark 1280px views kept both columns alongside each other without horizontal overflow. These checks use mock native calls and do not claim a real two-device private-repository acceptance test.

- [Persian workspace comparison](validation/github-sync/workspace-conflicts-fa.png)
- [English workspace comparison](validation/github-sync/workspace-conflicts-en.png)

## Rendered conflict documents and manual builds

The workspace comparison now renders note content using the same schema, hydration and `.tiptap` styles as the editor/history preview. Headings, marks, lists, task state and document properties remain readable; the previews do not register save callbacks and task inputs are disabled. Differing blocks use the configured accent tokens. Raw data is behind a collapsed technical-details section. Both columns, paper surfaces, radii, typography and action controls use Aurora Paper tokens. Non-note records are shown as labeled fields, and selecting a side still resolves the original complete archived bytes.

The preview workflow no longer builds on ordinary feature-branch pushes. `scripts/build-desktop.mjs` builds the current checkout locally, or explicitly creates a separate `build/desktop/` ref for both GitHub runner platforms. It supports dry runs, reports source SHA/branch/dirty state, and does not merge or install. See [desktop build instructions](desktop-builds.md). The preceding installer run had already completed when the user requested stopping builds. No new installer was built to validate this change.

Validation: TypeScript checking, 39 structural tests, and two build-script tests passed. Mock-native Chrome checks passed for rendered headings, bold text, disabled task controls, changed-block highlighting, all version choices, raw-data access, installation continuation/cancellation and saving before manual sync. Persian dark and English light views were inspected. Script dry runs did not push, build or install; GitHub orchestration and native packaging were not executed for this revision.

## Windows startup loader correction and architecture reference

A local Windows install reported missing `WebView2Loader.dll` at process startup. The previous local build did not pin the Rust target/toolchain. Inspection of the exact `webview2-com-sys` 0.39.1 dependency confirms MSVC statically links `WebView2LoaderStatic`, while non-MSVC builds import `WebView2Loader.dll`. The reported machine's Rust host was not captured, so GNU is the identified build-path failure mode rather than a remotely observed host fact.

The native Windows plan now installs the stable MSVC x64 toolchain; the preview wrapper selects that toolchain and enforces `x86_64-pc-windows-msvc`. The workflow uses the same target and the artifact collector reads the matching target directory and records it in BUILD-INFO. Existing script test expectations were adjusted for the added toolchain-preparation step, but script tests and installer builds were not run, as requested. JavaScript syntax and diff whitespace were checked. Actual Windows rebuild/launch remains unverified.

[The full current sync architecture](sync-architecture.md) documents storage, both engines, routing/locks, authentication and permission setup, snapshots, publication recovery, rendered conflicts, deletion/assets, settings/database data, server/gateway boundaries and limits. Its local links and fenced blocks were checked against the current tree.
