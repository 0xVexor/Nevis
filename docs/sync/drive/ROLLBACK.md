# Rollback without destroying local changes

Pause Drive and export a complete current portable backup first. Disconnect Google removes the OS credential and pauses the current binding; local Vault, journals, cached objects and remote files stay.

Switch to local-only requires no outbox and no uncaptured local changes. If publication is blocked, keep the existing binding paused and use a restored portable **copy** for local-only work; do not erase pending receipts. There is no unsafe discard-pending button.

For code rollback, close the experimental app, then use an earlier build with a separate local copy from the verified pre-migration backup. Do not point an older client at a live Drive-migrated Vault. Restoring a portable backup gives the copy a new Vault ID and no automatic provider binding.

The source integration merge is e140ce7; Drive implementation is recorded on feature/drive-sync for local review. No upstream push or release is performed. Original working-tree edits remain in /Users/wrangler/Develop/Nevis.

Root/vault folders, immutable streams, objects and restore points are never automatically deleted by rollback. Archived GitHub bindings are retained under app-data; reactivation must be an explicit provider setup using the current backup, not a silent file rename while a worker is running.
