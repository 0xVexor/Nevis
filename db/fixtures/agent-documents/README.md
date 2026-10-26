# Agent document fixtures

Synthetic baseline corpus for NV-MCP-01. `pages.json` uses the current Page/TipTap JSON shape; `manifest.json` records exact targets, normalization expectations, visibility inputs, and future workflow cases. No private vault was read or copied.

The corpus contains a folder and seven documents: linked concurrency notes, mixed-direction tables/formulas/Mermaid, an 80-section document, deliberately unsupported content, an excluded page, and a trashed page. There are duplicate headings both within and across documents. Timestamps and UUIDs are fixed.

Run `npm run test:documents` from `spike/tiptap/`. The checks validate references, fixture coverage and existing Persian normalization. They do not validate the complete editor schema or implement the future workflow cases. Unsupported nodes are intentional. Paths are revision-bound fixture coordinates, not a stable-ID API.

Do not import these files into a real vault as a backup. Future tools should load them through test storage adapters. Keep the source JSON immutable during each test; clone before mutations. Update the manifest deliberately when adding cases, and preserve future-node payloads and original-language text.
