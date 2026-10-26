# Nevis database gateway

Optional, single-instance reference service for the Nevis database feature (handoff §24–26). A Vault never needs it: without a gateway every
database works locally, and the app says so ("needs setup") instead of showing controls that do nothing.

What it does today (private-publication mode):

| Capability | Endpoints | State |
|---|---|---|
| Publish a form (redacted projection, versioned, revocable) | `POST/PUT/DELETE/GET /v1/publications[/:id]` | implemented, tested over HTTP |
| Public form + validated submissions (same validator as the desktop) | `GET /v1/forms/:publicId`, `POST /v1/forms/:publicId/submissions`, `GET /v1/submissions/:receipt` | implemented, tested |
| Owner inbox with leases and acknowledgments | `GET /v1/inbox`, `POST /v1/inbox/:id/ack` | implemented, tested (incl. lost ack) |
| Outbound messages (webhooks): idempotency keys, backoff 1s/5s/30s/5m, max 5 attempts, SSRF guard, uncertain outcomes held for review | `POST/GET /v1/outbox` | implemented, tested with a stub receiver |
| Scheduled jobs: UTC occurrence ids, IANA zones/DST, lease takeover, pause, stale-context pause | `POST /v1/jobs`, `GET /v1/jobs/:id/runs`, `POST /v1/jobs/:id/pause`, `POST /v1/jobs/:id/touch` | implemented, tested |
| Provider reads (connected properties, imported sources) using credentials kept on the gateway | `POST /v1/providers/retrieve`, `POST /v1/providers/pull` | implemented, tested with stubbed providers |

## What is not done (said plainly)

* **Shared-workspace mode** (server-authoritative records, grants, change feeds): every `/v1/workspaces/*` endpoint answers `501 unsupported`.
  `GET /v1/capabilities` reports `sharedWorkspace: "unsupported"`.
* **Identity provider sign-in** (OIDC discovery + authorization code with PKCE, signed sessions): not implemented. Owner calls use an API token
  (`Authorization: Bearer`, only its SHA-256 is stored). Do not put this service in front of several different people.
* **File uploads on public forms**: not implemented; publishing a form that has a file question is refused (`422 unsupported_question`).
* **Nothing here has been deployed or tested against real recipients, real providers or a real identity provider.** See
  `docs/database-requirements-ledger.md` for the per-feature `externalVerification` field.

## Run it locally

Needs Node 24 or newer (`node:sqlite`, type stripping). No dependencies to install.

```bash
cd services/database-gateway
GATEWAY_DEV=1 GATEWAY_PORT=8787 node src/main.ts
```

With `GATEWAY_DEV=1` (loopback address only) and no `GATEWAY_OWNER_TOKEN`, a throwaway owner token is printed once and not saved anywhere.
In the app: Settings → Database → set the gateway address `http://127.0.0.1:8787` and that token, then **Check connection**.

## Production-style run

1. Copy `.env.example` to `.env`, set `GATEWAY_OWNER_TOKEN` (32+ random characters), `GATEWAY_PUBLIC_URL`, `GATEWAY_DB` (back this file up).
2. Put the gateway behind an HTTPS reverse proxy; bind `GATEWAY_HOST=127.0.0.1`; set `GATEWAY_TRUST_PROXY=1` only if your proxy sets `X-Forwarded-For`.
3. Optional: `GATEWAY_WEBHOOK_ALLOWLIST=hooks.example.com`, and a `GATEWAY_CONNECTIONS_FILE` such as
   `{ "work": { "token": "<provider access token>" }, "slack": { "headers": { "Authorization": "Bearer …" } } }`. Keep that file out of the Vault and out of git.
4. `node --env-file=.env src/main.ts`

Revoking an owner token: set `revoked_at` on its row in `tokens` (hash only is stored) and restart with a new `GATEWAY_OWNER_TOKEN`.

## Behavior worth knowing

* A public submission is answered `201 pending_import`. It becomes a database row only after the owner's app pulls it from the inbox, applies it
  with its own revision guards and acknowledges. If the form no longer fits, the submission stays on the gateway as `rejected` with the reason.
* Same `submissionId` and same content returns the same receipt; different content with the same id is `409`.
* Submissions to an older form version are validated against that version for 7 days, then answered `409 refresh_required`.
* Anonymous forms store no network address, user agent or identity; receipts are random capabilities.
* Request bodies are limited (default 1 MB), form posts are rate limited per form and client address.
* Webhooks: https only (http loopback in dev), no redirects, no private/loopback/link-local targets (checked after DNS resolution), optional host allowlist,
  credentials only from the connections file. A timeout or broken connection after sending is `needs_review` unless the request says it is idempotent.

## Tests

```bash
cd services/database-gateway && npm test
```

The desktop client is covered end-to-end against this exact code in `db/tests/database/gateway-client.test.mjs`.
