# Database feature — setup, tests, capability status

## Where things are

| Area | Path |
|---|---|
| Domain engine (pure TypeScript, runs in Node and the browser) | `spike/tiptap/src/database/` |
| UI (React) | `spike/tiptap/src/database/ui/` + `spike/tiptap/src/styles/database.css` |
| Storage adapters | `spike/tiptap/src/database/storage/` (memory, IndexedDB, Tauri) |
| Rust: journal, recovery, index, merge | `spike/tiptap/src-tauri/src/database/` |
| Optional gateway service | `services/database-gateway/` (own README) |
| Tests | `db/tests/database/*.test.mjs`, `services/database-gateway/test/`, `cargo test` |
| Ledger / performance | `docs/database-requirements-ledger.md`, `docs/database-performance.md` |

## Commands

```bash
cd spike/tiptap
npm run test:db          # domain tests (169)
npx tsc -p tsconfig.app.json --noEmit
npm run lint             # oxlint; one error remains in src/autobackup.ts (not part of this feature)
npm run build
node ../../db/check-i18n.mjs
```

```bash
cd services/database-gateway && npm test
cd spike/tiptap/src-tauri && cargo test
```

On a machine with little space on `C:`, point cargo at another drive: `CARGO_TARGET_DIR=/f/work/cargo-target`, and run the test binary with `TEMP` on that
drive (linking fails if `TEMP` is overridden at build time).

## Using it

* Sidebar → **New database** (or the command palette), or `/Database` inside a page for an inline one.
* Views: table, board, list, gallery, calendar, timeline, chart, map, feed, form, dashboard. Rows are ordinary pages; open one to see its properties above the body.
* Settings → **Database**: first day of the week, optional map tile URL + attribution (no provider or key is bundled), gateway address and owner token.

## Capability status (what the app itself shows)

| Capability | State | Needs |
|---|---|---|
| Local databases, all views, import/export, backup, formulas, reminders (while the app is open) | ready | nothing |
| Public forms, outbound messages, scheduled jobs | `needs_setup` until a gateway is configured; `ready` after Settings → Database → Check connection succeeds | run `services/database-gateway`, an owner token, HTTPS in production |
| Connected properties / imported sources | adapters exist; a connection with credentials must be added to the gateway's connections file | provider credentials (not provided) |
| Shared workspaces (several people editing one server-side database) | `unsupported` | not implemented |
| Sync of databases between devices through the Noviq server | merge logic implemented and unit-tested; **not verified on two real devices** | a two-device test against the server |

Environment templates: `services/database-gateway/.env.example` (no credentials). Provider tokens belong in the gateway's connections file or an OS credential store, never in the Vault.
