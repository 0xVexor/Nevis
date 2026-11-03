# Nevis design system

The product logo is `BrandMark` with canonical geometry in `src/brand/mark.ts`; no Settings-specific logo or legacy leaf component remains. `node scripts/generate-brand.mjs` generates the web/site favicon and `src-tauri/app-icon.svg`; add `--icons` to regenerate the existing desktop icon set. `SaveStatus` is the shared, passive save indicator: neutral check and text when saved, a save glyph while saving, and a labelled error state. It has no coloured dot, pill, or pulsing animation. Editor status appears only on an actual open page; Home's note sheet owns its own save feedback.

In the icons-only workspace sidebar, hovering/focusing the logo previews navigation; activating it pins the expanded sidebar. The logo exposes both expanded and pressed states. A second activation or a click outside releases the pin. Sidebar rows remain interactive while pinned; portaled menus and dialogs finish their own interaction before outside-dismissal applies. Returning from Settings clears temporary reveal/pin state.

Settings navigation uses one row geometry for categories and Back to workspace: full-width hit areas inside equal sidebar insets, fixed icon spacing, and labels that can wrap with custom fonts. On short windows only the category list scrolls; the return action stays outside it. At narrow widths categories form a horizontal strip and the return action remains visible below it. Hover, pressed, selected and keyboard focus states use the shared tokens. Production browser checks cover EN/FA, light/dark, monospace, short/narrow windows, keyboard return and default/compact/icons workspace sidebars.

Home starts with an editable first-note sheet and short template previews, plus the existing import/settings entry. The sheet creates a real page on the first meaningful edit, saves through the document service, and stays mounted while writing. Returning users see their last note, a collapsible quick-note sheet and recent pages. The quick draft is excluded from the continuation preview while it is being written. `HomeNote` composes the existing TipTap starter, block-identity and per-block direction extensions; existing rich documents open in PageView. Save feedback waits for durable persistence and failures keep the text available for retry.

First launch and the workspace list are `Onboarding` (`src/onboarding/`), a service-free composition that `VaultPicker` connects to the desktop vault commands. New users go through three steps (welcome and language, name and accent with a live `WorkspaceHeader` preview, folder) and the preview grows into the workspace; people with workspaces see the list, with a context menu on each row, and a two-step flow for a new one. Steps slide in from the side they come from (mirrored in RTL) with `--ds-base`; reduced motion turns this into a crossfade and skips the mark drawing and the landing. The interface says workspace, not vault. `AccentSwatches` is the accent choice shared with Settings. Review at `/onboarding-preview.html` (`?state=returning`, `?fail`, `?lang=fa`, `?theme=dark`, `?accent=%237151c2`, `?reduced`); nothing native is touched. Not yet tested.

Review the actual `HomeScreen` and `HomeNote` compositions at `/home-preview.html` on an isolated Vite origin; `?state=empty`, `?state=single`, `?lang=fa&theme=dark` and `?accent=%237151c2` select fixtures. Preview documents stay in memory and do not initialize a vault. Production checks in isolated browser storage covered lazy creation, repeated edits updating one page, durable saves, opening the full editor and persistence across reload. Visual checks cover full/minimum windows, EN/FA, light/dark, custom accent and one-page/no-icon content. Typecheck and UI guard pass. No production build or full test suite was run.

Current approved direction and migration handoff: [design language (Persian)](ui-design-language.fa.md), [continuation guide (Persian)](ui-handoff.fa.md). Architecture history: [ui-foundations-plan.md](ui-foundations-plan.md). Settings study and production now share their composition and foundations. Run `npm run dev:settings` from `spike/tiptap` and open `/settings-preview.html` on port 4182 for the review entry. Latest migration edits are untested at the user’s request.

Every new screen, feature and component is built from this system. The old layered "Aurora Paper" styles and the `skin.css` that flattened them are gone: every stylesheet now lives in `src/design-system/` (the `ds-` components and tokens, plus `areas/` for the per-screen layouts).

- **Live reference:** open [`docs/design-system/index.html`](design-system/index.html) in a browser. It shows every token and component, in light and dark, English and Persian, with working menus, right-click menus and column layouts. Settings → About → Design system, or `Ctrl K` → "Design system", opens the same page inside it (`#system`).
- **Tokens:** `spike/tiptap/src/design-system/tokens.css`
- **Component styles:** `spike/tiptap/src/design-system/components.css`
- **React primitives:** `spike/tiptap/src/design-system/` (`Menu`, `Dropdown`, `useMenu`), exported from `index.ts`

## Principles

1. **Calm and minimal.** White (or soft dark gray) surfaces, hairline borders, no decorative gradients, no heavy shadows. Shadows appear only on things that float: menus, popovers, modals, toasts.
2. **One accent.** Surfaces, lines and hover states carry a faint tint of the accent, so changing the accent in Settings visibly recolors the whole app. Use the accent for the primary action, focus, selection and links. Nothing else.
3. **Content first.** The page is the product. Chrome stays quiet; color is for meaning (status, tags), not decoration.
4. **Right-to-left is the default case, not an afterthought.** See [Direction](#direction-and-language).
5. **Every control works with a keyboard and shows focus.**

## Tokens

All tokens are `--ds-*`, defined once with `light-dark()`. Never write a raw color, radius, shadow or font in a component.

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--ds-bg` `--ds-side` `--ds-raised` `--ds-sunk` | page · sidebar · cards and inputs · wells and table headers |
| Ink | `--ds-text` `--ds-text-2` `--ds-text-3` | primary · secondary · hints and icons |
| Lines | `--ds-line` `--ds-line-strong` | borders · hover borders |
| States | `--ds-hover` `--ds-press` | row hover · pressed |
| Accent | `--ds-accent` `--ds-accent-ink` `--ds-accent-soft` `--ds-accent-line` | actions and focus · text on accent · selected rows · selected borders |
| Status | `--ds-ok` `--ds-warn` `--ds-bad` `--ds-info` | success · due soon · danger · neutral news. Always pair with an icon or a label. |
| Shape | `--ds-r-sm` 7 · `--ds-r` 10 · `--ds-r-lg` 14 · `--ds-r-full` | small controls · controls and cards · large cards and menus · pills |
| Space | `--ds-s1` … `--ds-s10` | multiples of 4 |
| Type | `--ds-font-ui` `--ds-font-serif` `--ds-font-mono` | Instrument Sans + Vazirmatn · Newsreader (greeting only) · code |
| Motion | `--ds-ease` `--ds-fast` 120ms `--ds-base` 220ms `--ds-slow` 300ms | hover · menus · page change |

Type scale: Display 46/1.08 serif · Page title 40/1.15 · Heading 1 30 · Heading 2 20 · Body 14/1.5 · Editor 17/1.8 · Caption 12.5. Sentence case everywhere. No ALL CAPS labels.

## Components

All classes are prefixed `ds-` and use logical properties (`inline-start`, `inline-end`) so RTL needs no overrides.

| Need | Use |
|---|---|
| Button | `ds-btn` (+ `--primary`, `--ghost`, `--danger`, `--sm`), `ds-icon-btn`, `ds-split` for "New page ▾". One primary action per view. Label with a verb: "Save changes", not "Submit". |
| Text input | `ds-field` |
| Choose one of many | **`Dropdown`**, never a native `<select>`. 2–4 short options in a toolbar: `ds-seg` |
| On / off | `ds-switch`; in lists and tables `ds-check` |
| Tabs | `ds-tabs` |
| Tag, status, label | `ds-chip` (+ `--dot` for status). Set `--c` for the color. |
| Count next to a nav item | `ds-badge`: a plain number in an empty circle. Never a filled pill. |
| Person, page icon | `ds-avatar`, `ds-tile` |
| Progress | `ds-progress`, or the progress ring |
| Container | `ds-card` (+ `--interactive`, `--selected`) |
| Data table | `ds-table-wrap` > `ds-table` + `ds-table-foot`. Roomy rows, no vertical lines. |
| Empty state | `ds-empty`: say what is missing and what to do. |
| Body of a dialog or card with several parts (choice, field, notice) | `ds-stack`: an even gap between children. Choose one of 2–4 short options with `ds-seg` (`role="radiogroup"`), not custom cards. |
| Short list of labels and values (a summary in a dialog or card) | `ds-facts` / `Facts` |
| One thing that must be seen: a warning, a consequence, an error | `ds-notice` / `Notice` (`tone="warn"` or `"bad"`). Always has an icon and words, never color alone. |
| Floating lists | **`Menu` / `useMenu`**: dropdowns, context menus, submenus, shortcut hints. |
| Feedback | `ds-toast` (past tense, same verb as the button: "Saved"), `ds-modal`, `ds-drawer` |
| Position in a short ordered flow | `ds-steps` / `Steps`: hairline segments; the current one is longer, so it never relies on colour alone. Caller supplies the translated label ("Step 2 of 3"). |
| Persistence feedback | `SaveStatus` / `ds-save-status`: caller supplies a translated label and `idle`, `saving`, `saved` or `error`; polite live status, neutral ink and no status dot. |
| Columns | `ds-layout` (below) |

### React components

Import from `src/design-system`. Use these instead of writing the class names by hand: they set the roles, labels and direction for you.

| Component | Use |
|---|---|
| `Button`, `IconButton` | `variant="primary" \| "ghost" \| "danger"`, `size="sm"`, `icon`. `IconButton` requires `label` (its accessible name and tooltip). |
| `Row` | An icon next to user text: sidebar items, list rows, card headers. Pass the text as `text`; the row takes that text's direction, so the icon and trailing content sit on the side the text starts from. |
| `Card`, `Section` | `Card` has `interactive` and `selected`. `Section` is a titled group with an optional action. |
| `CommandDialog`, `CommandResult` | Service-free search/command surface with header/filter/footer slots, focus containment and restoration, result icon/content/trailing slots. App owns search and commands; styles in `commands.css`. |
| `WorkspaceHeader` | Service-free workspace identity: mark, name and optional action slots, with an accessible reveal button. Shared by production workspace and Settings. Styles in `navigation.css`; interactive LTR/RTL examples in Gallery. |
| `PreferenceGroup`, `PreferenceRow` | Settings sections and label/hint/control rows. Labels are already translated. No store, platform or persistence dependencies. |
| `Steps` | `count`, `current` (0-based) and a translated `label`. |
| `SegmentedChoice`, `RangeControl` | Controlled choice and numeric slider with accessible labels; the caller supplies values, options and callbacks. Imported from the same design-system entry point. |
| `Switch`, `Field`, `Chip`, `Tabs` | Switch is `role="switch"`. `Field` follows what is typed (`ltr` for codes and URLs). |
| `dirOf(text)` | `'rtl' \| 'ltr' \| undefined` by the first letter, the same rule the editor uses. Use it for `dir=` on a row or card when `Row` does not fit. |
| `Menu`, `Dropdown`, `useMenu`, `Icon` | Already here (below). |

### Menus, dropdowns and right-click

- Anything that picks from a list is a `Menu`. Status and priority cells, sort and filter, block type, language pickers, settings choices: all dropdowns.
- Every object a person can point at gets a **context menu**: page in the sidebar, block in the editor, database row or card, file, graph node, task, workspace. Keep the order: open, change, duplicate or move, copy link, then a separator and the destructive item last, in danger color.
- The `/` command menu (and `Ctrl /`) shows a small picture of what the highlighted command writes, in a frame beside the menu (`slashPreview.ts`, styled by `.slash-preview`). Every new `/` command needs a drawing there; a test fails without one. Drawings use `--ds-*` tokens only.
- Items have an icon (or a color swatch for status), a label, and a shortcut hint where one exists. Check marks show the current value.

### Column layouts

Blocks can sit side by side in 2, 3 or 4 columns (`ds-layout`). The rule is **no toolbar, nothing to learn**: it works by dragging, like snapping a window in Windows.

- **Make columns:** drag a block by its grip (it appears beside any block on hover) and drop it on the left or right edge of another block. A preview shows exactly where it will land, then it snaps beside it. Dropping on the edge of a column adds one more column (up to 4).
- **Resize:** drag the divider. It snaps to friendly ratios (1:3, 1:2, 1:1, 2:1, 3:1) and a small tip shows the split. Double-click resets to equal. Arrow keys work with focus. Minimum column width 110px.
- **Leave a column:** drag the block out. Empty columns disappear on their own, and a layout with one column left dissolves.
- **Fill an empty column** (only after `/columns` or the insert-layout button): the empty column offers the nearest blocks as chips. Pick one, or drag one in. The × removes the column.
- **Advanced options** (count, widths, text direction, unwrap, delete) live in the right-click menu of a layout or of a block inside it. Nothing is shown above the columns.
- **Keyboard:** `Alt Shift ←/→` snaps the current block to a side or moves it between columns; `Alt Shift ↑/↓` reorders. `Ctrl Z` undoes.
- **Smooth:** every move slides the affected blocks to their new place (FLIP), and every change shows an Undo toast.
- Columns stack by **container width** (560px), not viewport width. The grid is `Nfr 20px Nfr 20px Nfr`, one gutter per divider.

## Icons, backgrounds and file icons

All three live in `spike/tiptap/src/design-system/` and are shown, searchable, in the live reference (Icons, Backgrounds, File icons).

- **Icons** (`iconData.ts`, component `Icon`): 156 design-system icons in six groups (arrows, actions, files, editor, data, system) plus the ~114 page-icon glyphs already in `iconSet`, so `<Icon name="file-pdf" />` and `<Icon name="rocket" />` both work. One style only: 24px grid, 1.6 stroke, round ends, no fill, `currentColor`. Never use emoji or filled icons as UI icons. Add a new icon to a group in `iconData.ts`.
- **Backgrounds** (`backgrounds.ts`): 42 pure-CSS backgrounds in five groups (soft, vivid, dark, patterns, scenes), no image files. `backgroundCss(id)` returns the CSS; `dark` says text on top should be light. They are merged into the page cover picker (`Cover.tsx`), so every one is already selectable as a cover.
- **File icons** (`fileKinds.ts`, component `FileIcon`): 23 kinds (image, audio, video, pdf, document, spreadsheet, slides, text, code, data, archive, font, design, book, 3D model, key, app, folder, page, board, to-do list, database, plus a plain file), mapped from the extension or the MIME type. Use `<FileIcon name="report.pdf" />` or `<FileIcon kind="folder" />`. The Files view already draws folders with it. Any new place that shows a file or attachment must use `FileIcon` instead of inventing its own icon.

After changing `iconData.ts`, `backgrounds.ts` or `fileKinds.ts`, regenerate the reference page: `node scripts/design-system-data.mjs` (run from `spike/tiptap`).

## Direction and language

- Use logical properties only: `margin-inline-start`, `inset-inline-end`, `text-align: start`, `border-start-end-radius`. No `left` / `right` in new CSS except where geometry is truly physical.
- Mirror directional icons (arrows, chevrons) in RTL with `ds-flip`.
- All text goes through `t('English key')`; the Persian text lives in `src/fa.ts`. Page content is never translated.
- **The text-direction control in the page toolbar changes the direction of the page's text (the current block), never the interface.** It must not move menus, the sidebar or the toolbar. Interface direction is set only in Settings → Language. Shortcut: `Ctrl Shift ←` / `→` sets the current block RTL / LTR.
- Each paragraph picks its own direction (`dir="auto"` by default). Do not force a direction on a whole page.
- **The interface language decides the layout of a row or card; the text inside follows itself.** In an English interface a row keeps its left-to-right layout (chevron, icon, count, actions stay where they are) even when the title is Persian; only the title text is aligned by its own direction (`dir="auto"`). In a right-to-left interface the whole row or card follows its text: put the direction on the row (use `Row`, or `dir={dirOf(title)}`), not only on the title, so the icon, the gap and the trailing content sit on the text's start side. `dirOf` returns nothing in an English interface, so the same code is right in both. Menus, the toolbar and Settings always follow the interface language.
- Blocks that draw something on their start side (quote bar, callout icon, toggle arrow, heading accent) take the direction of their own text in the editor too.
- A text block is picked up only by its grip (or a block's own drag surface). Pressing on text or on the blank space around it always selects text.

## Accessibility

- Contrast 4.5:1 for text. Status is never color alone.
- Visible focus ring on every control (already in `components.css`). Never remove it.
- Icon-only buttons have `aria-label`. Menus use `role="menu"` / `menuitem`; switches `role="switch"` with `aria-checked`.
- Touch targets 32px minimum, 44px on touch-only surfaces.
- Honor `prefers-reduced-motion` and the in-app "Reduce motion" setting.

## Building a feature

1. Find each piece in the tables above and in `src/design-system`. If it exists, use it. If not, go to step 5.
2. Layout from tokens and the spacing scale. Do not invent paddings, radii or colors.
3. Every pickable list is a `Menu`; every object gets a context menu.
4. Check it in light and dark, English and Persian (RTL), with a custom accent, at a narrow width, and with the keyboard.
5. **Need something new?** Add the class to `components.css`, add it to `docs/design-system/index.html`, and add a row to the table above, in the same pull request as the feature. Do not style a one-off in the feature's own CSS.

## Guard

`npm run check:ui` (also in CI) keeps new code on this system. It fails on a `<button>` that carries `ds-btn` or `ds-icon-btn` classes instead of using `Button` / `IconButton` (a button with its own area class, such as a tab, a tree twisty or a toolbar item, is a custom control and is fine), a native `<select>`, physical CSS (`left`, `right`, `margin-left`, `text-align: left`...), literal colors outside `tokens.css` and `print.css`, and the old variables (`var(--bg)`...). The baseline in `spike/tiptap/scripts/ui-guard-baseline.json` is empty: any new violation fails, and `npm run check:ui -- --update` is only for recording a deliberate exception. For a rule that is truly one-off (geometry, always-left-to-right code) write `ui-allow <rule>: reason` on the line above, for example `/* ui-allow physical-direction: lightbox geometry */`.

## Where the styles live

`src/index.css` imports, in order: the fonts, `design-system/areas/tokens.css` (the few shared tokens that are not `--ds-*`: fonts, motion, code colors), the area stylesheets (`areas/base`, `shell`, `page`, `editor`, `overlays`, `views`, `settings`, `panels`, `page-meta`, `palette`, `bubbles`, `notices`, `content`, `explorer`, `database*`, `scrollbars`, `updates`, `layout`), then `tokens.css`, `components.css`, `areas/surfaces.css` (the flat sidebar, buttons and popovers), `home.css`, `screens.css` and `areas/print.css`. Order matters: later files win.

Every color, radius and shadow in those files is a `--ds-*` token. Settings writes `--user-accent`, `--user-radius`, `--user-radius-sm`, `--user-radius-lg` and `--font`; the design system reads them. The five hue tokens (`--ds-violet`, `--ds-blue`, `--ds-green`, `--ds-orange`, `--ds-pink`) and `--ds-white` replace the literals that used to be repeated.

Screens that still style their own controls (tabs, row actions, toolbar items) do it with an area class in `areas/`; moving one of them onto `Button` / `IconButton` / `Row` is welcome but not required. Open follow-ups: `areas/surfaces.css` and `screens.css` still override some area rules and could be folded into them.
