## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## UI checklist (skip if nothing visible changed)

- [ ] Built from design-system components and `ds-` classes; nothing new styled one-off ([docs/design-system.md](../docs/design-system.md))
- [ ] Logical CSS properties only (`inline-start`, `inline-end`), no new `left` / `right`
- [ ] Rows and cards that show user text follow that text's direction (Persian right-aligned, icon on the right)
- [ ] Checked in light and dark, English and Persian (RTL), at the minimum window size, and with the keyboard
- [ ] `npm run check:ui` passes; if violations went down, the baseline was updated (`npm run check:ui -- --update`)

## Tests

- [ ] `npm run test:layout`, `npm run test:direction`, and the suites for the area touched
