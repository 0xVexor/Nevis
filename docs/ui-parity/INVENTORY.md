# UI parity: inventory (old app → nevis-next)

Goal: every screen of the old app (`Nevis/spike/tiptap/src`, port 5190) looks and behaves the same here. Method: copy the old presentational code, replace only the data layer, compare screenshots side by side (same data, viewport, theme, language) per screen.

## What the old UI needs from data

The old UI talks to one object, `repo` (interface `PageRepo`, `documents/model.ts`): `get/list/pagesOnly` are **synchronous**, `update/create/remove/move/...` are fire-and-forget, `Page.content` is TipTap JSON saved through `repo.update({content})`.

Consequences (decided):
1. **Adapter = in-memory mirror** of the new store with the `PageRepo` surface; its change signal is driven by the new core's change feed. Written once, in `apps/web/src/shell/repoAdapter.ts`.
2. **The body is never routed through `repo.update`.** The page body stays the Yjs editor (M8a). Old `PageView` chrome (title, icon, cover, status, tags, banners, reader bar) is copied around it; the old save pipeline (`setEditorDirty`, `flushBeforeUpdate`, `isWriteLocked`, conflict files) is not ported.
3. Old code that imports `store|repo|db|kvStore|backup|conflict|vault` is forbidden by `.dependency-cruiser.cjs`; the copy imports the adapter under a different name, and Tauri calls go through ports.

## Buckets

| Bucket | Modules |
|---|---|
| Copy verbatim | `design-system/*`, `ds/areas/*.css`, `PageTree`, `HomeScreen`, `PagesTable`, `Trash`, `Cover`, `PageStatusChip`, `PageIcon`, `Brand*`, `HorizontalScroll`, `SideTip`, `settings-ui/*` (visual parts), `iconSet`, `i18n` |
| Port to new core | `repo` (adapter), `settings`/`useKv` (deviceSettings + synced settings), `searchIndex`/`pageIndex` (`@nevis/search`), `cardsDue` (cards), `sync/SyncIndicator`+`SyncSettings` (engine status), `templates`, `database/*` (M7 data, old views), `GraphView` data (`linkGraph`) |
| Needs a decision (stub/drop?) | `decks/*` and slides (behind `SLIDES_ENABLED`), `Vaults`/`VaultSwitcher` (our workspaces list replaces), `UpdateCenter`/`updates` (M15 updater), `Drawings` list page, `conflict/*` (the new core has no file conflicts), `mcp/ConnectionSettings` (M14), `print` |

## Screens, in order

1. Shell (rail, side panel, topbar), Home, Page view (vertical slice, then compare and show)
2. Tasks, 3. Databases + Board, 4. Graph, 5. Settings (all tabs), 6. Flashcards, 7. History, 8. Templates, 9. Trash/All pages, 10. Onboarding/auth, 11. Mobile widths

Done for a screen = screenshot pair with the same data shows no difference the owner can name, plus its Playwright tests green.

## Progress (checked with `node tools/uiparity/shoot.mjs <dir> [screen]`: same fixture, viewport, theme, language)

Screenshot pairs checked and matching the old app (differences only in data such as times): shell, Home, page (header, properties, drawer, reader, toolbar, find), Settings (all tabs), Tasks (inbox, lists), Templates (old five + drawing), Flashcards (empty state), All pages, Graph, Files, Drawings, Databases (list), mobile width (Home).

Known differences, kept honest:
- Database page and board: old frame, header row and empty state, but not the old toolbar (filter, group, view types calendar/chart/form/dashboard, properties panel). The old database UI (~10k lines) sits on a different engine; it is a separate piece of work.
- Drawings list shows a pencil instead of a thumbnail (the picture is not stored apart from its scene).
- Databases list preview is a short summary (properties, first rows), not the old live preview.
- Flashcard review mode, History and Trash were compared only in their empty/first-round form.
- Sync tab in Settings is minimal; the AI connection tab waits for M14; slides are not part of this app.
- Copied files carry `@ts-nocheck` (graph, Explorer, Drawings, Databases, Toolbar): they ran as written in the old app; the new strict index checks are not applied to them.

Tests: Playwright 133 passed across Chromium (47), Firefox and WebKit (86); `pnpm check` clean. New: tests/screens.spec.ts (inbox tasks, files/drawings/databases, find in page and toolbar).
