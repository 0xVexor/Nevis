# Nevis design system

Every new screen, feature and component is built from this system. It replaces the layered "Aurora Paper" styles (`v2`–`v5`) over time; until a screen is migrated, its legacy styles stay as they are.

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
| Motion | `--ds-ease` `--ds-fast` 150ms `--ds-base` 200ms `--ds-slow` 350ms | hover · menus · page change |

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
| Floating lists | **`Menu` / `useMenu`**: dropdowns, context menus, submenus, shortcut hints. |
| Feedback | `ds-toast` (past tense, same verb as the button: "Saved"), `ds-modal`, `ds-drawer` |
| Columns | `ds-layout` (below) |

### Menus, dropdowns and right-click

- Anything that picks from a list is a `Menu`. Status and priority cells, sort and filter, block type, language pickers, settings choices: all dropdowns.
- Every object a person can point at gets a **context menu**: page in the sidebar, block in the editor, database row or card, file, graph node, task, workspace. Keep the order: open, change, duplicate or move, copy link, then a separator and the destructive item last, in danger color.
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

## Accessibility

- Contrast 4.5:1 for text. Status is never color alone.
- Visible focus ring on every control (already in `components.css`). Never remove it.
- Icon-only buttons have `aria-label`. Menus use `role="menu"` / `menuitem`; switches `role="switch"` with `aria-checked`.
- Touch targets 32px minimum, 44px on touch-only surfaces.
- Honor `prefers-reduced-motion` and the in-app "Reduce motion" setting.

## Building a feature

1. Find each piece in the table above. If it exists, use it. If not, go to step 5.
2. Layout from tokens and the spacing scale. Do not invent paddings, radii or colors.
3. Every pickable list is a `Menu`; every object gets a context menu.
4. Check it in light and dark, English and Persian (RTL), with a custom accent, at a narrow width, and with the keyboard.
5. **Need something new?** Add the class to `components.css`, add it to `docs/design-system/index.html`, and add a row to the table above, in the same pull request as the feature. Do not style a one-off in the feature's own CSS.

## Migration from the legacy styles

**Done:** step 1, the skin. `design-system/skin.css` gives the legacy tokens the new values and flattens the Aurora Paper layers (aurora canvas, floating glass panels, gradient buttons, glow), so every screen already has the Calm palette, a flat sidebar, plain-number badges and the soft dark theme. **Home** is fully migrated (`Home.tsx`, `design-system/home.css`).

**Next, one pull request each:** page and editor chrome → tables and database views → Files → Settings → overlays. When the last screen is migrated, delete `skin.css` and the legacy `v2`–`v5` styles.

Until then the legacy tokens keep working. Mapping:

| Legacy | New |
|---|---|
| `--bg` | `--ds-bg` |
| `--side-bg` | `--ds-side` |
| `--bg-raised` | `--ds-raised` |
| `--bg-sunk` | `--ds-sunk` |
| `--text` · `--muted` · `--faint` | `--ds-text` · `--ds-text-2` · `--ds-text-3` |
| `--border` · `--border-strong` | `--ds-line` · `--ds-line-strong` |
| `--hover` · `--active` | `--ds-hover` · `--ds-press` |
| `--accent` · `--accent-bg` | `--ds-accent` · `--ds-accent-soft` |
| `--danger` · `--ok` · `--warn` | `--ds-bad` · `--ds-ok` · `--ds-warn` |
| `--radius-sm` · `--radius` · `--radius-lg` | `--ds-r-sm` · `--ds-r` · `--ds-r-lg` |
| `--pop` + `--shadow` | `ds-pop` |

Settings already writes `--user-accent` (see `settings.ts`); the design system reads it. Open follow-ups: add the `@fontsource/instrument-sans` and `@fontsource/newsreader` packages (until then the stack falls back to Vazirmatn), and make the stock accent teal (`#0f8f83`) instead of purple.
