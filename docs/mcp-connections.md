# Local MCP connections

The desktop preview can expose saved documents to a local agent client through an opt-in Streamable HTTP endpoint. Open **Settings → Agent connections** in the vault you want to share. Access starts disabled, and reopening Nevis does not restore a listener.

Choose document roots or enable all documents in the current vault. A selected root includes its descendants. Excluded documents and their descendants always take priority. Missing or cyclic ancestry fails closed. The client cannot choose another vault or alter this policy through a tool call. Disconnect before changing permissions.

Click **Enable connection**, then **Copy connection details**. The copied JSON has this shape:

```json
{
  "url": "http://127.0.0.1:<assigned-port>/mcp",
  "headers": { "Authorization": "Bearer <private-token>" }
}
```

Enter these fields in a client that supports direct Streamable HTTP and a custom Bearer header. The copied token grants access to the selected documents; give it only to the client you intend to authorize. Client-specific configuration formats vary. This preview does not install a stdio relay or change client configuration automatically.

The app assigns a new port, token and grant revision on every enable. Disabling revokes the in-memory credential immediately and attempts to remove it from the operating system credential store. Vault switches and app reloads invalidate the old connection. Copy fresh details after enabling again. Nevis must stay open with its vault loaded; an unavailable webview fails requests after the bridge deadline. Background/suspended-webview behavior still needs actual-client acceptance.

## Tools and saved state

The server advertises eight tools: `list_documents`, `search_documents`, `read_document`, `get_document_history`, `create_document`, `edit_document`, `update_document_metadata`, and `undo_document_edit`.

The adapter calls the shared TypeScript document service. Reads use persisted state and never flush or expose unsaved editor drafts. Search, history and content reads apply the same current grant. Cursors belong to the connection and query snapshot. Historical operations remain device/grant-local and bounded by the existing retention policy.

External editing is disabled. Native settings reject write grants, and the TypeScript host has a separate closed release gate. The four mutation handlers are wired and covered through a test-only write grant. Enabling them for users requires the task 17 acceptance evidence, including authorization at final atomic admission. Do not enable writes by changing only the UI checkbox.

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

Cancellation and deadlines invalidate the request. Native code holds no vault lock while awaiting the webview response. Replies must match both the pending request and active grant revision; revoked replies are discarded. Status and bridge events omit credentials. Configuration stores only grant identity, vault identity and policy in the per-device app data directory outside the vault. Tokens use the operating system credential store, with no plaintext fallback. Native providers are currently selected for macOS and Windows; other platforms fail closed.

## Evidence and remaining acceptance

Focused automated checks cover scoped handlers and schemas, all mutation delegations under a test grant, saved reads, scope changes after asynchronous I/O, bounded dispatch, cancellation, request limits, revocation, native loopback request guards, and the official MCP client library over a local HTTP fixture.

The official-client fixture runs the real TypeScript handlers through a Node test HTTP server. The native tests use a simulated webview callback over real loopback sockets. These are separate boundary checks. They do not prove the combined packaged Tauri/webview connection, operating system credential prompts, background behavior, or an intended agent application's complete workflow. Those remain tasks 17–18. Full PR suites and production packaging run at the final merge gate.
