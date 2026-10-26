# NV-MCP-01 — Source baseline and agent document fixtures

Date: 2026-10-26 (Asia/Tehran). Status: complete for baseline capture and fixtures. This checkpoint does not implement an MCP endpoint, document edits, or a portable search engine.

## Branch baseline

Fetched `origin` and fast-forwarded the clean local `dev` from `4792ace` to `1812042bb5030bef279cf0c5e04ca8f87f7dfd89` (`Merge pull request #18: fix sync compatibility and task directions`). Created `feature/mcp-document-tools` from that revision. No remote branch was merged into a feature branch independently of `dev`.

The fetched release branch `origin/main` points to `78a5dfff79f2203a3906c230b9f55ae711431b10`. Local development follows `dev`, per [Git flow](../git-flow.md). No release or framework migration is included.

## Executable corpus

- [Fixture guide](../../db/fixtures/agent-documents/README.md)
- [Page JSON](../../db/fixtures/agent-documents/pages.json): one folder and seven documents, entirely synthetic.
- [Manifest](../../db/fixtures/agent-documents/manifest.json): exact revision-bound targets, eight normalization cases, visibility inputs, and five future workflow scenarios.
- [Checks](../../db/test-agent-documents.mjs): reference/hierarchy integrity, exact targets, coverage and existing TypeScript normalization. No new test framework or runtime dependency.

Coverage includes mixed Persian/English, Arabic/Persian letter and digit variants, ZWNJ, duplicate headings, code, formatting/direction attributes, nested callout/toggle content, linked pages, a merged-cell RTL table, inline/block formulas, Mermaid attributes, an 80-section note, an intentionally unsupported node with opaque payload, exclusion input, and a trashed document.

These are test documents, not a vault backup. Fixture paths are tied to this content revision, not stable block IDs. The unsupported node is deliberate; no claim of full editor-schema acceptance is made. Exclusion inputs and workflow scenarios describe future integration acceptance, not access-control or editing behavior already implemented.

## Observed validation

Environment: macOS arm64; Node `v26.4.0`, npm `11.17.0`. CI config uses Node 24; CI itself was not run for this checkpoint.

Run from `spike/tiptap/`:

| Command | Observed result |
|---|---|
| `npm ci --cache /private/tmp/nevis-npm-cache --no-audit --no-fund` | Installed 364 locked packages; existing React/Radix peer warnings and an unapproved optional fsevents install-script notice. No lockfile changes |
| `npm run build` | Passed TypeScript and Vite production build; Vite reported existing ineffective dynamic-import warnings |
| `npm run lint` | Exit 1: 234 warnings and one existing error in `src/autobackup.ts:116`, `react-hooks/rules-of-hooks` for `useFolder` inside `chooseBackupFolder`. Production source is unchanged in this checkpoint |
| `npm run test:updates` | 7 passed |
| `npm run test:direction` | 4 passed |
| `npm run test:documents` | 11 passed: 3 corpus integrity/coverage checks and 8 normalization cases |
| `npm run test:db` | 173 passed after installing the separate locked test dependency and allowing the suite's local loopback server |

Database preparation: run `npm ci --cache /private/tmp/nevis-npm-cache --no-audit --no-fund` from `db/tests/tools/` to install `fake-indexeddb`. The first sandboxed database run had 162 passes and 6 failures (five loopback `EPERM` errors and a missing IndexedDB test module); the prepared rerun passed all 173 tests. Do not interpret the first run as six product regressions.

The new `test:documents` command is included in the app CI job. Its CI/Windows result remains unverified locally.

Native limitation: `cargo --version` itself aborts because Homebrew `libgit2` references missing `/opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib` (the installed llhttp path indicates 9.4.2). Cargo tests and Tauri/native packaging were not run. No system libraries were changed. Server tests, native sync end-to-end tests and UI import/render checks were not run for this fixture checkpoint.

## Observations to carry forward

- Current `searchIndex.ts` owns JS normalization/projection but invokes desktop SQLite FTS and uses a different browser fallback. NV-MCP-02 should extract the reusable JS path without moving search into Rust.
- Recursive text-only extraction misses attribute-only math/Mermaid content; fixtures provide explicit targets for later projection tests.
- Current pages have no stable block identities. Duplicate headings and long documents make precise target selection a required contract.
- `Vault.save_pages` preserves timestamp conflicts and writes files atomically, but does not provide the planned strong revision-gated operation receipt protocol.
- A passing corpus check does not establish search relevance, rich-content preservation during edits, crash recovery, grants, or MCP interoperability.

Next: NV-MCP-02 (pure TypeScript projection/normalization boundary) or NV-MCP-03 (actual-client hosting spike). Record the inherited lint issue and native-toolchain limitation separately from those tasks' acceptance criteria.
