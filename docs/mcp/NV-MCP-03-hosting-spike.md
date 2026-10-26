# NV-MCP-03 — MCP hosting and packaging spike

Date: 2026-10-26. Status: complete for the sample-only hosting investigation. Production bridge work remains NV-MCP-16.

See [the executable spike and decision record](../../tools/mcp-spike/README.md) for reproduction commands, pinned versions, lifecycle, credentials, app-closed behavior and packaging tradeoffs.

The actual MCP Inspector CLI 2.12.0 listed and called `project_sample` on a stdio server using official TypeScript SDK 2.4.0. The handler imports the same pure TypeScript projection used by desktop search. Input `كلاس ۱۲۳ Java` returned original text, normalized `کلاس 123 java`, query words and explicit `sample-only` scope. No live vault or desktop connection was involved. Inspector initialize negotiated `2025-11-25` in the recorded invocation.

The source/bundled host and a local ad-hoc-signed Apple Silicon standalone executable passed calls, validation and close/reaping checks. EOF exits without protocol noise. The standalone ran with an empty PATH and empty working directory. Five tests pass when the optional binary is supplied; the regular developer suite has four tests. Strict TypeScript checking also passes.

The bundle is about 789 KiB; embedding the runtime produced a roughly 138 MiB executable. This validates a fallback for installations without Node, but it conflicts with the user's size goal. Keep SDK/Inspector/bundler dependencies isolated from the app and the standalone artifact out of Git. Prefer an app-owned TypeScript service with a narrow native transport bridge and an optional thin stdio relay for production. No system runtime, credential store or client configuration was modified.

The Homebrew Node build lacked the required SEA marker. Packaging succeeded using official Node v26.4.0 from a temporary archive verified against the same release's published SHA256. The generated binary was signed ad hoc for local testing only. Native Rust tests remain unavailable due the inherited Homebrew Cargo library failure.

The source protocol spike is complete; real vault reads/writes, JS-webview readiness/background tests, the native bridge, OS credential pairing, production SDK choice for the native transport, installation across supported platforms, and model-host compatibility remain later gates. A working Inspector call does not satisfy those gates.
