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
