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

## Progress (checked with `node tools/uiparity/shoot.mjs <dir> [screen]`, same fixture/viewport/theme/language)

| Screen | State |
|---|---|
| Shell: rail, side panel (favorites, pages, tags), top bar (back/forward, crumbs, save, fullscreen, star, share) | close to the old app in the screenshot pair; Sync dot is new (web has real sync) |
| Home | same layout as the old (banner, continue, quick note, recent, favorites, tasks, flashcards, activity) |
| Page | header, properties (status, tags, last edited), page drawer (facts, actions, outline, navigation), reader mode; **missing:** formatting toolbar strip, in-page find, page-link picker, quick-start templates |
| Settings | old workspace (appearance, editor, language, general, data, database, shortcuts, about) + live preview; Sync tab is minimal; AI connection tab waits for M14 |
| Tasks, Graph, Flashcards, Templates, All pages, Trash, History | still the first-round versions (see STATUS) |
| Databases, Drawings, Files (rail entries) | **not built yet** (route opens Home) |
| Database page and board views | own components, not the old ones (the old database UI is ~10k lines over its own engine) |

Tests: Playwright chromium 35 green after the shell change (nine were fixed: double-click opens, old wording, sync chip, settings screen).
