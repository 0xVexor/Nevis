# Personal vault sync with GitHub

Implementation branch: `sync/github-personal-vaults`. The existing vault remains the local source of truth. Desktop sync runs in Rust, independently of the Noviq server. The existing browser/IndexedDB app remains local-first; GitHub authentication/sync currently requires the native Tauri app.

## Publisher setup (required before live sign-in)

Register a GitHub App under the publisher's GitHub account. Enable **Device Flow**, keep expiring user tokens enabled, and configure:

- Contents: read/write; Metadata: read.
- Repository creation: write where offered by GitHub, or Administration: write as required by the create-repository endpoint. Prefer the narrower creation permission. These permissions are not used for deleting repositories.
- Install on selected repositories. An App user token acts within both the user's access and the App installation's access. Creating a repository does not justify assuming installation access: the app verifies the created repository/ref before activating sync. If GitHub requires granting installation access to the newly created repo, choose it using the installation button, select **Use existing repository**, and retry. A created but inaccessible repository is left intact.
- No webhook, callback server, private key or embedded client secret is required by this flow.

Set these **public build-time values**, then build the desktop app:

```sh
NOVIQ_GITHUB_CLIENT_ID=Iv1.your_public_client_id \
NOVIQ_GITHUB_APP_SLUG=your-app-slug npm run tauri build
```

For release installers, set repository Actions variables `NOVIQ_GITHUB_CLIENT_ID` and `NOVIQ_GITHUB_APP_SLUG`; the release workflow passes them into the native build. These values identify the App; they are not secrets. The Rust build script tracks changes to both variables. An unconfigured build keeps local editing available and explains the missing App configuration in Account and sync. No credentials or real data repository were created as part of implementing this branch.

Windows uses Credential Manager, macOS uses Keychain, Linux uses Secret Service (GNOME Keyring/KWallet, unlocked user session required). Credential-store failure stops sign-in/refresh; GitHub tokens are never written to account.json, localStorage, vault files, backups or logs. The access/refresh token pair is stored as one keyring credential. Device codes exist only in process memory. Disconnect removes this credential locally; it does **not** claim to remotely revoke authorization. Use GitHub's App settings to revoke access.

Official references, verified 2026-10-27:

- [GitHub App device authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens): device-flow refresh does not require client_secret; ordinary access tokens last about 8 hours, refresh tokens about 6 months and rotate on refresh.
- [Create a repository](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)
- [Update a Git ref](https://docs.github.com/en/rest/git/refs#update-a-reference)
- [API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

PKCE is supported by GitHub. It does not remove the documented client_secret requirement from the code-exchange flow; this implementation uses Device Flow for the native client instead.

## Connection and migration

1. Update every active device before migration. Save any open editors. In **Account and sync → GitHub**, sign in and authorize the App's selected repository access.
2. Create the private `noviq-data` repository in the app, or select an existing personally owned private repository. Empty repositories are initialized with an additive README write; sync itself never treats a 404 as an empty remote.
3. **Back up and connect this workspace** makes a full filesystem backup in the per-device app-data `github/backups/<vault>-<timestamp>/`. It copies pages, all 13 database record kinds, assets, shared kv, history, conflicts, existing trash and tombstones, verifies every copied file by SHA-256 readback, and writes `BACKUP-COMPLETE.json` last. The native vault lock covers the snapshot/backup, not network requests.
4. Only after backup completion is the local GitHub binding persisted. The worker routes that vault to one provider. The legacy server snapshot and original local files are not removed or rewritten as a migration. The first GitHub snapshot establishes a new provider baseline.
5. On another device, use the existing repo and **Find my other workspaces → Download to a new folder**. Download uses a staged folder, verifies the manifest/bytes, then renames it into the selected parent. Existing local data is never replaced. To combine an existing local workspace with the same remote vault identity, open that existing vault and connect it; differing files without a shared base are preserved as conflicts.
6. Check the last successful sync, open representative layouts/drawings/calendars/databases, review conflicts, and export a full portable backup. Prove this on a second device before retiring infrastructure.

A disconnected workspace is paused; the app does not silently resume legacy sync. The migration backup is an ordinary vault copy and can be opened separately. Full backup v2 also restores into a **new disconnected workspace with a new vault identity**, after staging and hash verification, so the original is retained. Legacy page-only JSON backups remain importable into a separate native workspace. Browser full backups include page versions, kv, database records/history/metadata/operation records and verified attachments; restoration writes the main database in one transaction and stages assets additively.

A local routing marker cannot fence an offline old client. Stop legacy sync on old clients and migrate them before editing again. Do not run independently evolving copies of the same workspace against different providers. This implementation does not write a destructive marker to the old server or revoke existing devices.

## Format and publication protocol

```text
vaults/<vault-id>/manifest.json       versioned envelope: format=1, vault ID, SHA-256 inventory, tombstones
vaults/<vault-id>/pages/<page-id>.json
vaults/<vault-id>/databases/<kind>/<encoded-record-id>.json
vaults/<vault-id>/files/<sha-prefix>/<sha256>
vaults/<vault-id>/files/<sha-prefix>/<sha256>.json
vaults/<vault-id>/kv/<allowlisted-user-data>.json
vaults/<vault-id>/conflicts/<uuid>.json
```

Canonical JSON sorts object keys through serde_json's ordered maps, preserves array order, ProseMirror JSON/legacy HTML, arbitrary document attributes, RTL, layout widths/direction, record metadata and stable page/record IDs. Layout validation forbids nested groups and requires two or three columns. Unknown node types retain their bytes/attributes and are protected by the frontend's actual schema validator. No per-block storage or CRDT is introduced. Assets verify their filename against SHA-256 bytes. GIF bytes are never recompressed by the existing image pipeline.

The provider-neutral `SnapshotProvider` contract supplies capabilities, pinned reads, opaque revisions, immutable candidate staging, publication and publication-outcome checks. `provider::synchronize` owns the durable checkpoint/outbox/retry reconciliation. GitHub implements that contract using Git Database REST APIs:

- Verify stable repo ID, owner ID, active token account and private/non-archived status before work and again before publishing.
- Pin head H. Download one bounded tarball of H, never extract it to disk, validate file kinds/path allowlist, manifest completeness and hashes. No recursive-tree truncation or Contents API 1,000-entry assumption. A verified unchanged-head checkpoint avoids downloading the archive on ordinary polls.
- Compare base/local/remote bytes. Independent pages merge automatically; individual page/kv metadata keys merge independently; each document body, array and database record is indivisible. Concurrent changes create an unbounded full three-version conflict archive with all metadata. The UI offers explicit version selection, retaining the original entity ID. Database delete/edit conflicts retain full preimages and offer keeping deletion or explicitly restoring a record. No duplicate database row IDs or line merge is used.
- Build blobs and incremental tree batches on H's base tree, preserving all unknown Git paths. Ordinary small JSON pages are inline in batched tree calls. Binary/large files use blob calls. One commit has exactly parent H. Persist the candidate commit, before and after snapshots **before** updating the ref with `force:false`. This is fast-forward publication, not an expected-SHA CAS endpoint. A competing head triggers reread/reconcile; no force push or merge commit can overwrite its changes.
- An unknown publication result stays pending. Recovery checks equality/ancestry; a still-unmoved parent can retry the same candidate. A successful published candidate is reconciled with any subsequent local edits before advancing the base. Base state and remote revision are one atomic checkpoint. Corrupt state/journals fail closed.
- Local snapshot application uses a durable redo journal, validates all file preconditions before replay and shares the vault mutex with writers. An edit made during network I/O prevents overwrite; the next run recovers/reconciles the pending publication.

Every local deletion must emit an explicit durable tombstone. Missing/unreadable inventories never authorize deletion. Failed reads do not seed a welcome document. Unsupported or malformed files stop sync, retaining the original. Symlinks, traversal, case-colliding paths and Windows reserved names are rejected. Only explicit user-data paths upload; credentials, journals, history, operation/runtime caches, device IDs, local paths, logs, temp files and `.git` do not. Autosave/database history stays local and is included in full backups; published states remain in Git history; full conflict archives sync until resolved.

Trash retains soft-deleted pages for **7 days**. Permanent page deletion records a contentless tombstone, removes the current page and local restore/history paths, and cannot be undone through the conflict UI. It removes the page/conflict content from the current Git snapshot on the next successful publication. Older Git commits, migration backups and offline devices may still contain the earlier bytes. No history rewriting or physical-erasure promise is made.

## Timing, limits and privacy

Default quiet period is 15 seconds with a 120-second maximum under continuous edits. The UI allows 15/30/60 seconds. Remote checks default to 120 seconds and allow 5/15 minutes. GitHub uses no legacy long poll. Local saves do not wait on HTTP. Writes are paced, rate-limit/Retry-After delays are surfaced and honored (including manual retry), and transient failures back off with jitter. GitHub can impose lower secondary/hourly creation limits; a large initial upload may need successive retry windows, retaining the local data throughout.

Implementation safety bounds are **95 MiB per raw file** (below GitHub's 100 MiB Git object limit) and **512 MiB per in-memory snapshot/archive/backup**. These are technical bounds, not a user-approved 20 MiB attachment policy. Larger inputs produce an explicit unsynced error and remain local. Full archives and base/outbox snapshots use memory and local storage; this is a bounded direct-Git implementation, not LFS. Very large repositories need a streaming/checkpoint format extension before raising these limits. No 10k-vault benchmark or live GitHub authorization result is implied by unit tests.

All appearance, reader/sidebar/page-width, drawing library, calendar/map, gateway URL and personal-view preferences use an explicit shared allowlist. Study schedules/logs, saved searches and task inbox travel as user kv. Derived force-graph layouts remain a device-local cache. Local cache writes compare their loaded baseline with the current durable value; concurrent versions are merged or fully archived rather than blindly replacing changes received during HTTP work. Gateway tokens, device IDs, current page/cursor, browser directory handles and per-device backup/runtime settings stay local. Background images remain content-addressed assets. A remote preference change refreshes settings immediately; controls that already require reload (for example calendar week start) keep that behavior. The upload path never scans arbitrary localStorage.

Referenced drawing/preview/database-cell/background assets are checked before publication; bytes previously moved to local attachment trash are hash-verified and recovered. An asset tombstone cannot break a reference that remains in the merged snapshot. Asset garbage collection (including expiry of attachment trash) is conservatively disabled until a complete reference index covers database records, all local history, conflicts and pending publications. This may retain unused files; it avoids deleting referenced assets. Manual file deletion remains an explicit operation. A stricter desktop CSP disallows arbitrary remote scripts while retaining the editor's bundled fonts, blob workers, inline styles and HTTPS assets/gateway calls.

Private GitHub repositories provide GitHub access control, **not end-to-end encryption**. Public forms, webhooks and remote/background jobs still require the existing database gateway; GitHub personal sync does not replace it.

## Server retirement gate

Do not stop or delete a live server merely because this branch builds. Complete App registration/build configuration; prove real sign-in/refresh/selected-repo creation and permissions; migrate an actual copy; verify content hashes and roundtrip on a second device; resolve conflicts; validate a full restore; pause all old clients; retain independent backups. Inventory gateway features and keep that service if public forms/webhooks/jobs are in use. Only after those steps can the old personal sync server/S3 service be retired with the user's approval. No live service was stopped by this implementation.

## Validation evidence

See [the validation record](github-sync-validation.md) for commands, counts, mocked UI coverage and the remaining live-account/multi-device verification gate. CI now runs the app and Rust suites on Windows, macOS and Linux; those hosted jobs have not run until this branch is pushed/reviewed.
