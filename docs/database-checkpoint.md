# Database feature — checkpoint

Branch `feature/database` in the worktree `F:\work\not-lazy-content` (drive F: to spare C:), branched from `perf/lazy-page-content`.
Requirements: `docs/notion-database-handoff.md`. Ledger: `docs/database-requirements-ledger.md`. Setup: `docs/database-setup.md`.

## Status (2026-10-26)

Done and tested: domain engine, storage adapters (memory, IndexedDB, Tauri/Rust), all 11 view types + peek + page properties, workflows, forms, comments/feed,
reminders, CSV/backup, typed graph edges, inline database block, Settings → Database, Persian strings, gateway (publications, inbox, jobs, outbox,
provider routes), desktop gateway client, provider adapters on mocks, benchmark.

Latest runs: `npm run test:db` 169/169 · gateway `npm test` 19/19 · `cargo test` 39/39 · `db/test-*.mjs` all OK · `tsc` clean · `npm run build` OK ·
`oxlint` 0 errors in this feature (1 pre-existing in `src/autobackup.ts`) · `check-i18n` 0 database strings missing.

## Not done
See "Not done" in the ledger: shared-workspace mode, OIDC, public file uploads, two-device sync verification, UI to link an import source or refresh a connected
cell, automated UI tests, accessibility audit, merge with `origin/main`.

## Decisions / deviations
- Journal expected-state check uses record `revision`, not a content hash.
- Arithmetic with an empty operand propagates Empty.
- Lazy page content: uses the existing `repo.ensureContent` from the lazy-content branch; no separate `loadPage` was built.
- Shared local owner principal id `local-owner`.
- Gateway owner token is kept in `localStorage`; moving it to the OS credential store is open.
