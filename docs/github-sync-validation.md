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

The frontend build retains the existing large-bundle/dynamic-import warnings. Rust retains existing unused `changed`/`copy_into` method warnings. No performance/10,000-page benchmark, mobile build, Windows/Linux local execution, installer signing or live GitHub authorization is claimed. CI is now configured for Windows/macOS/Linux; it has not been dispatched by this local branch.

## UI and visual verification

Development fixtures are available with `npm run dev`, then `/dev/github-sync-preview.html?state=conflicts&lang=fa`. The fixture entry explicitly mocks native commands and never contacts GitHub. Supported states: `connected`, `conflicts`, `offline`, `signedout`, `device`, `error`, `unconfigured`; `lang=en|fa`, `theme=light|dark`.

Seven state/language/theme combinations rendered in headless installed Chrome without uncaught page errors or horizontal overflow. Additional interactions checked saving 30-second quiet/5-minute poll policies, selecting the remote version of a conflict, cancelling device authorization, and the minimum 820×600 desktop viewport. These checks validate frontend rendering and outgoing command arguments, not real native authentication or repository publication. The screenshots were visually inspected and controls were corrected to use Aurora Paper tokens, consistent borders, radii, focus rings and RTL layout.

- [Persian conflict review](validation/github-sync/conflicts-fa.png)
- [Persian device authorization](validation/github-sync/device-fa.png)
- [Persian dark/offline state](validation/github-sync/offline-dark-fa.png)

## Remaining external acceptance gate

1. Register/configure the real GitHub App and supply its public client ID and slug to the build/release variables.
2. In the native UI, authorize an actual account and selected private repository, verify automatic creation/installation access and real token refresh/rotation with the OS credential store.
3. Migrate an actual copy, check the backup completion marker and hashes, download it on a second device, exercise offline edits/conflict resolution, and restore an independent backup.
4. Pause old clients. Keep legacy remote data and backups until this succeeds. Keep the database gateway if public forms, webhooks or background jobs use it.

No real data repository/account authorization, remote deletion, production migration, server shutdown, commit push or release publication was performed during this implementation. See [setup and architecture](github-personal-vaults.md) for size bounds, conservative asset retention, rollback and server retirement conditions.
