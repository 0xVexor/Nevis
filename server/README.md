# Nevis sync server

The server behind Nevis's sync between devices. A change saved on one device reaches the others in about a second; only what changed travels; a lost connection costs time, never data.

- **Accounts without email or phone**: a user name, a password and a recovery key shown once. An invite code, if you want one.
- **Revisions and compare-and-swap**: every path has a `rev`; a write names the rev it was based on, and the server refuses it if the path moved on. Two devices never overwrite each other silently.
- **Files by hash**: contents are uploaded first as blobs named by their SHA-256 (resumable in pieces), then a small commit points at them. A connection that dies halfway leaves nothing half-written.
- **Instant**: a device holds one request open (a "long poll", `GET /v1/vaults/:id/state?since=N&wait=25`); the server answers the moment another device commits. It works through any proxy that lets HTTPS through.
- **One binary, one folder**: written in Go, no cgo, no database server. File contents live in `DATA_DIR/blobs`; everything else is one SQLite file (`DATA_DIR/nevis.db`, WAL mode) that is copied to `DATA_DIR/backup/` a few seconds after each change.

The client is the desktop app (`src-tauri/src/sync/hub.rs` there is this server as a `Remote` of its sync engine). The design, with every rule and edge case, is in ADR-0004 (`docs/adr/0004-sync-server.md`).

The server speaks plain HTTP. TLS, and the certificate, are the job of a reverse proxy (see [Deploy](#deploy-on-a-personal-linux-server)). The desktop app only accepts plain `http://` for a server on the same computer, so any other server needs HTTPS.

## Run it locally

Go 1.26 or newer is needed (the version in `go.mod`).

```bash
cd server
export SESSION_SECRET=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')   # any random string of 32+ characters
REGISTRATION=open POW_BITS=12 DATA_DIR=./data PORT=3000 go run ./cmd/nevis-server
```

On Windows PowerShell, set the variables with `$env:REGISTRATION = "open"` and so on before `go run`.

Then point the app at it: **Sync button → Server** and type `http://localhost:3000`.

```bash
go run ./cmd/smoke http://localhost:3000   # a client's day against the running server, with timings
go test ./...                              # the tests; no network and no running server needed
go test -race ./...                        # the same with the race detector (needs a C compiler)
```

`go test -race` is what CI runs. The race detector needs cgo and a C compiler on the machine; the server itself does not.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_SECRET` | *(required, 32+ characters)* | Signs the sign-up challenges. Any random string; changing it only invalidates challenges in flight. |
| `REGISTRATION` | `invite` | `open`, `invite` (needs `INVITE_CODES`) or `closed`. |
| `INVITE_CODES` | | `code1,code2:5`: a code, optionally limited to that many accounts. |
| `LISTEN_HOST` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` when a reverse proxy on the same machine is the only client. |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | The database, the blobs (`blobs/`), half-finished uploads (`staging/`), backups (`backup/`) and the lock file. |
| `QUOTA_MB` | `1024` | Storage per account. |
| `MAX_BLOB_MB` | `64` | Largest single file. |
| `MAX_VAULTS` | `20` | Vaults per account. |
| `RETENTION_DAYS` | `30` | How long deleted files, old revisions, trashed vaults and deleted accounts are kept. |
| `REGISTER_PER_HOUR` | `30` | New accounts per hour from one network address (mobile networks put many people behind one address). |
| `POW_BITS` | `18` | Difficulty of the sign-up proof of work (a few hundred ms on a laptop). `0` turns it off. |
| `BACKUP_DELAY_SEC` | `20` | How soon after the last write the database is copied to `DATA_DIR/backup/`. |
| `BACKUP_KEEP` | `24` | How many copies are kept; the oldest are deleted. |
| `INSTANCE_LOCK` | on | `off` skips the lock file that keeps a second server away from the same `DATA_DIR`. |
| `TRUST_PROXY` | *(nobody)* | Whose `X-Forwarded-For` header is believed: a comma separated list of addresses and networks, or the word `loopback`. See below. |

`TRUST_PROXY` matters because the rate limits (sign-ups, sign-ins, wrong passwords) are counted per client address. Behind a reverse proxy every request comes from the proxy, so without it all users share one allowance. With it, the address is read from `X-Forwarded-For`, from the right, skipping trusted hops. Leave it empty when the server is reachable directly: otherwise anyone could name their own address. Examples: `TRUST_PROXY=loopback` (Caddy or nginx on the same machine), `TRUST_PROXY=10.0.0.0/8,192.168.1.7`.

The S3 and Liara settings of the earlier Node.js server (`STORAGE`, `S3_*`) are gone; `NODE_ENV` and other variables of earlier setups are ignored.

## Deploy on a personal Linux server

### 1. Build

On the server, or on any machine (the build needs no C compiler, so it cross-compiles from Windows and macOS too):

```bash
cd server
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o nevis-server ./cmd/nevis-server
```

Copy `nevis-server` to the server, for example to `/opt/nevis/nevis-server`.

### 2. Run it with systemd

Create a user and the data folder, and keep the settings in a file only that user and root can read:

```bash
sudo useradd --system --home /var/lib/nevis --shell /usr/sbin/nologin nevis
sudo install -d -o nevis -g nevis -m 750 /var/lib/nevis
sudo install -m 640 -o root -g nevis /dev/null /etc/nevis-server.env
```

`/etc/nevis-server.env`:

```ini
SESSION_SECRET=<32 or more random characters: openssl rand -hex 24>
REGISTRATION=invite
INVITE_CODES=first-invite:1,friends:20
LISTEN_HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/nevis
TRUST_PROXY=loopback
```

`/etc/systemd/system/nevis-server.service`:

```ini
[Unit]
Description=Nevis sync server
After=network.target

[Service]
User=nevis
Group=nevis
EnvironmentFile=/etc/nevis-server.env
ExecStart=/opt/nevis/nevis-server
Restart=on-failure
# on stop the server answers the long polls that are open (up to 30 s), finishes running requests and takes a last backup
TimeoutStopSec=60
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/nevis

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nevis-server
journalctl -u nevis-server -f
```

### 3. TLS with Caddy

Caddy gets and renews the certificate by itself. `/etc/caddy/Caddyfile`:

```
sync.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Point the DNS name at the server, open ports 80 and 443, and reload Caddy. Caddy sends `X-Forwarded-For`, which `TRUST_PROXY=loopback` makes the server believe. Then check everything from your own computer:

```bash
go run ./cmd/smoke https://sync.example.com <invite code>
```

With nginx instead, keep in mind that its default `client_max_body_size` is 1 MB while a single upload request can be 2 MB (the app sends bigger files in 1 MB pieces, and the server accepts up to 16 MB per request). Set at least:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
    proxy_read_timeout 70s;        # long polls are held up to 30 s
    client_max_body_size 20m;
}
```

### 4. Backups and restore

- **What is backed up.** `DATA_DIR/backup/nevis-<UTC time>.db`: a whole, consistent copy of the database, made with SQLite's `VACUUM INTO` while the server keeps running, `BACKUP_DELAY_SEC` after the last write and once more when the server stops. The newest `BACKUP_KEEP` copies stay.
- **Backups on the same disk are not enough.** Copy `DATA_DIR/backup/` and `DATA_DIR/blobs/` somewhere else on a schedule, for example with `rsync -a /var/lib/nevis/backup /var/lib/nevis/blobs backup-host:nevis/`. Blobs are never changed after they are written, so copying them while the server runs is safe. Without the blobs a restored database knows files it cannot serve.
- **Restore.** Stop the service, put `blobs/` back, then either
  - `sudo -u nevis env DATA_DIR=/var/lib/nevis /opt/nevis/nevis-server restore` (the newest copy; or give a file: `... restore /path/to/nevis-20261025T102000Z.db`), or
  - delete `nevis.db`, `nevis.db-wal` and `nevis.db-shm` and start the server: with no database and a copy in `backup/`, it restores the newest one by itself.

  Either way **every vault gets a new epoch**. Devices notice, start over from what they hold (adding files, never deleting any), so whatever the copy was too old to know is put back by the devices. It costs one slower sync, not data. `restore` refuses to run while the server runs.
- **Upgrade.** Build the new binary, copy it next to the old one, `sudo systemctl stop nevis-server` (the last backup is taken), replace the binary, `sudo systemctl start nevis-server`. The database tables are created if missing; this version has no schema migrations to run. Keep the previous binary until the smoke check passes.
- **One server per `DATA_DIR`.** The server serializes writes inside one process, so a second one would hand out the same sequence numbers. A lock file (`DATA_DIR/nevis.lock`, held with an operating system lock that is released when the process ends, however it ends) makes a second server refuse to start. Do not run a second copy of the service against the same folder, and keep `INSTANCE_LOCK` on.

## Operating it

- **Logs** are JSON lines on stdout (method, path, status, duration; never the `Authorization` header, the query string, contents or passwords).
- **Housekeeping** runs hourly (the first run a minute after start): tombstones, old revisions, trashed vaults and deleted accounts older than `RETENTION_DAYS` are removed, blobs nothing refers to after a day, half-finished uploads after a day, answers to repeated commits after a week.
- **Registration**: with `REGISTRATION=invite`, hand out codes like `INVITE_CODES=ali-2026:1,friends:20`. Used codes are counted in the database; to add a code, add it to the variable and restart.
- **A full disk** makes uploads fail with a `5xx`; clients keep their work and retry.

## Wire protocol (all under `/v1`, JSON unless noted)

The protocol is the one of the earlier Node.js server, unchanged, so existing clients keep working. A few identifiers still carry the old product name because the client checks them: `/v1/health` answers `"name": "nevis-sync"`, the client sends its version in `X-Noviq-Api` (this server also reads `X-Nevis-Api`, and answers with both), and the vault marker path is `.nevis/vault.json`.

| | |
|---|---|
| `GET /v1/health` · `GET /v1/auth/challenge` | public: what the server is (`name`, `api`, `min_api`, `registration`, `pow_bits`, `capabilities`, `server_time`), a sign-up challenge (`challenge`, `bits`) |
| `POST /v1/auth/register` · `/auth/login` · `/auth/recover` | public: create an account, sign in, reset the password with the recovery key |
| `POST /v1/auth/logout` · `/auth/password` · `/auth/recovery-key` · `GET /v1/account` · `DELETE /v1/account` · `DELETE /v1/devices/:id` | the account |
| `GET/POST /v1/vaults` · `PATCH/DELETE /v1/vaults/:id` · `POST /v1/vaults/:id/undelete` | vaults (delete = trash for `RETENTION_DAYS`; `GET /v1/vaults?trashed=1` lists the trash) |
| `POST /v1/vaults/:id/purge` | `{ password }` → `{ ok, files, bytes }`: removes a vault that is already in the trash for good, freeing its quota; the password is re-checked and counted like on account deletion (`401 bad_credentials`, `429`); `409 not_in_trash` for a live vault, `404 no_such_vault` otherwise |
| `GET /v1/vaults/:id/state?since=&wait=` | state (`epoch`, `seq`, `compacted`, `files`, `root`); with `since` and `wait` (seconds, at most 30) it waits for news |
| `GET /v1/vaults/:id/changes?since=&limit=` | what changed after a rev, oldest first (`head`, `next`, `has_more`, `files`); `410` when `since` is older than the server remembers; with `snapshot=1` (and `after=<path>`) it instead returns the live files only, in path order, `limit` at a time (`seq`, `has_more`, `next_after`, `files`), ignores `since` and never answers `410`: a client keeps the `seq` of the first page as its cursor and reads on with `since=` |
| `GET /v1/vaults/:id/file?path=` | one path as it is now |
| `HEAD/PUT/GET /v1/vaults/:id/blobs/:sha256` | contents by hash; `PUT` with `Content-Range: bytes a-b/total` resumes |
| `GET /v1/vaults/:id/rev/:rev` | the content of one revision |
| `POST /v1/vaults/:id/commit` | `{ op_id, atomic?, confirm_bulk?, ops: [{ op: put\|delete, path, base_rev, sha256? }] }` → `{ results, seq, server_time }`, one result per op (`ok`, or `conflict` with the current state) |
| `POST /v1/vaults/:id/restore` · `GET /v1/vaults/:id/revisions?path=` | put an older revision back; list the revisions of a path |

Everything except the public routes needs `Authorization: Bearer <device token>` (tokens look like `nvs_...` and only their hash is stored). Every response carries `Cache-Control: no-store`.

- **Sign-up and recovery** carry a proof of work: take `challenge` and `bits` from `/auth/challenge`, find a `counter` so that SHA-256 of `"<challenge>:<counter>"` starts with `bits` zero bits, and send both. A challenge is valid for 10 minutes and once. Registration body: `{ username, password, device_name, invite?, challenge, counter }` → `201 { user, token, device, recovery_key }`. User names are `[a-z0-9][a-z0-9_.-]{2,31}` (case does not matter), passwords need 8 characters.
- **Sign-in** `{ username, password, device_name }` → `{ user, token, device, restored }` (`restored: true` when it brought back an account that was waiting to be deleted). Ten wrong passwords for a user name, or a hundred from one address, block further attempts for 15 minutes (`429`). Wrong recovery keys count the same way.
- **Blob upload.** `PUT` the bytes with `Content-Type: application/octet-stream`. Without `Content-Range` the body is the whole file; with it, one piece. Answers: `201` stored, `200` already there, `202` piece accepted (`received` says how far the server has got), `409 out_of_order` (a piece beyond what the server holds; `received` says where to resume), `413 too_large`, `422 hash_mismatch` or `422 size_mismatch` (nothing is kept), `507 quota_exceeded`. `HEAD` answers `200` with `X-Size` and `X-Md5`, or `404` with `X-Received`. A request body is at most 16 MB.
- **Commit.** A write names the rev it was based on (`base_rev`, `0` for a new path). A result is `{ ok: true, rev, sha256, md5, size, deleted, server_time }`, `{ ok: true, noop: true, ... }` when nothing changed, or `{ ok: false, error, ... }`: `conflict` (with `current`), `blob_missing`, `bad_sha`, `bad_path` (with `detail`), `path_case_clash`, `bulk_delete`, `bad_op`, `not_applied` (atomic commits). Deleting more than `max(5, 20% of the live files)` in one commit is refused as `bulk_delete` unless `confirm_bulk` is `true`. The same `op_id` (8 to 80 characters) always gets the same answer, marked `replay: true`.
- **Paths** may live under `pages/`, `files/`, `history/`, `kv/`, `.trash/` and `databases/<kind>/<name>.json`, plus the marker `.nevis/vault.json`. No traversal, no absolute paths, no Windows-reserved names or characters, NFC normalized, at most 240 UTF-16 units; two paths that differ only in letter case count as one.
- **Epoch.** Each vault has an `epoch` that changes when the server is restored from a backup. A client that sees another epoch starts over from what it holds.

Errors are `{ "error": "<code>" }` with a fitting status: `400 bad_request`, `401 unauthorized` / `bad_credentials`, `403`, `404 no_such_vault` (also for someone else's vault), `409`, `410 since_too_old`, `413 too_large`, `422`, `426 upgrade_required`, `429 rate_limited` (with `Retry-After`), `507 quota_exceeded`.

## Code

```
cmd/nevis-server   the server, and `nevis-server restore`
cmd/smoke          a client's day against a running server
internal/config    environment variables
internal/db        SQLite (WAL), online backups, restore, epochs
internal/auth      passwords, tokens, recovery keys, proof of work, rate limiter, accounts
internal/storage   blobs on disk, the lock file
internal/vaults    vaults, revisions, commits, blob receiving, housekeeping
internal/hub       long-poll notification
internal/api       HTTP handlers
```

Dependencies are kept small: `modernc.org/sqlite` (SQLite in pure Go, so no cgo and no C compiler is needed to build); `golang.org/x/crypto` for scrypt (not in the standard library); `golang.org/x/text` for Unicode normalization (NFKC for passwords, NFC checks for paths; not in the standard library); `golang.org/x/sys` for the Windows lock file (`LockFileEx`), already required by the SQLite driver. Everything else is the standard library: `net/http` with the Go 1.22 mux patterns, `log/slog`, `crypto/*`.

CI (`.github/workflows/ci.yml`, job `server`) runs `go vet`, a `gofmt` check and `go test -race ./...` on pull requests that touch `server/` and on pushes to `main` and `dev`.
