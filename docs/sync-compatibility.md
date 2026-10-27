# Sync compatibility and failure handling

Client upgrades retain the application identifier, account storage, credential service and workspace markers. A client update does not create a new account or relocate notes.

The server health response now advertises `database_sync`, `permanent_delete` and the supported sync roots. Before changing files, a client with database records checks that the server supports them. Old servers remain usable for workspaces without database records; workspaces with database records stop with a server-update message until the server is upgraded. Deploy the updated `server/` before distributing the desktop change.

Local and remote paths are validated before deduplication, uploads, downloads or deletions. Validation checks roots, path segments, reserved names, forbidden characters, length, Unicode NFC and the allowed database record directories. Symbolic links and incomplete directory scans stop the sync. Paths differing only in case require the user to resolve the ambiguity. Files are not silently renamed or dropped to bypass these checks.

Transfers and conflict uploads precede deletions. If a transfer fails, planned deletions are held and their baseline entries are retained for retry. Successful transfers can remain; a sync is not an atomic transaction across devices. Existing local sync trash and server revision history remain in use.

Permanent deletion and restoration are different endpoints. An old server can support restoration while not recognizing permanent deletion. A missing delete route is reported explicitly without removing the workspace from the account list. Repeating a permanent delete after an interrupted success is safe. Vault metadata changes schedule a database backup as file writes already do.

Account errors retain copyable client version, operation, file path, server endpoint and HTTP status when available. Server validation reasons are preserved. Passwords, authorization headers, tokens and note contents are not included. Response URLs exclude credentials and query strings; network errors exclude URLs. Error details stay on the device until the user copies them.

Regression coverage includes database path validation and preservation through trash/restore, repeated permanent deletion, backup scheduling, failed-transfer deletion holds, incompatible servers, unsafe remote snapshots, and Persian/English list directions.
