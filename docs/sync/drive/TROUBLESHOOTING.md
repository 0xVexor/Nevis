# Recovery and diagnostics

Local saves are separate from network sync. First export a portable backup from Nevis before attempting repair. Keep the Vault, app-data Drive journal, object cache and pending receipts; never delete these to make an error disappear.

| Error | Meaning and safe response |
|---|---|
| oauth_not_configured / feature_disabled | Build configuration or closed release gate; local storage remains usable |
| secure_storage_unavailable | Unlock/repair OS credential store, then sign in again; never copy tokens into a JSON file |
| sign_in_required | Authorization rejected; reconnect to the original account |
| account_mismatch / identity_mismatch | Wrong account or mismatched folder identity; do not rebind by display name |
| duplicate_roots / duplicate_vaults | No arbitrary selection; inspect IDs in test Drive and preserve all copies |
| remote_unavailable / remote_history_removed | Access revoked or known immutable data removed; local data is retained; restore access/remote test files before retry |
| rate_limited | Mandatory deadline survives restart; Sync Now respects it |
| storage_full | Free test-account capacity or upgrade its storage; preserve local edits |
| waiting_dependency / missing_dependency | A predecessor/object is missing; retain Inbox and retry after restoring it |
| device_id_collision / previous_batch | Preserve journals and all remote versions; do not reset sequence/device identity on an established binding |
| journal_corrupt / inbox_corrupt | Fail closed; recover from verified backups and retained immutable data in a separate workspace |
| local_changed | A local write arrived during transfer; retained and retried |
| apply_recovery_required | Local data matches neither safe before nor after; preserve all three and restore into a copy |
| duplicate_block_identity | Ambiguous structural merge; do not manually delete a candidate; export and inspect archives/logs |
| item_too_large / response_too_large | Current implementation limit; preserve local state and reduce test data before retry |
| upload_session_expired | Same reserved file ID is retained; next attempt can start a new session |

Diagnostics display counts/bytes and GC deferral. Do not send tokens, callback URLs, credential dumps, private page content or full journals in a public bug report. Share app version, OS, branch/commit, sanitized error code, pending count and reproducible steps using synthetic data.

A live Vault now holds an OS lock shared by its same-process handles. A second native process must fail with VAULT_IN_USE. Marker/lock replacement also fails closed. External editors ignoring advisory locks are not fenced. Windows behavior still needs a real-host test.


Interrupted download: choose the original parent and name to resume the receipt-owned staging folder. Do not delete download.json or journal.json. A different target reports download_recovery_pending. Existing unrelated targets are never replaced.

Large media: Drive media capture/download/apply is file-backed; JSON still has 95 MiB/file and 512 MiB aggregate bounds, and journals can grow. Debug initial hashing/copying can be slow. The local hash cache notices normal metadata/identity changes; use the deep-check button for a fresh byte scan. A malicious local writer preserving all metadata is outside the cached-verification guarantee.

Pause stops subsequent requests/chunks and keeps outbox/upload receipts; an already running HTTP call can take up to its timeout. Resume removes the pause signal. A mandatory Retry-After still applies.

GC proof stale: run dry-run again after any journal/inventory change. Verification must preserve all referenced history objects. Guarded execute reports GC_DEFERRED; this build cannot delete remote history.

## Google rejected the sign-in request / missing client_secret

The initial configured Preview omitted a client parameter required by this actual Google Desktop client. Use the corrected Preview, open Enter saved client secret, paste the value saved when this Desktop client was created, and select Save client secret securely before signing in. Existing-secret downloads are no longer available in the current Console. Import Desktop OAuth JSON remains an alternative only if that original file was already saved. A mismatched client ID is rejected. The native importer saves the client parameter only in the OS credential store; do not paste secrets into the repository or chat. Keychain failure is an error, never plaintext fallback. Successful real login/refresh still requires a user retest.

## Existing Desktop secret cannot be downloaded (user Console verified)

The user's current Google Cloud client detail page explicitly says viewing and downloading existing secrets is no longer available. Earlier instructions to download the existing client's JSON were incorrect for that page. No new client or secret rotation is needed if the original secret was saved. In the corrected Preview, open **Enter saved client secret**, paste only that saved value into the password field, select **Save client secret securely**, then sign in. The field is uncontrolled/transient, is cleared before the native call and when collapsed/unmounted, and is never put in localStorage/Vault data. The native command bounds/validates input, rejects a client ID or extra text, and stores it only in the same client-scoped OS keyring item used by JSON import. If a credential JSON was already downloaded earlier, import remains supported. No Google-side secret/client change was performed by this correction.

## Publisher-configured build supersedes per-user setup

The user confirmed real sign-in worked. Per-user Desktop JSON/secret setup was a temporary developer Preview workaround and is removed from normal customer builds. Use the publisher-configured package: it bundles the public Desktop client parameter and reads only user tokens from the OS store. JSON/manual setup commands require explicit developer mode. If publisher configuration is absent, the enabled customer build fails before distribution. See GOOGLE_SETUP.md for the publisher/CI workflow and Desktop-public-client security assumptions.
