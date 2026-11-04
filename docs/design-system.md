# Nevis design system

The product logo is `BrandMark` with canonical geometry in `src/brand/mark.ts`; no Settings-specific logo or legacy leaf component remains. `node scripts/generate-brand.mjs` generates the web/site favicon and `src-tauri/app-icon.svg`; add `--icons` to regenerate the existing desktop icon set. `SaveStatus` is the shared, passive save indicator: neutral check and text when saved, a save glyph while saving, and a labelled error state. It has no coloured dot, pill, or pulsing animation. Editor status appears only on an actual open page; Home's note sheet owns its own save feedback.

In the icons-only workspace sidebar, hovering/focusing the logo previews navigation; activating it pins the expanded sidebar. The logo exposes both expanded and pressed states. A second activation or a click outside releases the pin. Sidebar rows remain interactive while pinned; portaled menus and dialogs finish their own interaction before outside-dismissal applies. Returning from Settings clears temporary reveal/pin state.

Settings navigation uses one row geometry for categories and Back to workspace: full-width hit areas inside equal sidebar insets, fixed icon spacing, and labels that can wrap with custom fonts. On short windows only the category list scrolls; the return action stays outside it. At narrow widths categories form a horizontal strip and the return action remains visible below it. Hover, pressed, selected and keyboard focus states use the shared tokens. Production browser checks cover EN/FA, light/dark, monospace, short/narrow windows, keyboard return and default/compact/icons workspace sidebars.

Home starts with an editable first-note sheet and short template previews, plus the existing import/settings entry. The sheet creates a real page on the first meaningful edit, saves through the document service, and stays mounted while writing. Returning users see their last note, a collapsible quick-note sheet and recent pages. The quick draft is excluded from the continuation preview while it is being written. `HomeNote` composes the existing TipTap starter, block-identity and per-block direction extensions; existing rich documents open in PageView. Save feedback waits for durable persistence and failures keep the text available for retry.

First launch and the workspace list are `Onboarding` (`src/onboarding/`), a service-free composition that `VaultPicker` connects to the desktop vault commands. New users go through three steps (welcome and language, name and accent with a live `WorkspaceHeader` preview, folder) and the preview grows into the workspace; people with workspaces see the list, with a context menu on each row, and a two-step flow for a new one. Steps slide in from the side they come from (mirrored in RTL) with `--ds-base`; reduced motion turns this into a crossfade and skips the mark drawing and the landing. The interface says workspace, not vault. `AccentSwatches` is the accent choice shared with Settings. Review at `/onboarding-preview.html` (`?state=returning`, `?fail`, `?lang=fa`, `?theme=dark`, `?accent=%237151c2`, `?reduced`); nothing native is touched. Not yet tested.

The page (`PageView`) is built from shared parts and its own `pg-` classes in `areas/page.css`: the icon (with a cover, a 76px tile sitting on the cover's lower edge that lifts with an accent edge on hover; without one, a 40px glyph at the start of the title line, whose direction follows the title; right-click to change or remove), ghost `Button`s for Add icon / Add cover that show on hover or focus, the title, and the properties as rows in the Settings style (label column with an icon, value column, hairlines between): Status (a chip that opens a `Menu` with swatches), Tags (every tag visible as a readable tinted `pg-tag`; the name shows the pages with that tag in the sidebar, the cross appears on hover or focus, right-click has both), and Last edited. Favourite is a page action, not a property: an outline star in the page bar beside Share that takes the accent when on. Below 560px the label sits above the value. The cover is drawn inside the page column, as wide as the text, with `Button`s on hover and a right-click menu. The formatting bar (`Toolbar`, styles in `areas/toolbar.css`) is one raised strip of `ds-icon-btn`s in groups; pressed means the format is on at the caret, every tooltip shows its shortcut from Settings → Shortcuts, image, direction, alignment and More are design-system menus, and on a narrow page the less-used commands fold into More so it stays on one line. It keeps its place but only shows while the text has focus, the pointer is on it or one of its menus is open. Editor shortcuts match the physical key (event.code), so they work with any keyboard language. The quick-start templates are one line of ghost buttons that scrolls instead of wrapping. Right-click in the text opens a `Menu` (edit, Format submenu, page actions). Backlinks are `Row`s under a heading with a `ds-badge` count.

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
| Options | `--ds-opt-default` `--ds-opt-gray` … `--ds-opt-red` | the ten colours a database option (select, status, multi-select) can take; set as `--c` on a `ds-chip` |
| Chart | `--ds-chart-1` … `--ds-chart-8` | chart series in this fixed order, never cycled (a ninth series shares the muted ink). Validated for colour-blind separation on `--ds-raised` in both modes; slots 3–5 are under 3:1 on white, so a chart always shows labels or a legend. A select or status axis uses its options’ `--ds-opt-*` colours instead, so an option looks the same in a chart as in the table. |
| Shape | `--ds-r-sm` 7 · `--ds-r` 10 · `--ds-r-lg` 14 · `--ds-r-full` | small controls · controls and cards · large cards and menus · pills |
| Space | `--ds-s1` … `--ds-s10` | multiples of 4 |
| Type | `--ds-font-ui` `--ds-font-serif` `--ds-font-mono` | Instrument Sans + Vazirmatn · Newsreader (greeting only) · code |
| Motion | `--ds-ease` `--ds-fast` 120ms `--ds-base` 220ms `--ds-slow` 300ms `--ds-spring` | hover · menus · page change · a small overshoot for a check or an icon that pops in |

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
| A chip that is a control (status picker, add action) | `ds-chip-btn`; `data-empty` draws it dashed when nothing is set; `aria-pressed="true"` is an active filter |
| A tag on an object | `ds-tag` with `--hue` (from `tagHue`): `ds-tag-name` opens it, `ds-tag-x` appears on hover or focus. Typing a new one: `ds-chip-field` (+ `ds-chip-field-list` for suggestions) |
| Properties of an object | `ds-props` > `ds-prop` (`ds-prop-label` with an icon, `ds-prop-value`), hairlines between rows; one column below 560px |
| Choose a cover or a colour | `ds-swatches` > `ds-swatch` (pressed = chosen). A colour of your own: `ds-color` |
| Choose an icon and its colour | `IconPicker` (`ds-icon-picker`): search, a row of `ds-color-dot`s (automatic, ten colours, your own), the design-system icons by group with Subjects and objects first |
| The actions an object offers | `ActionGrid` > `ActionTile` (`ds-actions` > `ds-action`): tiles with the icon beside the label, as many a row as fit; a long label wraps and is never cut |
| A toggle shown only by its icon (favourite) | `ds-icon-btn ds-icon-btn--toggle`: on is the icon in the accent, never a filled square |
| Count next to a nav item | `ds-badge`: a plain number in an empty circle. Never a filled pill. |
| Person, page icon | `ds-avatar`, `ds-tile` |
| Progress | `ds-progress`, or the progress ring |
| Container | `ds-card` (+ `--interactive`, `--selected`) |
| Data table | `ds-table-wrap` > `ds-table` + `ds-table-foot`. Roomy rows, no vertical lines. |
| Empty state | `ds-empty`: say what is missing and what to do. Where a list would be: `ds-empty ds-empty--framed` (a dashed frame the list will fill). |
| A full-page tool (Tasks, Flashcards, Templates, Pages table, Trash) | `Screen` (`ds-screen`): title, one line, actions at the end; `width="wide"` for tables and two panes; `fill` for a screen as tall as the window that never scrolls the page |
| A list of rows on such a page | `ds-list ds-list--framed` > `ds-list-row`: one frame whose corners follow the radius setting, hairlines between rows |
| A checkbox in a list or table | `Checkbox` (`ds-checkbox` > input + `ds-check`): a real input; the whole line is its label |
| Search or filter a list | `SearchField` (`ds-search`): icon, input, clear button; Escape clears |
| A few numbers on a screen | `Stats` (`ds-stats`): one line, each a number and its words ("3 due now"); an item never breaks, no icons, no tiles |
| A key the person can press | `ds-kbd`, inside a button or a hint |
| Body of a dialog or card with several parts (choice, field, notice) | `ds-stack`: an even gap between children. Choose one of 2–4 short options with `ds-seg` (`role="radiogroup"`), not custom cards. |
| Short list of labels and values (a summary in a dialog or card) | `ds-facts` / `Facts` |
| System notice | `Notice` supports `info`, `ok`, `warn` and `bad`. Each tone supplies an icon. Use `title` for a short summary, `action` for a next step, and `trailing` for a dismiss control. |
| Floating lists | **`Menu` / `useMenu`**: dropdowns, context menus, submenus, shortcut hints. |
| A small form or a list of rules in a popover (filter, sort, property settings, a cell editor) | `Panel` (`ds-panel`: `ds-panel-head` with Back, title and actions, `ds-panel-body`, `ds-panel-foot`; `data-size` sm 280 · md 360 · lg 520) inside `Popover`. A `Dropdown` or `Menu` opened from inside a panel is a popover of its own: using it keeps the panel open, and Escape closes only the one on top. |
| A labelled control in a form | `FormField` (`ds-form-field`: `ds-form-label`, the control, `ds-form-hint`) |
| A switch with its label | `SwitchRow` (`ds-switch-row`): the whole line toggles |
| Feedback | `ds-toast` (past tense, same verb as the button: "Saved"), `ds-modal`, `ds-drawer` |
| Position in a short ordered flow | `ds-steps` / `Steps`: hairline segments; the current one is longer, so it never relies on colour alone. Caller supplies the translated label ("Step 2 of 3"). |
| Persistence feedback | `SaveStatus` / `ds-save-status`: caller supplies a translated label and `idle`, `saving`, `saved` or `error`; polite live status, neutral ink and no status dot. |
| Columns | `ds-layout` (below) |
| Dragging a block | `ds-grip` beside the block, `ds-drag-ghost` under the pointer (`ds-drag-ghost-title` = what moves, `ds-drag-ghost-action` = what releasing does; `data-state` `ready`, `idle` or `blocked`), `ds-drag-source` dims what is moving, `ds-snap-preview` shows where it lands (`data-line` between blocks, `data-cols` with `ds-snap-col` children and the new one `data-active`). |

### React components

Import from `src/design-system`. Use these instead of writing the class names by hand: they set the roles, labels and direction for you.

| Component | Use |
|---|---|
| `Button`, `IconButton` | `variant="primary" \| "ghost" \| "danger"`, `size="sm"`, `icon`. `IconButton` requires `label` (its accessible name and tooltip). |
| `Toolbar`, `ToolbarGroup`, `ToolbarSep`, `ToolbarButton` | One row of tools (table, image, zoom viewer). Groups are named for screen readers and each button's `label` is its tooltip; no visible group captions. `text` for short text buttons (50%, RTL), `danger` for destructive ones. Toolbars built in the DOM use the classes `ds-toolbar`, `ds-toolbar-btn`, `ds-toolbar-sep`. |
| `Radio` | One choice of a group: `name`, `checked`, `onChange`; children are the label. |
| Command list (`ds-menu--command`) | The `/` menu and the title-direction menu: `ds-menu-head`, `ds-menu-list`, `ds-menu-item` (+ `hot` for the highlighted row), `ds-menu-foot`. Built in the DOM by `editor/menu.ts` with these classes. |
| `Row` | An icon next to user text: sidebar items, list rows, card headers. Pass the text as `text`; the row takes that text's direction, so the icon and trailing content sit on the side the text starts from. |
| `Card`, `Section` | `Card` has `interactive` and `selected`. `Section` is a titled group with an optional action. |
| `CommandDialog`, `CommandResult` | Service-free search/command surface with header/filter/footer slots, focus containment and restoration, result icon/content/trailing slots. App owns search and commands; styles in `commands.css`. |
| `WorkspaceHeader` | Service-free workspace identity: mark, name and optional action slots, with an accessible reveal button. Shared by production workspace and Settings. Styles in `navigation.css`; interactive LTR/RTL examples in Gallery. |
| `PreferenceGroup`, `PreferenceRow` | Settings sections and label/hint/control rows. Labels are already translated. No store, platform or persistence dependencies. |
| `Steps` | `count`, `current` (0-based) and a translated `label`. |
| `ChipButton`, `Tag`, `tagHue` | `ChipButton` takes `empty` and `icon`. `Tag` takes the label, `onOpen` / `onRemove` with translated `openLabel` / `removeLabel`, and `onContextMenu`; the same name always gets the same hue. |
| `IconPicker` | `name`, `color`, `onPick(name, color, close)`, `onClear`. A colour change on the chosen icon applies without closing. Page icons are stored as `i:name` or `i:name@#rrggbb`; `Glyph` draws the design-system icon first. |
| `PropertyList`, `PropertyRow` | A translated `label` for the group; each row an optional `icon`, a `label` and the value as children. |
| `SegmentedChoice`, `RangeControl` | Controlled choice and numeric slider with accessible labels; the caller supplies values, options and callbacks. Imported from the same design-system entry point. |
| `Switch`, `Field`, `Chip`, `Tabs` | Switch is `role="switch"`. `Field` follows what is typed (`ltr` for codes and URLs). |
| `Screen` | `title`, `description`, `actions`, `width` (`narrow` 760 / `wide` 1120), `fill`. The content is the children. |
| `Checkbox` | `checked`, `onChange(next)`, the visible label as children or `label` for the accessible name only, `disabled`. |
| `SearchField` | `value`, `onChange`, translated `label`, `placeholder` and `clearLabel`, `autoFocus`; `onEnter` goes to the first result. Escape clears. |
| `showToast(msg, undo?, action?)` (in `ui.tsx`) | A screen reports a change through the app's one toast. With `undo` the toast offers Undo and Ctrl+Z (Cmd+Z) runs it, unless the focus is in text that has its own undo. `action` (`{ label, run }`) is any other one-click follow-up, such as "Show it" for an item saved outside the current view. |
| `Stats` | `items` of `{ label, value }` with the label read after the number, and a translated `label` for the group. |
| `dirOf(text)` | `'rtl' \| 'ltr' \| undefined` by the first letter, the same rule the editor uses. Use it for `dir=` on a row or card when `Row` does not fit. |
| `Menu`, `Dropdown`, `useMenu`, `Icon` | Already here (below). `Dropdown` options take `raw` for user text (a property or view name is never translated), `swatch` for an option colour, and the button takes `placeholder`, `disabled` and `className` (`ds-dd-btn--sm` for a 28px one in a row of rules). |
| `Panel`, `FormField`, `Segmented`, `SwitchRow` | `Panel` takes `title`, `onBack`, `actions`, `footer`, `size`. `Segmented` is `ds-seg` as a radio group (`value`, `options`, `onChange`, translated `label`). `SwitchRow` takes `label`, `hint`, `checked`, `onChange`. |
| `Dialog` | Also takes `wide` (760px) for a table or a mapping, such as the CSV import. Put the content in `ds-modal-body`, which scrolls. |

### Menus, dropdowns and right-click

- Anything that picks from a list is a `Menu`. Status and priority cells, sort and filter, block type, language pickers, settings choices: all dropdowns.
- Every object a person can point at gets a **context menu**: page in the sidebar, block in the editor, database row or card, file, graph node, task, workspace. Keep the order: open, change, duplicate or move, copy link, then a separator and the destructive item last, in danger color.
- The `/` command menu (and `Ctrl /`) shows a small picture of what the highlighted command writes, in a frame beside the menu (`slashPreview.ts`, styled by `.slash-preview`). Every new `/` command needs a drawing there; a test fails without one. Drawings use `--ds-*` tokens only.
- Items have an icon (or a color swatch for status), a label, and a shortcut hint where one exists. Check marks show the current value.

### Column layouts

Blocks can sit side by side in 2 or 3 columns in the editor (`ds-layout`). The rule is **no toolbar, nothing to learn**: it works by dragging, like snapping a window in Windows.

- **One drag, three outcomes, no pop-ups.** While dragging, the page itself is the chooser: nothing opens under the pointer. The ghost says in words what releasing will do, and the preview shows where.
  - **Up or down** (including straight down the margin, where the grip is): an accent line between blocks; the block is reordered.
  - **Sideways onto the left or right part of another block** (about a fifth of its width, 48–150px): the preview draws the columns the drop will make, the new one in the accent ("Place side by side"). Columns form only after the pointer has moved at least 32px sideways, so a straight drag never makes columns by accident. A one- or two-line block still gets side targets at least 44px tall and a preview at least 56px tall, centred on it; where the targets of short neighbours overlap, the nearest one wins.
  - **Onto the edge or gap of a layout**: one more column ("Add as a new column"), up to 3. Dragging a column's last block over a sibling column moves the whole column.
  - Over the block's own place, or anywhere that changes nothing, the ghost says "Release to leave it where it was". A drop that is not allowed (a fourth column, too narrow) says why, in the danger colour, and does nothing. `Escape` cancels at any time.
- **Click the grip** for the same moves as a menu (Move to…, up, down, left, right, take out of the layout); only moves that are possible from here are listed.
- **Resize:** drag the divider. It snaps to friendly ratios (1:3, 1:2, 1:1, 2:1, 3:1) and a small tip shows the split. Double-click resets to equal. Arrow keys work with focus. Minimum column width 180px in the editor.
- **Leave a column:** drag the block up or down out of the layout, or into the margin beside it (upper half: above the layout, lower half: below). The preview shows the block at full width and the columns left behind. Empty columns disappear on their own, and a layout with one column left dissolves.
- **Fill an empty column** (only after `/columns` or the insert-layout button): the empty column offers the nearest blocks as chips. Pick one, or drag one in. The × removes the column.
- **Advanced options** (count, widths, text direction, unwrap, delete) live in the right-click menu of a layout or of a block inside it. Nothing is shown above the columns.
- **Keyboard:** `Ctrl Alt ←/→` snaps the current block to a side or moves it between columns; `Ctrl Alt ↑/↓` reorders; `Ctrl Alt M` opens the move menu, whose Move to… lets you browse every destination with Tab or the arrow keys. `Ctrl Z` undoes.
- **Smooth:** every move slides the affected blocks to their new place (FLIP), and every change shows an Undo toast.
- Columns stack by **container width** (560px), not viewport width. The grid is `Nfr 20px Nfr 20px Nfr`, one gutter per divider (24px in the editor).

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
- **A title that fills the free space of a row** (a list row, a calendar event, a timeline name or bar) puts `dir="auto"` on an inner span around the text, never on the growing box itself: the box aligns to the row’s start, the span takes the text’s own direction. With `dir="auto"` on the box, a Persian title in an English row is pushed to the far end, away from its icon.
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

`src/index.css` imports, in order: the fonts, `design-system/areas/tokens.css` (the few shared values that are not `--ds-*`: the interface font `--font`, a background chosen in Settings, code colours; the old aliases such as `--mono`, `--ease`, `--spring`, `--panel-shadow` and the aurora `--mesh-*` gradients are gone), the area stylesheets (`areas/base`, `shell`, `page`, `editor`, `overlays`, `views`, `settings`, `panels`, `page-meta`, `palette`, `bubbles`, `notices`, `content`, `explorer`, `databases`, `scrollbars`, `updates`, `layout`), then `tokens.css`, `components.css`, `areas/surfaces.css` (the flat sidebar, buttons and popovers), `home.css`, `screens.css` and `areas/print.css`. Order matters: later files win.

Every color, radius and shadow in those files is a `--ds-*` token. Settings writes `--user-accent`, `--user-radius`, `--user-radius-sm`, `--user-radius-lg` and `--font`; the design system reads them. The five hue tokens (`--ds-violet`, `--ds-blue`, `--ds-green`, `--ds-orange`, `--ds-pink`) and `--ds-white` replace the literals that used to be repeated.

Screens that still style their own controls (tabs, row actions, toolbar items) do it with an area class in `areas/`; moving one of them onto `Button` / `IconButton` / `Row` is welcome but not required. `surfaces.css` and `screens.css` no longer exist: every rule lives in its area file.

## Foundations updated 2026-11

- **Scope:** these changes cover what the UI migration touched: Settings, shell and sidebar, Home, page frame, onboarding, search, shared controls, and every screen below, the database included.
- **Spacing:** padding, margin and gap in interface CSS sit on the 4px scale and use `--ds-s1…s10`. Document content (`editor.css`, `content.css`, `print.css`) is excluded so the reader's own settings keep working. Controls use `--ds-control` (36px) or `--ds-control-sm` (28px); icon buttons are 32px.
- **One icon button:** every icon-only button is `IconButton` (`ds-icon-btn`); the old `.icon-btn` alias is gone.
- **Independence:** `Popover` lives in `design-system/Popover.tsx`. The design system takes its text from `design-system/text.ts`; the app registers its translator once in `i18n.ts`. `npm run check:ui` fails if a design-system file imports app code (`iconSet` and `textDirection` are pure data helpers).
- **Motion:** `design-system/motion.ts` holds the durations, easing and spring (`MOTION`, `useUIMotion`), which honour system and app Reduce motion. `Dialog` fades and rises in and out and keeps Tab inside; `Popover` plays a short exit when closed by Escape or an outside click; `Tabs` glide the underline; the sidebar tree opens and closes its children; Settings panels ease in on a category change; Home tasks leave and re-flow when ticked off. Hover and press states stay in CSS.
- **Shortcuts:** Settings lists which shortcuts can be changed (app bindings and editor commands) and marks the rest *Built in*; a fixed shortcut shows no Change button.
- **Share, Trash, Files:** the Share button opens the shared Menu (Export: Markdown, PDF; Copy: as Markdown, file path; Show in Explorer or Finder; Export the whole workspace). Trash is a full page (not a popup) on `Screen`, a framed `ds-list` and the shared `ds-empty` state. Files uses `Button`, `IconButton`, the `ds-seg` view switch and the shared Menu for its context menu; its rows, selection and counts follow the same tokens.
- **Updates:** a pre-release build always follows the pre-release channel (`wantsPrerelease`); the stable channel would only offer an older version.
- **Icons:** one glyph set. The legacy `Ic.*` components that have a design-system twin (44 of them) now draw the design-system icon, so stroke and shape match everywhere; callers keep their size.
- **Motion helpers:** `prefersReducedMotion()` is the one check for event handlers; `useUIMotion()` returns shared constants for components.
- **Corner radius everywhere:** small buttons, segmented buttons, menu items, checkboxes and tiles read `--ds-r-sm`, `--ds-r` and `--ds-r-lg` instead of fixed pixels, so Settings → Corner radius reaches every control (Files, Trash and the rest). Trash is a framed list on `Screen`.
- **Templates** (`TemplateGallery.tsx`, `areas/templates.css`): the choices on one side (Start empty: page, database, drawing; then the ready-made pages), a preview of the page the chosen one creates on the other, read from the template's own HTML so it always matches. Arrow keys move, Enter or a double click creates, Escape leaves. A `fill` screen: the page never scrolls; below 760px of height each choice is one line. In the sidebar Templates sits right under Home.
- **Tasks** (`Tasks.tsx`, `areas/tasks.css`): sources on one side (All tasks, Inbox, your to-do lists, the pages that have checklists) with open counts; the chosen source's open tasks on the other, its completed ones folded under Completed. A ticked task stays in place for a moment, then moves. The composer adds to the inbox (All tasks and Inbox); in All tasks every row names its list and that name opens it.
- **Flashcards** (`Flashcards.tsx`, `areas/flashcards.css`): the overview starts with today's session, a stack of cards with the next question on top, how long it takes and Start review (Enter); then the decks, then the last 14 days as one row of cells. Reviewing is one card at a time: Space shows the answer, 1 to 4 answer it, each answer named in words with its colour beside it and the next interval.
- **All pages** (the pages table, `PagesTable.tsx`, `areas/pages-table.css`): `SearchField`, the status `Dropdown`, tag filters as pressed `ChipButton`s (the ten most used, the rest under "N more") and Clear filters; sortable column headings are buttons with `aria-sort`; the status is the same `PageStatusChip` as on the page. Columns have fixed widths so the table always fits its frame: a title and a path end in an ellipsis (a deep path shows its last two folders, the whole path on hover), a page shows two tags and "+N" opens the rest, and picking a tag anywhere filters by it. Path, word count and tags give way, in that order, on narrow screens.
- **Sidebar names:** short nouns, plural for collections, no "view" or "table": Home, Templates, Tasks, Flashcards, Databases, Drawings, Graph, All pages, Files, Trash, Settings. Screen titles, the top bar and the command palette use the same words.
- **Drawings** (`Drawings.tsx`, `areas/drawings.css`): the drawing edited last on its own large board with Continue drawing, then the rest grouped Today, This week, Earlier, each card the board on a dotted whiteboard with its name. Search and All / Boards / In pages in one row; right-click or ⋯ for Open and Delete (with Undo).
- **The drawing canvas** (`DrawingCanvas.tsx`, `.ds-canvas`): Excalidraw takes Nevis's tokens (accent, surfaces, lines, corners, type) through its own CSS variables, so its panels and menus look like the rest of the app. Its tool bar is ours: `IconButton`s with the design-system icons (the Drawing tools group: pointer, hand, square, rhombus, circle, arrow-tool, line, eraser) and the key of each tool, driving the library through its API; the library's own bar is hidden. A board page has a back button to Drawings. Its shortcuts follow the physical key like every Nevis shortcut: a key that types a non-Latin character (a Persian ۱ or ق) is handed on as the Latin key in the same place, so 1 to 0, the letter tools and Ctrl+Z work with any keyboard language. Typing text in a drawing is left alone.
- **Graph** (`GraphView.tsx`, `areas/graph.css`): the map fills the screen. Finding on one side: search (the matches listed, Enter goes to the first), Whole workspace or Around a page with 1, 2 or 3 links away, tags that light their pages, and the database link kinds. On the other side the picked page with its links both ways (Links to, Linked from), Open page and Explore from here (the map redraws around it); with nothing picked, the most connected pages. Choosing a page anywhere glides the map to it. Escape lets go of the picked page, F fits, + and − zoom. The map is drawn in the Nevis manner: pages are solid ink dots sized by their links (hubs a shade darker), links are straight hairlines, and the one accent marks what you are looking at: the open page, the picked one with a thin target ring, its links with an arrowhead where they arrive, and whatever search or a tag lights. A ring of the stage colour around every dot and label cuts the links that pass under it. No per-page colours, no glow, no dot grid behind the map. The canvas, the layout worker and the drawing limits are unchanged; the hovered page's neighbours come from the adjacency index, not a scan of every link. No blur behind the panels: the canvas repaints every frame.
- **Databases** (`Databases.tsx`, `database/ui/DatabasePreview.tsx`, `areas/databases.css` with the `dbs-` prefix): the list of databases on one side (search, arrow keys, Enter or a double click opens, right-click or ⋯ for Open and Delete with Undo), the chosen one on the other: its views, its properties and the items edited last, with Open database.
- **A database** (`database/ui/`, `areas/databases.css` with the `dv-` prefix): the page title and one line ("12 items"), then the views as tabs (click the open one, or right-click any, for Rename, Duplicate, Copy link, Delete) and one toolbar: search, Filter, Sort and Group as chips that show what is on ("Filter · 2"), Properties, More (View settings, Buttons and automations, Data source, Import CSV, Export, Backup, Duplicate) and the New split button with templates. Under the toolbar one quiet line says which filters and sorts apply ("Priority is High · Status, ascending"); an unsaved change says "Only you see these changes" with Save for everyone and Reset. Add a view lists every layout with one line on what it is for.
- **Panels:** filter (rules read as sentences: Where · and · or, groups to three levels), sort, group, properties (eye and order), view settings (layout tiles, then that layout's settings), the column menu (name, then its actions, its settings one step in), new property (types grouped Basic, Links and contact, Calculated, Set by the app), every cell editor and the automations editor (numbered steps) are all `Panel`s with `FormField`, `Segmented`, `SwitchRow` and `Dropdown`. Change type and the CSV import are `Dialog`s.
- **Views:** the table keeps every keyboard and clipboard behaviour, now matched by physical key (Ctrl+Z, Ctrl+A, Ctrl+D work with a Persian keyboard); a row's ⋮ handle drags it and opens its menu, and right-click anywhere on a row opens the same menu (Open, side peek, center peek, Duplicate, Delete with Undo). Board columns, list rows and gallery cards have the same context menu. Calendar and timeline share one period header (previous, next, Today, Month/Week or Day/Week/Month/Quarter) and an undated tray. The chart has its settings beside it and a read-only list of the items under a clicked bar. The form builder shows its questions beside a live preview of the form; Fill in is the form itself. The dashboard filters every widget from one line and a narrow widget keeps a list to its title and two values.
- **Item page:** the database properties sit in the same rows as the page's own properties (`ds-props`), with comments per property, Customize layout, sections and "N more properties". The side and center peek slide in (honouring Reduce motion) and show the shared save status.
- **Full-page table:** the page stays put and the table scrolls inside its frame: title, view tabs and toolbar keep their place, the header row and the frozen columns stick, and both scrollbars belong to the table (the custom horizontal rail is only for content that scrolls with the page). Rows are windowed against whichever of the two scrolls. Embedded databases, peeks and dashboard widgets grow with their rows as before.
- **Charts** (`query/chart.ts`, `ChartView.tsx`): drawn at the size they are shown, so their text is always the UI size, and exported at 760×380. Colours, ink, lines and font come from the tokens, resolved to plain colours so the SVG and PNG match the screen, and redrawn when the theme changes. Bars have a 4px rounded data end and a 2px gap within a group; the grid is hairlines with the values beside them; a donut and any chart with series has a legend. In a widget the chart is the card’s content: no inner frame, hint or export row outside Edit dashboard.
- **Clickable rows and cards that hold links or chips** (`dv-stretch`): one `dv-stretch-hit` button lies under the content instead of a button around it, so a relation chip, a link or a mention inside stays a control of its own and the HTML stays valid. Used by the item page’s property cells, list rows, board and gallery cards and the chart’s item list.
- **Cards:** short values (status, priority, tags, a date) share a line and wrap like words; a long one takes the line.
- **Timeline** opens on today, a third of the way in, once per view and scale; a bar too short for its name shows the name just past its end. **Map** opens on its pins. A **form** date answer uses the database’s `DatePicker` (Jalali and Persian digits when the property is set so), one day only.
- **Settings → Database** uses `PreferenceGroup`, `PreferenceRow`, `FormField` and `Facts` like the rest of Settings. The Graph's database link toggles are `ChipButton`s like its tag filters.
- **Removed:** `areas/database.css`, `database-grid.css`, `database-layout.css`, the database rules in `screens.css`, `views.css` and `editor.css`, `database/ui/forms.tsx`, `Select` in `ui.tsx` (every pick is a `Dropdown`), the old `dbc-*` colour classes (now `--ds-opt-*`) and the Persian strings nothing used. The shared horizontal scroller (`hscroll-*`) moved to `scrollbars.css`, the compact page list to `shell.css`.
- **Cleanup on dev (2026-11):** the hidden decorative layers (dot grid behind the app, sheen on the New page button, accent wash at the top of the page) and the unused `.new-page` rules are deleted; a quote is an accent bar and a divider a hairline, with no gradients. `editor.css` and `content.css` no longer style the same document elements twice: the 31 rules both had are one rule in `content.css`, with the same result. Controls inside the document (task checkbox, toggle, inline math, page links, language and math pickers, lightbox) take their corners from `--ds-r-*`. `--ds-font-mono` falls back to Cascadia Mono and Consolas, so code looks the same while JetBrains Mono is not loaded. The sidebar counts are `ds-badge`. `MenuItem`, `MenuLabel` and `MenuSep` in `ui.tsx` had no callers and are removed. The remaining `!important` rules override inline styles the editor sets from JavaScript, or are print-only.
