# Nevis MCP hosting spike

Development-only proof for NV-MCP-03. One bounded read-only tool, `project_sample`, projects caller-supplied text through the application's shared TypeScript core. It has no vault, credentials, editor, filesystem storage adapter, or listener socket. Do not configure it as the production Nevis integration.

Pinned development dependencies live here, outside the app. SDK server/client 2.4.0, Inspector 2.12.0, Zod 4.4.3 and esbuild 0.28.2 were verified against published packages on 2026-10-26. The server uses the SDK factory and stdio transport, leaving stdout exclusively for protocol messages.

## Run

Use Node 24+ for source development:

```sh
cd tools/mcp-spike
npm ci --ignore-scripts
npm run check
npm test
./node_modules/.bin/mcp-inspector --cli node server.ts --method tools/list
./node_modules/.bin/mcp-inspector --cli node server.ts --method tools/call --tool-name project_sample --tool-arg 'text=كلاس ۱۲۳ Java'
```

The reference developer client for this spike is the real MCP Inspector CLI. Automated checks additionally use the official SDK client over child-process stdio. Neither requires a model provider. Codex, Claude, Cursor and mobile-client compatibility have not been tested.

## Optional standalone packaging experiment

`npm run build` bundles the server, SDK and shared core into ignored `dist/server.cjs` and writes `dist/sea-config.json`. Using an official Node executable with SEA support, run:

```sh
/path/to/official/node --build-sea dist/sea-config.json
# macOS local execution only:
codesign --sign - --force dist/nevis-mcp-spike
NEVIS_MCP_EXECUTABLE="$PWD/dist/nevis-mcp-spike" NEVIS_MCP_EMPTY_DIR=/path/to/empty/directory npm test
```

Built-in `--build-sea` requires Node 25.5+, so this optional experiment is separate from the Node 24 source/CI path. The binary format is host-specific; Windows uses `.exe`. Set the test directory to an existing empty directory. The standalone test launches with an empty PATH, verifies the same tool response, and checks process shutdown. All build artifacts are ignored and must remain out of Git.

The local Homebrew Node could not build a SEA because its fuse marker was absent. A checksum-verified official Node v26.4.0 arm64 binary in temporary storage succeeded. Only that temporary binary was used; no global runtime was replaced.

## Observed results and product decision

On macOS arm64 with Node v26.4.0:

- Strict typecheck passes.
- Five tests pass with the optional standalone executable: source and bundle protocol calls, standalone call with an empty PATH/working directory, EOF exit, and actual Inspector call. The normal source/CI suite has four tests.
- Client close reaps its child process; invalid argument types and over-limit text return tool errors. Startup/EOF leave stdout clean.
- Inspector `initialize` reports protocol `2025-11-25` for this invocation. Do not infer that another client negotiates the same version or that all SDK protocol modes were exercised.
- The JavaScript bundle is about 789 KiB. The ad-hoc-signed standalone executable is about 138 MiB. Standalone launch works without a Node executable on PATH or source/dependency files in the working directory.

Decision: keep this Node host as an optional development probe. Do not add a 138 MiB runtime to Nevis's normal installation for this feature. For the current Tauri host, use a narrow native transport bridge to the app-owned TypeScript service, with direct local HTTP for supporting clients and a small native stdio relay only when required. Future host migrations can replace that transport adapter while reusing the core. The packaging experiment proves a fallback is possible, not that it is the preferred product architecture.

The bridge and relay belong to the later scoped adapter/settings task, NV-MCP-16. They are not implemented in this spike. The current app is not exposed by this package, and no app-specific token or client configuration was installed.

## Live app contract to implement

- The running app owns the authorized immutable vault handle and the TypeScript document service. Never let a relay open vault files or duplicate search logic.
- Native transport forwards bounded typed requests with request IDs to the TS service and routes exactly one result/error back. Include a deadline, cancellation and shutdown behavior; never hold persistence locks while awaiting the webview.
- App closed or JS bridge not ready yields `APP_UNAVAILABLE`; timeout/minimized suspension must fail explicitly. Do not silently open a vault in the companion. Actual webview background/minimized behavior remains to be measured before product release.
- Local HTTP requires opt-in loopback binding, credentials, Origin/Host checks, revocation and quotas. Keep credentials in device-local protected storage, outside notes/sync. The stdio client owns the relay subprocess; IPC discovery and authentication are required for the live bridge even though this sample-only process needs no credential.
- Return editor-busy/revision errors through shared operations when writes arrive. No editor mutation or unsaved-draft access exists yet.
- Disabling access closes the app endpoint and invalidates grants. A future relay must return the unavailable/revoked result rather than retaining data access.

Ad-hoc signing proves only local Apple Silicon execution. Windows, Intel/universal packaging, notarization, Tauri integration, real editor lifecycle, background execution, live vault grants and production tool interoperability remain unverified. CI adds the source/bundle/Inspector checks on Node 24; it does not build or distribute a runtime.

## Primary references

Checked 2026-10-26:

- [SDK stdio server factory](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)
- [SDK client connections](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
- [Inspector CLI](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md)
- [Node single executable applications](https://nodejs.org/api/single-executable-applications.html)
