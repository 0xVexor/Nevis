# Local MCP connections

The desktop preview can expose saved documents and revision-gated edits to a local agent client through an opt-in Streamable HTTP endpoint. Open **Settings → Agent connections** in the vault you want to share. Access starts disabled, and reopening Nevis does not restore a listener.

Choose document roots or enable all documents in the current vault. A selected root includes its descendants. Excluded documents and their descendants always take priority. Missing or cyclic ancestry fails closed. The client cannot choose another vault or alter this policy through a tool call. Disconnect before changing permissions. Normal macOS/Windows builds offer a separate **Allow document editing** opt-in after the recorded live-client acceptance. Connections still start disabled and write permission starts unchecked. Builds made with `--no-default-features` omit native write support.

## Connect an AI app once

Settings → **AI connection** has one switch, **Allow AI access**, and a separate **Allow document editing** switch that starts off. Hiding single documents lives under **Advanced**. Turn the first switch on, then press the button for your AI app: **Claude Desktop**, **ChatGPT / Codex** or **Gemini CLI**. Nevis adds itself to that app's own settings file (other entries stay, a `.nevis-backup` copy is made) and the AI app only needs a restart. For any other AI app, **Copy for another AI** puts a ready-to-paste message on the clipboard.

What the button writes is a stdio entry that starts the Nevis program itself as a relay (`nevis --mcp-stdio`):

```json
{ "mcpServers": { "nevis": { "command": "<path to Nevis>", "args": ["--mcp-stdio"] } } }
```

The relay reads the current port and token from `endpoint.json` in the Nevis app data folder (outside every vault; only your OS user can read that folder, and it is deleted when the connection stops). It forwards each request to the live local connection. If Nevis is closed when the AI app asks, the relay starts it and waits up to 25 seconds. The switch stays on across restarts: when the vault opens, the connection comes back with the same scope and a **new** port and token written to `endpoint.json`. Turning the switch off removes the saved choice and the file. Direct HTTP use still works the way it did: details below. Set `NEVIS_NO_LAUNCH=1` to keep the relay from starting the app.

Supported by the AI apps themselves (checked against their documentation, not yet by a live run on every platform): Claude Desktop reads `claude_desktop_config.json`, Codex reads `~/.codex/config.toml`, Gemini CLI reads `~/.gemini/settings.json`. Web and mobile AI apps cannot reach a program on your computer and are not supported.

## Direct HTTP details

For clients that take a URL, **Copy connection details** (shown while connected) copies JSON of this shape:

```json
{
  "url": "http://127.0.0.1:<assigned-port>/mcp",
  "headers": { "Authorization": "Bearer <private-token>" }
}
```

Enter these fields in a client that supports direct Streamable HTTP and a custom Bearer header. The copied token grants access to the selected documents; give it only to the client you intend to authorize. Client-specific configuration formats vary. This preview does not install a stdio relay or change client configuration automatically.

The app assigns a new port, token and grant revision on every enable and every start. Disabling revokes and discards the token held by the active session. Vault switches and app reloads invalidate the old connection. Copy fresh details after enabling again. Nevis must stay open with its vault loaded; an unavailable webview fails requests after the bridge deadline. Background/suspended-webview behavior still needs actual-client acceptance.

## Tools and saved state

The server advertises fourteen tools: `get_editor_capabilities`, `list_documents`, `search_documents`, `read_document`, `get_document_history`, `create_document`, `edit_document`, `update_document_metadata`, `undo_document_edit`, and the database tools `list_databases`, `describe_database`, `query_database_rows` (read) and `create_database`, `add_database_rows` (write, only with **Allow document editing**).

**Markdown.** `create_document` takes `markdown` instead of `content` (exactly one of the two), and `edit_document` has an `insert_markdown` operation. The text is converted with the editor's own Markdown rules (headings, lists, task lists, tables, quotes, code and Mermaid fences, math) before the normal validation, replay hashing and history, so retries with the same operation ID still return the original receipt.

**Databases.** Databases are read through their own tools. A database is visible only when its host page is inside the connection's document scope; a hidden page hides its databases, and a hidden database answers `NOT_FOUND`, the same as a missing one. Rows are returned as plain values keyed by property ID (select options by name), up to 100 per call with a cursor. `create_database` builds a full-page database with plain properties (text, number, checkbox, select, multi-select, url, email, phone, date) and up to 100 rows in one call; `add_database_rows` appends up to 100 rows, all together or none. Values are keyed by property name, select options are matched by name and never invented, and each call takes an `operationId` so a retry completes or replays instead of duplicating. Formulas, relations, files, views, editing or deleting existing rows and changing existing properties are not exposed yet. Database writes use the connection's write grant and the document scope, but not yet the native write admission lock that document edits use.

The adapter calls the shared TypeScript document service. Reads use persisted state and never flush or expose unsaved editor drafts. Search, history and content reads apply the same current grant. Cursors belong to the connection and query snapshot. Historical operations remain device/grant-local and bounded by the existing retention policy.

Editing is opt-in and uses exact document revisions, explicit block targets and durable operation IDs. Use preview before apply. A retry must repeat the original operation ID and payload; it returns the original saved receipt instead of applying twice. Stale revisions reject the edit. Unsaved editor drafts reject conflicting writes.

The storage adapter checks the current hierarchy and live grant at final admission. Native admission holds the shared vault lock and validates the pending request, grant revision, deadline, target scope and newly introduced internal references before writing a durable prepare. Memory and IndexedDB apply the same check in their atomic mutation boundary. Cancellation or revocation before admission rejects the operation. Once the durable prepare is accepted, recovery must finish it even if the client disconnects. A timeout after admission can therefore mean the save succeeded; retry with the same operation ID to recover its original receipt.

`edit_document` also supports `set_table_cell` and `insert_table_row`. Targets identify the table and cell/anchor row by stable block reference. Cell replacement preserves cell attributes and merged spans. Row insertion explicitly supplies the new cells and extends vertical spans crossing the insertion boundary. Rectangular grid validation rejects holes, overlaps, invalid widths/spans and unsupported shapes without saving a partial batch. Images and other unsupported content inside a cell remain protected from replacement.

Tool results include both `structuredContent` and a matching JSON text block. Contract failures return bounded error codes without raw storage errors, filesystem paths, note bodies or credentials. Note bodies occur only in authorized tool content, not diagnostics or connection configuration.

## Transport and limits

This implementation supports MCP protocol `2025-11-25`, authenticated HTTP POST with JSON responses, and no optional SSE stream. GET and DELETE return 405. There are no server-initiated requests, tasks, remote listeners or browser-origin clients. No separate Node runtime is required by the product.

The native listener binds literal `127.0.0.1` on an ephemeral port. It requires the exact Host and Bearer token and rejects every Origin header. Clients must send JSON, accept both `application/json` and `text/event-stream`, and include `MCP-Protocol-Version` after initialization. The policy follows the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports); protocol lifecycle follows the [lifecycle specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

| Boundary | Limit |
| --- | --- |
| Tool arguments / complete HTTP request | 256 KiB / 260 KiB |
| Structured tool result / complete JSON-RPC response | 64 KiB / 256 KiB |
| Native pending requests / TypeScript queued and active requests | 8 / 8 |
| Admission rate / concurrent sockets | 16 per second / 16 |
| Webview reply / body read / socket lifetime | 20 seconds / 5 seconds / 27 seconds |
| Bridge heartbeat / freshness requirement | Every 3 seconds / younger than 10 seconds |
| Scope selections | At most 100 roots and 100 exclusions |

Cancellation and deadlines invalidate the request. Native code holds no vault lock while awaiting the webview response. Replies must match both the pending request and active grant revision; revoked replies are discarded. Status and bridge events omit credentials. Configuration stores only grant identity, vault identity and policy in the per-device app data directory outside the vault. The MCP token is held in the active native session's memory and, while the connection runs, in `endpoint.json` for the relay. Enabling, copying connection details and disconnecting do not call Keychain or Windows Credential Manager. The copied token is sufficient for a configured client; clients must not try to discover it through an OS credential-store command. A restart creates a new listener and token only when you left the switch on; with the switch off nothing is created or kept.

## Rich editor authoring

Call `get_editor_capabilities` before composing a rich document. It provides every registered node and mark, per-node attribute schemas, content expressions and native JSON examples. This includes paragraphs/headings, nested lists and checklists, quotes, code blocks, tables and merged spans, callouts, toggles/flashcards, inline/block math, Mermaid diagrams, two/three-column layouts, images, drawing blocks, database embeds, inline icons and page links. Formatting includes bold, italic, strike, underline, code and external links.

Use the same native JSON with `create_document` or `insert_blocks`/`replace_blocks`. `set_attributes` accepts the advertised attributes for the target type, including text alignment/direction, diagram/formula source, callout icon, toggle state, column widths, table dimensions and image sizing. IDs remain host-owned. Content must satisfy the editor's nesting rules; layout groups remain top-level and tables must form a bounded rectangular grid. Unknown original content remains protected.

Page metadata also accepts a gradient or image `cover`, with `null` clearing it. A `board` document contains exactly one drawing block. Creating or editing it uses the existing revision, history, retry and undo pipeline.

Images can use safe HTTP(S) URLs, bounded PNG/JPEG/GIF/WebP data URLs, or an existing `att:<sha256>` reference. Existing drawing scene/preview attachments and database container IDs must already be referenced by a currently readable document. A guessed private resource ID cannot be introduced through a new block or cover. Exact undo can restore a removed resource from the same grant's committed origin. New raster images and Excalidraw scenes can be uploaded with an optional `assets` array on `create_document` or `insert_blocks`/`replace_blocks`. Each entry contains `temporaryId`, `mimeType`, `name` and standard base64 `data`. Use `upload:<temporaryId>` in `image.src` or drawing `scene`/`preview`; the host verifies the content and replaces it with its SHA-256 reference. All uploads must be referenced. The limit is 20 assets and 192 KiB decoded bytes per request, within the existing 256 KiB request limit. Files are installed before the page, and native durable recovery completes interrupted uploads before publishing the accepted document. Database row writes and schema commands are not exposed by these tools.

Examples, including a new table, a Mermaid diagram and column layout, are returned by the capability tool rather than requiring clients to infer shapes from existing notes.

## Validation and support

The first acceptance target is macOS arm64. The same source has portable memory/IndexedDB checks and native CI; Windows and Intel Mac installer/runtime behavior are not established by the local Mac run. Web and mobile MCP hosts are not claimed. The memory-only token lifecycle does not require a platform credential provider; actual Linux desktop packaging/runtime acceptance remains unclaimed.

The final acceptance record in `docs/mcp-acceptance.md` separates the packaged desktop run, intended-client observations, automated regression results and remaining distribution limits. The reproducible synthetic fixture and measured SDK workflow are in `tools/mcp-spike/fixture.mjs` and `workflow.mjs`. They never adopt personal vaults. The product bundle itself needs no Node MCP runtime.

Locally signed preview artifacts are not notarized distribution releases. Do not interpret local signature verification as Gatekeeper, notarization, Windows installation or hardware power-loss proof.
