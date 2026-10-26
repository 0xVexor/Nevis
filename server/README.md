# Nevis sync server

The server behind Nevis's sync between devices. A change saved on one device reaches the others in about a second; only what changed travels; a lost connection costs time, never data.

- **Accounts without email or phone**: a user name, a password and a recovery key. An invite code, if you want one.
- **Revisions and compare-and-swap**: every path has a `rev`; a write names the rev it was based on, and the server refuses it if the path moved on. Two devices never overwrite each other silently.
- **Files by hash**: contents are uploaded first as blobs named by their SHA-256 (resumable in pieces), then a small commit points at them. A connection that dies halfway leaves nothing half-written.
- **Instant**: a device holds one request open ("long poll", `GET /v1/vaults/:id/state?since=N&wait=25`); the server answers the moment another device commits. It works through any proxy that lets HTTPS through.
- **Storage**: file contents in S3 (any S3-compatible store), everything else in one SQLite file that is copied to the same storage a few seconds after each change. Node 22.13+ and two pure-JS dependencies (`fastify`, `@aws-sdk/client-s3`): nothing native to compile.

The client is in `spike/tiptap/src-tauri/src/sync/` (`hub.rs` is this server as a `Remote` of the sync engine). The design, with every rule and edge case, is in [ADR-0004](../docs/adr/0004-sync-server.md).

## Run it locally

```bash
cd server
npm install
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") \
REGISTRATION=open POW_BITS=12 STORAGE=disk DATA_DIR=./data PORT=3000 npm start
```

`STORAGE=disk` keeps blobs in `DATA_DIR/blobs`, so no S3 account is needed for development. Then point the app at it: **Sync button → Server** and type `http://localhost:3000` (plain `http://` is only accepted for this computer).

```bash
node scripts/smoke.mjs http://localhost:3000   # a client's day against the running server, with timings
node scripts/inspect.mjs http://localhost:3000 <user> <password>   # what the server really holds for an account
npm test                                       # the tests, no network needed
```

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_SECRET` | *(required, 32+ characters)* | Signs the sign-up challenges. Any random string; changing it only invalidates challenges in flight. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | The object storage. Setting `S3_BUCKET` selects `STORAGE=s3`. |
| `S3_REGION` | `us-east-1` | Whatever your provider expects. |
| `S3_PATH_STYLE` | `true` | Set `false` for virtual-hosted style addressing. |
| `STORAGE` | `s3` if `S3_BUCKET` is set, else `disk` | `s3`, `disk` or `memory` (tests). |
| `REGISTRATION` | `invite` | `open`, `invite` (needs `INVITE_CODES`) or `closed`. |
| `INVITE_CODES` | | `code1,code2:5`: a code, optionally limited to that many accounts. |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | The SQLite file, staging of half-uploaded blobs, and (disk storage) the blobs. |
| `QUOTA_MB` | `1024` | Storage per account. |
| `MAX_BLOB_MB` | `64` | Largest single file. |
| `MAX_VAULTS` | `20` | Vaults per account. |
| `RETENTION_DAYS` | `30` | How long deleted files, old revisions, trashed vaults and deleted accounts are kept. |
| `REGISTER_PER_HOUR` | `30` | New accounts per hour from one network address (mobile networks put many people behind one address). |
| `POW_BITS` | `18` | Difficulty of the sign-up proof of work (a few hundred ms on a laptop). `0` turns it off. |
| `BACKUP_DELAY_SEC` | `20` | How soon after the last write the database is copied to the storage. |
| `INSTANCE_LOCK` | on | `off` skips the one-instance heartbeat. For development only: a server that was killed leaves its lock for 30 seconds. |

`GOOGLE_CLIENT_ID` and other variables of earlier setups are ignored.

## Deploy on Liara

1. Create a **Node.js** app. Node 22.13 or newer (`engines` in `package.json`); the start command is `npm start`; the port is `3000`.
2. **Number of instances: 1.** The server serializes writes inside one process; two instances would not see each other's commits. A heartbeat in the bucket (`_lock/instance.json`) makes a second instance refuse to start (a stopping one is given up to 35 seconds to let go, so a rolling deploy works).
3. Create an **object storage** bucket and a key pair in the Liara panel (*Cloud storage → Keys*).
4. Set the environment variables: `S3_ENDPOINT` (for example `https://storage.c2.liara.site`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SESSION_SECRET`, `REGISTRATION`, `INVITE_CODES`, `NODE_ENV=production`.
5. **Optional but recommended: attach a persistent disk** and mount it at `/data`, then set `DATA_DIR=/data`. Without it the database file lives in the container, is copied to S3 a few seconds after each change and when the app is stopped, and is restored from that copy on the next start. That works, but a restore from a copy that is a few seconds old gives every vault a new *epoch*: devices then start over from what they hold (adding, never deleting), so nothing is lost, it just costs one slower sync.
6. Attach your domain (the `CNAME` for `sync.example.com`, HTTPS certificate on). HTTP/2 is fine.
7. Check the storage from the deployed app's terminal, then the whole thing from your computer:

   ```bash
   npm run check                                  # writes, reads, lists and deletes one object in the bucket
   node scripts/smoke.mjs https://sync.example.com <invite code>
   ```

`liara.json` (optional, for `liara deploy`):

```json
{ "app": "noviq-sync", "platform": "node", "port": 3000, "disks": [{ "name": "data", "mountTo": "/data" }] }
```

Keep the S3 keys and `SESSION_SECRET` in the panel's environment variables only. If a key ever appears in a screenshot, a chat or a commit, create a new key pair and delete the old one.

## Operating it

- **Logs** are JSON lines on stdout (`authorization` headers are redacted; no note contents, no passwords).
- **Housekeeping** runs hourly: tombstones, old revisions, trashed vaults and deleted accounts older than `RETENTION_DAYS` are removed, blobs nothing refers to after a day, half-finished uploads after a day.
- **Backups**: `_backup/index-latest.db.gz` and 24 hourly copies in the storage. To restore by hand, download one, gunzip it to `DATA_DIR/noviq.db` and start the server with the file in place.
- **Registration**: with `REGISTRATION=invite`, hand out codes like `INVITE_CODES=ali-2026:1,friends:20`. Used codes are counted in the database; to add a code, add it to the variable and restart.
- **An unreachable or full storage** makes uploads fail with `502`/`507`; clients keep their work and retry.

## API (all under `/v1`, JSON unless noted)

| | |
|---|---|
| `GET /health` · `GET /auth/challenge` | public: what the server is, a sign-up challenge |
| `POST /auth/register` · `/auth/login` · `/auth/recover` | public: create an account, sign in, reset the password with the recovery key |
| `POST /auth/logout` · `/auth/password` · `/auth/recovery-key` · `GET /account` · `DELETE /account` · `DELETE /devices/:id` | the account |
| `GET/POST /vaults` · `PATCH/DELETE /vaults/:id` · `POST /vaults/:id/undelete` | vaults (delete = trash for 30 days) |
| `GET /vaults/:id/state?since=&wait=` | state (`epoch`, `seq`, `root`); with `since` and `wait` it waits for news |
| `GET /vaults/:id/changes?since=&limit=` | what changed after a rev, oldest first; `410` when `since` is older than the server remembers |
| `GET /vaults/:id/file?path=` | one path as it is now |
| `HEAD/PUT/GET /vaults/:id/blobs/:sha256` | contents by hash; `PUT` with `Content-Range: bytes a-b/total` resumes |
| `GET /vaults/:id/rev/:rev` | the content of one revision |
| `POST /vaults/:id/commit` | `{ op_id, atomic?, confirm_bulk?, ops: [{ op: put\|delete, path, base_rev, sha256? }] }` → one result per op (`ok`, or `conflict` with the current state) |
| `POST /vaults/:id/restore` · `GET /vaults/:id/revisions?path=` | put an older revision back; list the revisions of a path |

Errors are `{ "error": "<code>" }` with a fitting status: `401 unauthorized`, `404 no_such_vault` (also for someone else's vault), `410 since_too_old`, `422 hash_mismatch`, `426 upgrade_required`, `429 rate_limited` (with `Retry-After`), `507 quota_exceeded`.
