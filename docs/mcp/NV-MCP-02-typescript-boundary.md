# NV-MCP-02 — Shared TypeScript projection boundary

Date: 2026-10-26. Status: complete for the extraction checkpoint.

The desktop search adapter now calls `projectSearchDocument` and `searchWords` from `spike/tiptap/src/documents/searchProjection.ts`. Normalization lives in `documents/normalize.ts`; the previous `src/normalize.ts` path re-exports it so existing UI imports remain compatible.

The shared core accepts a structural page DTO and returns the existing index payload. It imports no repository singleton, React, DOM, Tauri, storage, timers, or Node API. `tsconfig.documents.json` checks it with only ES2023 types and an empty ambient type list. A Node test adapter consumes the same fixture pages without loading the app. The MCP spike also imports this exact code.

## Adapter decisions

- Existing `searchIndex.ts` remains the desktop index lifecycle adapter: Tauri invocation, repository lookup, debounce, batching and refresh stay there.
- Existing browser substring retrieval stays in `Repo.search`. A portable engine and parity across backends are NV-MCP-08, not a claim of this extraction.
- The shared projection deliberately preserves existing payload text and whitespace for the fixture corpus. Attribute-only formulas, Mermaid source and page-link labels remain a known gap. Changing that projection requires versioned index invalidation/rebuild; it is deferred to retrieval work.
- The TipTap UI extension array imports DOM-dependent node views and store state. This task does not move that array into the core or claim a headless editing schema; schema extraction belongs with later document operations.
- Stable block identities, passage reads and strong revisions remain later milestones. Node executes `.ts` for development tests; production UI bundles the same source through Vite.

## Validation

Run from `spike/tiptap/`:

- `npm run test:documents`: ES2023-only strict typecheck and 16 passing tests, including all previous normalization cases, fixture payload parity through an in-memory adapter, unchanged input/original text, query splitting and malformed boundary input.
- `npm run build`: TypeScript and Vite pass. Existing dynamic-import warnings remain.
- `npm run test:direction`: 4 pass.
- `npm run test:updates`: 7 pass.
- `npm run lint`: inherited error at `src/autobackup.ts:116` and the same 234 warnings as NV-MCP-01. No new lint failures observed.

This proves reuse of the extracted projection, not mobile UI support, search relevance, index freshness after external changes, or safe document edits.
