<!-- Current migration state and verification preference supersede historical milestones below: see ui-handoff.fa.md and ui-design-language.fa.md. -->

# UI foundations: architecture and destination study

Status: steps 1–2 reviewed; first production Settings migration implemented on the feature branch.
Baseline: origin/dev 5191392, fetched 2026-11-02. Branch: feature/ui-foundations-spec.

## Decision

Rebuild presentation around a reusable design contract while retaining application behavior. The Balanced concept on port 4178 informs visual hierarchy, restrained color and spacing; it is not the functional specification. The existing application is the feature/behavior specification.

Do not delete all frontend code. Rendering, accessible interaction and application commands are currently interleaved. Replace an old presentation only after its replacement preserves those contracts. Do not create a permanent second production skin. The separate Settings preview is a temporary design study, not the new framework.

## Current architecture: evidence and boundaries

All paths below are relative to spike/tiptap/src/.

| Area | Current sources | Keep / change |
| --- | --- | --- |
| Foundations | design-system/tokens.css, areas/tokens.css, index.css | Consolidate semantic definitions and remove obsolete aliases after consumers migrate. Current import order permits overlapping screen rules. |
| Reusable controls | design-system/Button.tsx, controls.tsx, Menu.tsx, useMenu.tsx, overlay.tsx | Retain observable interaction contracts; migrate implementation/style as needed. |
| Coupling in shared UI | Menu.tsx imports Popover from ui.tsx; ui.tsx also contains application-specific search/trash/dialog tools | Extract generic positioning, dismissal and focus behavior before packaging. A folder named design-system is not yet an independent package. |
| Translation/direction | i18n.ts, textDirection.ts, design-system/dir.ts | Core receives translated labels and explicit direction. App adapters own translation and mixed-content direction decisions. Current dirOf reads document state. |
| Settings presentation | SettingsPage.tsx, SettingsParts.tsx, areas/settings.css, screens.css | Replace layout and local control duplicates. Preserve all existing categories and settings. |
| Preferences behavior | settings.ts, preferenceEvents.ts, sharedPreferences.ts, fontStack.ts | Keep state, validation/normalization, font loading, device/vault scope and persistence. Expose an adapter to presentation. settings.apply currently directly writes CSS/DOM; split theme adaptation from storage later. |
| Document surface | PageView.tsx, Toolbar.tsx, PageIcon.tsx, Cover.tsx, ReaderBar.tsx | App compositions. Keep editing commands, selection, undo, block identity, autosave and reader state; replace chrome separately from EditorContent. |
| Editor behavior | editor/ (49 source files), documentCommitGuard, direction/layout/schema extensions | Outside visual rewrite. Node views may mix chrome and behavior: audit individually. Never animate the editable document/caret wholesale. |
| Product orchestration | App.tsx imports store/repo, UI, navigation, exports, Tauri and updates | Retain commands and navigation; gradually extract presentation shells with callbacks. |
| Database | database/ui/common.tsx subscribes to database/runtime and service | Views are product adapters, not generic table primitives. Keep commands, filtering, grouping, virtualization and cell-edit lifecycle. |
| Data/platform | documents/, database/model + commands + service, db.ts, store.ts, repo.ts, backup/, mcp/, platform/ | Excluded from redesign except narrowly tested adapter seams. No schema/persistence rewrites. |

## Target dependency direction

Application services → Nevis adapters → product compositions → reusable React controls → foundations.

Dependencies may point right only. Core must not import Nevis settings/store/repo, Tauri, database services or application i18n. Core accepts props/callbacks, labels, direction, theme and motion preferences. App adapters own side effects. Keep src/design-system as the initial migration home; extract packages only once a real consumer can use them without importing the app.

| Layer | Contents | Contract |
| --- | --- | --- |
| Foundations | semantic color, space, type, shape, size, layering and motion tokens | CSS variables; theme/accent/density/direction inputs; no React or storage |
| Controls | Button, IconButton, Field, Checkbox, Switch, Radio/Segmented, Menu/Select, Tabs, Tooltip, Dialog, Toast, Popover | Typed controlled state; focus, keyboard, dismissal and disabled/error/loading behavior |
| Patterns | SettingsGroup/SettingRow, SearchField, EmptyState, NavigationItem, Toolbar, property row, split action | Compose controls; no service imports |
| Nevis compositions | workspace shell, document header, editor tools, database views, review/graph/reader | Receive real app models/commands; preserve product-specific behavior |
| Adapters | preferences, navigation, file commands, document/database mutations | Existing functional contracts; bridge labels/theme into UI |

## Component inventory and priorities

P0: tokens + provider, focus/ring, typography, Button/IconButton, Field, Switch/Checkbox, Segmented, Menu/Select/Popover, Tabs, Dialog and Tooltip. All must define default/hover/pressed/selected/disabled/focus/error/loading where applicable.

P1: SettingsGroup/SettingRow, search, split action, sidebar navigation, badge/count, chip/status, toast, empty/error/loading states. Counts remain outlined circles. P2: document metadata/cover/icon controls, toolbar, table-cell editor surface, reader dock, graph controls and flashcard composition.

Do not turn domain-specific database cells or TipTap node views into generic controls solely to increase reuse. Do not select a headless library until its menu, dialog and RTL contracts have been tested against these requirements.

## Destination contract (review proposal)

- Quiet flat surfaces, hairline separation, one accent for action/focus/selection; no extra gradients or card-per-control layout.
- 4px spacing unit. Common gaps 8/12/16/24/32; controls 36px, compact 28px, navigation rows 36px. Consistent 18px control icons.
- UI text 14/1.5; caption 12; section 18–20; page heading 30–32; editor sizing remains independently user-controlled.
- Instrument Sans + Vazirmatn; existing custom font behavior remains available. Rounded geometry is theme input, not independent feature CSS.
- Full default/hover/pressed/selected/disabled/focus states, visible keyboard focus, meaning conveyed with words/icons as well as color.
- Motion: hover 120ms, menu 180–220ms, layout 280–320ms; spring starting point stiffness 460/damping 36/mass .8. Animate surfaces and selection, never move sidebar footer buttons on navigation. Honor OS and user reduced-motion settings.
- Separate interface direction, content direction and number/code direction. Narrow settings stack controls and use horizontally scrollable category navigation.

## Settings coverage and adapter contracts

| Category | Existing behavior to preserve | Design study / later migration |
| --- | --- | --- |
| Appearance | theme, accent, background/file picker, strength/glass, radius, sidebar/pages view, cover/icon visibility | Study: theme/accent/shape/navigation/display controls and reactive live preview. File backgrounds/glass remain a later composition, not removed. |
| Editor & font | separate Persian/Latin families, lazy font previews, size, text color | Study: real family selectors + size; complete picker/text-color migration later. |
| Language | en/fa, independent auto/ltr/rtl interface direction | Interactive in study; document text is not translated or redirected. |
| General | reminders, compression; reduce motion currently under Appearance | Study includes these functional preferences and accessibility setting. Final placement requires review. |
| Data & backup | DataTab/DataApi, import/export, automatic backup, workspace actions | Preserve existing functional component until migration; no fake destructive controls in study. |
| Database | lazy DatabaseSettings and external service configuration | Retain full category and domain adapter. |
| AI connection | McpConnectionSettings, permissions, client installation | Retain native security/permission flows and disabled states. |
| Shortcuts | pauseBindings, conflicts, bindings and reset | Preserve keyboard recording/conflict behavior, not just inputs. |
| About | Brand, version, update service, design-system entry | Preserve native update lifecycle and version state. |

## Migration gates after review

1. Approve or revise visual direction using the Settings study and component states. No approval to remove existing features is implied.
2. Build the reusable core and a gallery with light/dark/custom-accent, English/Persian, keyboard and reduced-motion fixtures.
3. Connect complete Settings via the preferences adapter, including all categories above. Then delete replaced local controls/CSS and update live reference + guide together.
4. Migrate shell → document chrome → Home → database → flashcards/graph → editor tools/reader. Keep old functionality tests and add interaction tests at adapter seams, not snapshots of every style.
5. Extract for another app only after a second themed consumer works without Nevis imports. Record public API/versioning and forbid new feature-specific control implementations with UI guard checks.

Acceptance for each migration: build/typecheck/lint/UI guard pass; keyboard and focus restore; EN/FA and mixed content; light/dark/custom accent; narrow width; reduced motion; no edit/save/undo/navigation regression. Remove legacy styles only for migrated consumers.

## Verified study and findings

The independent study and the unchanged production entry both build successfully. TypeScript, lint and UI guard pass; existing lint warnings remain, with no warnings in the new study files. Browser checks covered light/dark, custom accent, Persian/RTL, English, a 390px viewport without horizontal page overflow, preference persistence after reload, and user reduced motion (computed animation becomes none). Keyboard adjustment to editor size changed the miniature body text while the interface stayed 14px.

Existing Menu supports arrow navigation and Escape dismissal. The missing focus return found during review has now been fixed in shared useMenu and manually verified against the production English-font dropdown. Full accessibility and focus-trap coverage remains part of the framework rollout.

Other concrete duplication: SettingsPage and mcp/ConnectionSettings define local switch buttons; database/ui/forms defines another switch input alongside design-system/controls. Consolidate their APIs and label-click/disabled/RTL contracts before deleting their styles. The study deliberately uses the existing shared Switch instead.

Study CSS is isolated to its HTML entry; its proposed token values and layouts are review material. Step 3 must consolidate approved values into the core, rather than importing this preview as an override stylesheet in production.

## Run the step-2 study

The study now contains all nine Settings categories. Sidebar style uses an illustrated radio chooser and a single shared miniature for Default/Compact/Icons only; Compact retains labels and reduces row height/width, Icons hides labels/counts. Tree/compact page-list geometry, search and stable footer actions are represented in the live miniature.

Data & backup provides a working export/review/import flow for this preview's preferences only. It does not initialize the document store or restore a vault. AI policy controls are explicitly draft-only, and native connection/client installation controls are disabled. Database drafts validate map/gateway URLs, save locally without contacting a server, and never persist the preview token. Shortcuts show the app's complete source list and reuse its physical-key capture, conflict checking and reset behavior. About uses the real package version. Full vault backup/import/workspace management, live gateway verification, desktop updates and native AI connection remain production integration work, not simulated successes.

From spike/tiptap: npm run dev:settings. Open http://127.0.0.1:4182/settings-preview.html.
It uses the existing preferences engine on an isolated browser origin, and existing Button/Switch/Dropdown primitives. It does not initialize a vault, document store, backup, MCP or native app. Settings on port 4180 and in the desktop app are unaffected. Reset affects only this preview origin.

## First production migration delivered

Production SettingsPage is now a small adapter over settings-ui/SettingsWorkspace. The approved layout and workspace preview are shared with the review entry. PreferenceGroup, PreferenceRow, SegmentedChoice and RangeControl live in the existing design-system, accept values/labels/callbacks and import no application services. Their gallery includes LTR/RTL fixtures. Approved palette, type and control-size tokens have a single production source.

The app presents Settings as a dedicated surface with its own category navigation and a Back to workspace action, preserving the workspace sidebar state. Actual DataTab/DataApi, McpConnectionSettings, DatabaseSettings, shortcut recorder and update service are wired in. The browser limitations of those native services remain genuine limitations. Background selection/file attachments/glass, text color and lazy font samples were preserved as advanced controls. No vault data, backup format or database schema was changed.

Removed the old SettingsView shell, old theme/placeholder preview, local switch duplicates in AI and Updates, and their unused CSS. Consolidated the late Settings skin into the owning stylesheet. Native service section layouts remain in that stylesheet pending further per-panel component migration; this is not yet a complete portable framework.

Validation: production + review-entry build/typecheck, lint (existing warnings), UI guard. Existing layout suite: 70/70 pass. Browser: dedicated Settings and return navigation, actual dark/compact preferences reflected in the workspace, English/Persian RTL, real backup controls, editor/font controls, menu arrows/Escape/focus return. Native Tauri operations and macOS execution have not been exercised here.

Remaining: central command registry and wiring all editor/graph/review shortcut overrides (the production recorder still edits the six existing app bindings), Motion React lifecycle/layout integration, complete dialog focus trapping, second-app package extraction and subsequent shell/document/database migrations. Changes are on feature/ui-foundations-spec, not merged to dev.
