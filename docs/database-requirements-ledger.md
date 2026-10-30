# Database requirements ledger

Maps `docs/notion-database-handoff.md` to the code and tests. Four completion flags are tracked separately and **none of the last three is
claimed**:

| Flag | Meaning | Status |
|---|---|---|
| `local_complete` | the feature works on this device from the repo, with tests | see rows; gaps are listed under "Not done" |
| `hosted_verified` | the gateway deployed and exercised end to end | **false** (never deployed; tested only on localhost) |
| `notion_comparison_verified` | behavior compared with live Notion | **false** (no live comparison was done) |

`externalVerification`: `n/a` = needs nothing external; `adapter_tested` = passes on mocks/fixtures only; `none` = not attempted.
Paths are relative to `spike/tiptap/src/database/` unless they start with `src-tauri/`, `services/`, `db/` or `docs/`.
Tests: `npm run test:db` in `spike/tiptap` (domain, 169 tests), `services/database-gateway: npm test` (19), `cargo test` (39, of which 17 `database::*`
and 4 sync), plus the existing `db/test-*.mjs` and `node db/check-i18n.mjs`.

| requirementId | targetSection | implementationPaths | testIds | localStatus | externalVerification | knownDeviation |
|---|---|---|---|---|---|---|
| DB-MODEL | §4–5 canonical model, wire types | `model/*`, `state.ts` | persistence.test (13) | done | n/a | row = Page + `database` extension; records in `databases/<kind>/` |
| DB-STORAGE-MEM | §6 journal, recovery | `storage/memory.ts`, `commands/coordinator.ts` | persistence.test (crash points, retry, replay) | done | n/a | journal checks record `revision`, not a content hash |
| DB-STORAGE-IDB | §6 browser parity | `storage/idb.ts`, `src/db.ts` (v2 stores) | idb.test (6, fake-indexeddb) | done | none (no real browser multi-tab run) | |
| DB-STORAGE-RUST | §6 desktop | `src-tauri/src/database/{mod,index,merge}.rs`, `storage/tauri.ts` | cargo `database::*` (17) | done | none (not run through the packaged app) | |
| DB-INDEX | §12.2 rebuildable SQLite index | `src-tauri/src/database/index.rs` | cargo tests (rebuild, apply_batch) | done | n/a | index failure marks `needs_rebuild`; never fails a commit |
| DB-PROPS | §7 property registry (all kinds) | `props/*`, `resolver.ts` | query.test, convert.test, formula.test | done | n/a | `connected` cells are display-only (not filterable / formula-readable) |
| DB-DATES | §8 dates, Jalali, DST, relative | `dates.ts`, `reminders.ts` | dates.test (8), reminders.test (3) | done | n/a | reminders deliver while the app runs + 24 h catch-up; closed-app delivery needs the gateway (not wired) |
| DB-CONVERT | §9 conversion with preview hash | `commands/convert.ts` | convert.test (14) | done | n/a | |
| DB-QUERY | §10 operators, sort, group, totals, cursor | `query/*`, `access.ts` | query.test (17), F01–F37 vectors | done | n/a | |
| DB-CREATE-CTX | §11 create in context | `commands/rows.ts` | query.test, views.test | done | n/a | |
| DB-COMMANDS | §12 commands, undo, idempotency | `commands/*`, `service.ts` | persistence.test, duplicate.test | done | n/a | |
| DB-RELATIONS | §13 relations, edges | `commands/relations.ts`, `graph.ts` | persistence.test, tasks-graph.test | done | n/a | |
| DB-ROLLUP | §14 aggregates, rollups | `query/aggregate.ts`, `resolver.ts` | query.test, formula.test | done | n/a | |
| DB-FORMULA | §15 formula language (89 functions) | `formula/*` | formula.test (35) | done | n/a | arithmetic with Empty propagates Empty (product decision) |
| DB-UI-SHELL | §16 shared UI shell | `ui/DatabaseContainer.tsx`, `ui/CellEditor.tsx`, `ui/View*.tsx` | none automated; browser smoke | implemented, smoke-checked | n/a | **no automated UI tests**; keyboard, drag and paste paths were not exercised one by one |
| DB-VIEW-TABLE | §17.1 | `ui/TableView.tsx` | views.test (data logic) + browser smoke | implemented | n/a | |
| DB-VIEW-BOARD | §17.2 | `ui/BoardViews.tsx`, `viewLogic.ts` | views.test (drop plans) | implemented | n/a | |
| DB-VIEW-LIST-GALLERY | §17.3 | `ui/BoardViews.tsx` | browser smoke | implemented | n/a | |
| DB-VIEW-CALENDAR-TIMELINE | §17.4–5 | `ui/ScheduleViews.tsx`, `viewLogic.ts` | views.test (date drag, schedule model) | implemented | n/a | |
| DB-VIEW-CHART | §17.6 | `query/chart.ts`, `ui/ChartView.tsx` | views.test (chart data / SVG) | implemented | n/a | |
| DB-VIEW-MAP | §17.7 | `ui/MapView.tsx` | views.test (map model) | implemented | none | no tile provider or key shipped; tile URL set by the user in Settings → Database; pins on a plain grid otherwise |
| DB-VIEW-FEED | §17.8 | `ui/FeedView.tsx`, `commands/comments.ts` | views.test (counts) | implemented | n/a | |
| DB-VIEW-FORM | §17.9 | `forms.ts`, `ui/FormView.tsx`, `commands/forms.ts` | views.test, gateway-client.test | implemented | adapter_tested (gateway on localhost) | |
| DB-VIEW-DASHBOARD | §17.10 | `ui/DashboardView.tsx`, `viewLogic.ts` | views.test (global filter) | implemented | n/a | widget layout is a simple row grid (no drag-to-arrange) |
| DB-LAYOUT-TEMPLATES | §18 page layout, templates, repeat | `commands/templates.ts`, `repeat.ts`, `ui/RowProperties.tsx` | workflow-data.test, tasks-graph.test | done | n/a | |
| DB-TASKS | §19 sub-items, dependencies, sprints | `commands/tasks.ts` | tasks-graph.test (8) | done | n/a | |
| DB-GRAPH | §20 typed graph, budgets | `graph.ts`, `ui/GraphEdges.tsx`, `src/GraphView.tsx` | tasks-graph.test | selector done; UI toggles added | n/a | the graph layout worker belongs to another change; no database-specific worker |
| DB-WORKFLOWS | §21 buttons, automations, outbox, schedules, leases | `workflows/*`, `ui/WorkflowPanel.tsx` | workflows.test (12) | done | adapter_tested (stub receiver) | the desktop outbox has no built-in HTTP sender; external effects go through the gateway adapter interface |
| DB-ACCESS | §22 principals, grants, comments | `access.ts`, `commands/{records,comments}.ts` | query.test, views.test | done for the local owner + grants model | none | single local owner in practice; no multi-user identity |
| DB-GATEWAY-PUBLICATION | §24–25 publications, forms, inbox | `services/database-gateway/src/publications.ts`, `gateway/client.ts` | gateway.test (19), gateway-client.test (5) | done (private-publication mode) | **none** (never deployed) | owner auth is an API token, not OIDC |
| DB-GATEWAY-JOBS | §25 hosted runner | `services/database-gateway/src/{jobs,outbox}.ts` | gateway.test | done | adapter_tested | |
| DB-GATEWAY-SHARED | §24 shared-workspace mode | `services/database-gateway/src/server.ts` (501 stubs) | gateway.test (capabilities) | **not done** | none | endpoints answer `501 unsupported` |
| DB-GATEWAY-OIDC | §25 identity provider | — | — | **not done** | none | |
| DB-PROVIDERS-CONNECTED | §26 Drive file, Figma, Zendesk, GitHub PR | `providers/connected.ts`, `providers/refresh.ts`, cell kind `connected` | providers.test | adapters done; cell + commands done | adapter_tested only | no refresh button / scheduled refresh in the UI yet; endpoints written from public API knowledge, not re-checked against current provider docs |
| DB-PROVIDERS-SOURCES | §26 GitHub, GitLab, Jira, Asana imports | `providers/sources.ts`, `commands/external.ts` | providers.test | adapters + commands done | adapter_tested only | no UI to link a source or start a pull (commands and gateway routes exist) |
| DB-ALLOC | §27 unique ids | `commands/util.ts` (allocate), `resolver.ts` | persistence.test, tasks-graph.test | done | n/a | |
| DB-IMPORT-EXPORT | §27 CSV, backup v2 | `csv.ts`, `backup2.ts`, `ui/ImportExport.tsx` | interchange.test (11) | done | n/a | |
| DB-LIMITS | §27 limits | `commands/util.ts` (LIMITS) | persistence.test | done | n/a | |
| DB-PERF | §29 workload | `db/bench/database-bench.mjs` | measured, see `docs/database-performance.md` | measured on the memory adapter only | n/a | no IDB/Tauri/UI timings, no frame-drop numbers |
| DB-I18N | §31 Persian | `ui/fa-db.ts`, `src/i18n.ts`, `db/check-i18n.mjs` | `node db/check-i18n.mjs` (0 database strings missing) | done | n/a | |
| DB-A11Y-RTL | §29 RTL/accessibility | logical CSS in `src/styles/database.css` | none | partial | none | no zoom-200% pass, no screen-reader pass, no Persian IME test |
| DB-EMBED | §18 inline database in a page | `src/editor/databaseEmbed.ts` | browser smoke | done | n/a | |
| DB-APP-INTEGRATION | §31 app wiring | `src/App.tsx`, `src/PageView.tsx`, `src/pageIndex.ts`, `src/SettingsPage.tsx` | browser smoke | done | n/a | |
| DB-VECTORS | §28 F01–F40 | see tests | F01–F39 appear by id in query / convert / formula / persistence / tasks tests | covered by suites above | n/a | F40 and the legacy 122-case inventory (§33) were not mapped one by one |

## Not done

* Shared-workspace service mode, OIDC, public-form file uploads.
* UI for linking an imported source, refreshing a connected cell, and for reviewing rejected public submissions beyond the counts shown in the form panel.
* Automated UI tests; accessibility and RTL audit; Worker for heavy queries (not needed at the measured sizes).
* Owner token for the gateway is kept in `localStorage`, not the OS credential store.
