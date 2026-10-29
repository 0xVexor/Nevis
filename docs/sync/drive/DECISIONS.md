# Decisions

1. The requested latest dev is the source of truth. It diverged from `sync/github-personal-vaults`, which contains the documented implementation. After user clarification, use that branch plus a merge of the latest `origin/dev` in an isolated managed worktree. Preserve both existing providers and all unrelated user edits.
2. Drive has an independent immutable storage contract; the legacy mutable-file `Remote` interface cannot safely express it.
3. Keep destructive GC disabled. Retaining complete immutable logs permits deterministic reconstruction and conservative conflict retention until compaction and stale-device proofs pass.
4. Feature gate remains off by default, including releases. External OAuth verification alone is insufficient to enable release if implementation gates remain incomplete.
5. Device identity and account credentials live in app-data / OS credential store, outside portable vault backups. Preview and release use distinct credential services.

6. Actual source combines GitHub branch `e061895` and dev `45069f2` in merge `e140ce7`. One import conflict in PageView was resolved by retaining invoke/isTauri needed for editor conflict archiving.
7. Test execution is deferred to the final validation stage per the user's correction. An initial frontend baseline build had already exposed an unused COLUMN import in the user's original worktree; that unrelated work is not edited here.
8. V1 working implementation reuses the validated snapshot capture/apply boundary. Consequently its existing in-memory size limits still apply; streaming end-to-end large-media capture is a release gate, not an achieved guarantee.
9. Immutable streams share a verified streams folder and appProperties for indexing; there is no shared mutable HEAD. Per-device sequence/previousBatchId supply logical streams. Root and vault identities are metadata-bound; separate root-marker bootstrap and protocol fencing require additional verification.
10. Delta preimages are stored content-addressed. JSON object fields and identified block maps receive small patches; ambiguous arrays are archived as atomic conflicts. No character CRDT is claimed.

## Continuation on 2026-10-29

- Replaced page-local nesting normalization with a page-wide block registry, with structural recovery archives and field provenance.
- Added atomic multi-batch capture groups and content-addressed large JSON values.
- Added checkpoint seeds, covered-sequence fork detection and retained dependency objects. GC remains disabled despite synthetic pruning/restore tests.
- Added lifetime Vault/process locking and format-2 legacy fencing. External tools ignoring advisory locking remain outside this guarantee.
- Added per-setting global/device-local policy; old uploaded history is retained when a setting becomes local.
- Added immutable root/Vault descriptors, crash-resumable onboarding, regular-page Keep both, per-account counters and lifecycle/throttle/pause paths.
- Media now uses a Drive-specific file-backed boundary. Local source paths are never deserialized from a receipt. Legacy/GitHub Bundle APIs retain their existing behavior; portable backup copying also uses verified streaming.
- Local hash caching uses file identity/metadata and expires within 24 hours; deep check is available. Network payload hashing is independent. This is an explicit performance/integrity tradeoff for normal immutable local files, not protection from a malicious local program preserving all metadata.
- Flat physical stream/object folders remain a documented deviation; logical device sequence and content hashes provide identity. No Google-wide scope is requested to work around discovery.

- Read the local Vault format before the first editor render, independent of OAuth/status polling. Refresh the migrated store after connecting. This closes a startup window in which a new Drive page could be edited before block IDs were enabled.

- Small markers use multipart metadata+content in one request; large objects retain durable resumable sessions. This follows the official [Drive upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads), rechecked 2026-10-29. A response-loss HTTP fixture proves reconciliation by the same reserved ID without another create. Checkpoint manifests have an explicit 4MiB bound and fail before publication if exceeded.

## OAuth and replay correction after user sign-in failure

- A real token-endpoint probe with the configured public Desktop client and an intentionally invalid non-user code returned `client_secret is missing`. The earlier secret-less PKCE assumption was incompatible with this client. Import the original Desktop JSON locally into the OS credential store; never put the chat-provided secret in source, build config, logs or Vault data. Both exchange and refresh include the stored client parameter. Public distribution without per-device import remains unresolved; release stays disabled.
- Preserve full canonical replay inputs in a verified bounded deterministic gzip checkpoint object. A folded state alone is unsafe for non-associative multi-candidate merges when old actors return. This keeps convergence and recoverable historical assets, but it does not achieve bounded incremental history replay or authorize GC.
- Add verified-root selection, read-only history previews, fresh-copy names, relation graph decisions and more schema validation without changing existing GitHub/legacy providers.

## Customer sign-in correction

The user correctly rejected per-customer client-secret entry. Bundle the Google Desktop public-client parameter as publisher configuration, supplied by local/CI build environment. This is intentionally extractable native-client configuration, not a confidential backend secret. Preserve PKCE/state and keep every account token solely in the OS credential store. The build helper may read the developer Keychain item in memory on the build machine; customers never depend on that item. Reject incomplete enabled customer builds. Explicit developer mode retains manual setup for troubleshooting only. User confirmed real sign-in; do not treat it as refresh or two-device sync certification.
