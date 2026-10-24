# Experimental Notion-inspired appearance

Run the existing Vite app from `spike/tiptap` with `npm run dev`.

- Original appearance: `/`
- Experimental appearance: `/?design=notion`
- Colored experimental appearance: `/?design=notion-color` (adds the isolated
  `src/notion-color-preview.css` layer; keeps the monochrome preview available).

The preview is opt-in for each URL and is not saved as an appearance preference.
Both URLs use the same app, features, and storage on the same origin. Editing a
note in the preview edits the real note; this is a visual preview, not a data
sandbox. Different browser profiles or ports have separate IndexedDB storage.

All experimental CSS is scoped under `data-design-preview="notion"` in
`src/notion-preview.css`. The only activation code is in `src/main.tsx`.
Remove the query parameter and reload to return to the original appearance.
To remove the experiment entirely, remove that stylesheet import and activation
block, then delete the stylesheet. Existing styles and backend remain unchanged.

Verification: TypeScript and production build pass. Home, existing note editor,
formatting direction dropdown, page drawer, and settings were checked in the
browser at a 1440px desktop viewport. The original URL was checked to have no
preview attribute and its original violet accent. Full-project lint reports an
existing rules-of-hooks error in `src/autobackup.ts` (outside this change).
