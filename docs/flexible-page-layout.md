# Flexible page layout

> بازبینی جاریِ موتور اسنپ: [گزارش ۲۰۲۶-۱۰-۲۹](editor-release-review-2026-10-29.fa.md). نتایج تست و اسکرین‌شات‌های پایین، تاریخی و مربوط به موتور قبلی‌اند؛ تأیید بازنویسی فعلی نیستند.

Implementation branch: `feature/flexible-page-layout`, based on `origin/dev`.
Reference: “Noviq — Flexible Page Layout System” in the user's local notes.

**Scope update, 2026-10-27:** The user assigned synchronization to a separate contributor. This work
covers the page layout, editor interactions, existing content blocks, local document persistence,
accessibility and export. Sync behavior, two-device conflicts and mixed-version rollout are tracked
by that separate workstream; they are not used as a reason to leave editor work unfinished.

## Work sequence

1. Add structural `layoutGroup` / `layoutColumn` nodes to the existing editor.
2. Add atomic insert, column count, unwrap, widths, direction, move and delete commands.
3. Add focused layout controls and destination menus using existing UI primitives and tokens.
4. Extend block dragging to columns, group movement, cancellation and precise drop targets.
5. Add local resize previews, narrow-width stacking and RTL presentation.
6. Protect column boundaries, clipboard operations, incompatible content and external replacements.
7. Preserve existing storage, history, search, backlinks, attachment identities and exports.
8. At the end, run one validation round: focused structural tests, TypeScript/build and lint.

No tests are run during implementation, at the user's request.

## Compatibility and verification

Columns are part of the page's single ProseMirror document and history. There is no migration of old pages.
Unknown or malformed structural content must not enter an editable editor or be silently saved after parsing.
Invalid width values are displayed with temporary equal widths, without changing their stored values.

Already released clients cannot acquire a schema/save guard from a change in this branch. Mixed-version
rollout requires upgraded clients or a separately deployed version gate. The user assigned this
compatibility/synchronization work to a separate contributor.
The 48 reference scenarios, especially native IME, two-device sync, old clients and crash recovery, must
retain their actual execution status; a successful build or structural test is not evidence they passed.

## Implementation

- Structural nodes and commands are in `src/editor/layout.ts` and `layoutModel.ts`.
- Insert Layout is available in the toolbar and slash/command menus. Nested insertion is disabled.
- Focused settings and explicit start/end column destinations reuse `Popover`, `MenuItem` and existing buttons.
- Group count, width presets, live resize preview, direction, flattening, deletion and block movement use the same document/history.
- Drag grips handle root blocks, column blocks and groups. Internal moves use local pointer capture and document identity checks, a root/column drop indicator, autoscroll, and cancellation on Escape, blur, document replacement or editor destruction.
- Layout styles are scoped in `styles/layout.css`; existing theme tokens, typography and menu primitives are reused.
- Before parsing persisted JSON, unknown nodes/marks and malformed layouts are protected. Original data is available in a read-only panel. Invalid widths use a temporary equal-width display.
- Unedited pages no longer flush a normalized editor document merely because they were opened/closed. External changes cancel transient interactions, preserve pending local text in history, and clear stale editor history/positions.
- Existing recursive Markdown serialization, text indexing and backlinks traverse column children. Image resize uses the enclosing column width.

## Final validation (2026-10-26–2026-10-27)

Tests were deferred until the implementation was assembled. Failures found in that final validation
phase were repaired and their affected checks repeated.

| Check | Result |
| --- | --- |
| Layout tests | 33 passing: 22 structural/editor tests, 8 pointer interaction tests and 3 asynchronous insertion-anchor tests; includes the corrections recorded below |
| `npm run test:db` | 173 passing |
| `npm run test:updates` | 7 passing |
| `npm run build` | Passing; existing large-chunk/dynamic-import warnings remain |
| Targeted lint of layout modules, menus and tests | Passing |
| Full project lint | Blocked by pre-existing `react-hooks/rules-of-hooks` error in `src/autobackup.ts:116` (`useFolder` is an ordinary async helper) |
| Browser smoke check | Insert independent 2/3-column groups, Persian text, menu move, presets, full-width exit, narrow stacking, keyboard/mouse resize, block/group dragging, drag Undo, persistence and reopen verified using disposable browser storage |
| Pointer drag | Browser verified cross-group block movement, whole-group movement and Undo; handler tests cover Escape, blur, lost capture, document replacement, no-op and invalid destinations |

The final browser check caught and fixed a NodeView mount-order crash on reopening saved layouts;
a regression test now covers mounting before `editor.view` is assigned. The multi-block selection
check caught and fixed ancestor traversal incorrectly classifying a same-column selection as crossing columns.

Screenshot: [browser review](screenshots/flexible-layout-review.png).

The browser test used a separate localhost origin and synthetic content, not the user's notes vault.
The 48 reference scenarios have **not** all been executed. OS-level drag/resize cancellation, native IME composition,
screen readers, two-device sync/conflicts, native crash/write-failure recovery,
and older-client safety remain manual acceptance items. Synchronization and older-client rollout
are owned separately under the user's scope update above.

The original native HTML drag path was replaced with pointer movement after browser automation could
not produce a native dragstart. Pointer movement was then verified in the browser. Preview movement
does not mutate the document; release commits one transaction. Dragging a whole group into another
column is rejected, and late releases after document replacement cannot apply stale positions.

Resize observation now ignores height-only notifications and defers layout writes to an animation
frame. This preserves a width preview when text wraps and avoids synchronous ResizeObserver loops.
The NodeView regression test covers notification coalescing and cleanup; the affected browser resize
check completed with no loop warning in the fresh development log.


## Editor completion audit after the reported grip defect (2026-10-27)

The source note's “document only” language (`SCOPE-04`) describes its earlier authoring task.
The user's later explicit request authorizes implementation. The note's editor behavior contracts
remain the reference; a test result for one path is not a claim that every manual FL scenario passed.

| Requirements | Implementation in this branch |
| --- | --- |
| SCOPE-01–03, MODEL-01–04 | Existing Page/editor, independent root groups, continuous document/history, explicit full-width exit; no page migration |
| UX-01–04, MOVE-01–05 | Toolbar/slash insert, full-block selection, focused settings, count/width presets, keyboard move menus, lossless reduce/unwrap, pointer move and resize |
| DND-01–06 | Direct flow-block/group grips, selected multi-block movement, precise drop indicator, autoscroll, source/target validation, atomic commit, cancellation and keyboard alternatives |
| EDITOR-01–03 | Two schema nodes in the same editor; contentDOM for columns; ProseMirror transactions and position mapping |
| EDITOR-04–05 | Existing rich/atomic block data retained; corrected atom-boundary grips, checklist/database support, anchored async database insertion, column-boundary keys and composition guards |
| EDITOR-06 | JSON/HTML structural serializers; logical Markdown order; database reference retained in Markdown HTML instead of omitted |
| DIR-01–04 | Independent group direction, stable logical order, narrow stacking, constrained overflow, labeled column groups and keyboard navigation |
| STORE-01/04, SAFE-01–03 | Layout remains in page content; attachment/link identities retained; recursive existing indexing/export; scoped styles and protected incompatible JSON |
| EDGE-01–09/11 | Counts, widths, unwrap order, keyboard/selection guards, move-only pointer actions, delete confirmation and transient resize rules |
| EDGE-12 (current editor) | Unknown/malformed persisted structures are protected; invalid widths are only repaired by explicit preset selection |
| STORE-02/03/05, EDGE-10, old-client part of EDGE-12 | Existing persistence paths retained; synchronization/conflicts/rollout owned by the separate contributor |

Corrections in this pass:

- Reserve a 28px logical gutter inside every column. The 24px block grip and the between-column
  resize hit area no longer overlap in either direction, including middle and last columns.
- Keep the row target stable while the pointer crosses the gutter; do not jump to the group handle.
- Resolve atomic blocks at their outer position so images, drawings and database embeds can move.
- Preserve image percentage sizing against the column's actual content width after adding the gutter.
- Add logical arrow navigation at column boundaries, column labels and composition guards.
- Keep asynchronous database creation anchored to the command's original location; cancel stale
  insertions on document replacement/destruction, and avoid mounting a destroyed lazy database view.
- Constrain the actual database embed wrapper's overflow within its column and retain its Markdown reference.

### Completion validation

| Check | Result |
| --- | --- |
| `npm run test:layout` | 33/33 passing after the editor corrections |
| `npm run build` | TypeScript and production build pass; existing bundle warnings remain |
| Targeted `oxlint` and `git diff --check` | Passing |
| Middle/last column grips | Click opens the destination menu in both LTR and RTL; RTL last-to-middle pointer movement and one-step Undo also verified |
| Checklist inside a column | Persian task text, checkbox toggle and checked state after reload verified |
| Database inside a column | Slash insertion into column 2, row creation/editing, bounded horizontal overflow, move to column 1 and one-step Undo verified; row survives reload |
| Native copy/paste | Copying the group emits HTML/plain text; pasting at full width retains a 2-column group and the database reference; pasting inside a column flattens the layout without nested groups or losing the database |
| Browser diagnostics | No console errors or ResizeObserver loop messages in the fresh development session |

Screenshots: [column destination menu](screenshots/flexible-layout-handles.png),
[checklist and database in columns](screenshots/flexible-layout-database.png).

The completion check used only synthetic pages in the localhost browser workspace. Native IME,
screen-reader operation and OS crash/write-failure acceptance still require their actual target
environment; those scenarios are not marked as executed. No Sync code is changed as part of this
completion audit.
