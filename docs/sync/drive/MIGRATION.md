# Provider migration

Use an isolated preview and synthetic data until the gates in TEST_RESULTS.md pass.

1. Stop legacy sync on every device. Export and verify portable backup v2. Keep the old remote repository/server copy.
2. Open Account and sync → Google Drive. Sign in. Save/flush occurs before connecting.
3. Back up and connect performs a full verified filesystem backup, then deterministic block-ID migration. The path is shown in the UI and retained in binding metadata.
4. A pending GitHub publication blocks switching. Settle it under the original provider first; do not delete pending.json.
5. The old GitHub binding is archived, not removed from the remote service. Drive binding takes precedence and prevents simultaneous writers in this application.
6. Other devices must explicitly join the same Drive Vault. Do not independently initialize another remote Vault as a substitute.

Block-ID migration is deterministic and repeatable after backup. It does not rewrite IDs or add IDs to inline text. Duplicates fail closed. A migration can be partially completed per file on interruption; retrying finishes deterministically. The format-2 fence preserves logical identity in driveVaultId and leaves the legacy id empty. Opening an older build on the original migrated folder must fail; use a portable fresh-ID copy to change provider. The lifetime OS lock fences cooperating native app processes. External tools ignoring advisory locks cannot be controlled.

The connect path switches legacy sequential unique-ID definitions to partitioned allocation after backup, preserving existing tokens and IDs. A versioned per-key settings policy defaults to global and can mark font size or another allowlisted appearance setting device-local. Policy changes do not erase previously uploaded history. External Google preparation succeeds before migrations/fencing; provider-switch.json preserves recovery evidence before the format change.
