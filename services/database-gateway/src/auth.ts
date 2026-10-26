// Owner authentication by API token (Authorization: Bearer). Only the SHA-256 of a token is stored. Owner calls carry the token in a header,
// never in a cookie, so they are not exposed to CSRF. Standards-based identity (OIDC authorization code + PKCE) is NOT implemented here:
// see README "What is not done". Public form endpoints need no login and are rate limited instead.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Db } from './db.ts'
import { HttpError, type Req } from './http.ts'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

/** Make sure the configured owner token exists (hash only). Returns the owner id. */
export function ensureOwner(db: Db, token: string): string {
  const hash = sha256(token)
  const row = db.prepare('SELECT id, revoked_at FROM tokens WHERE hash = ?').get(hash) as { id: string; revoked_at: number | null } | undefined
  if (row) {
    if (row.revoked_at !== null) throw new Error('the configured owner token was revoked; choose a new one')
    return row.id
  }
  const id = randomUUID()
  db.prepare('INSERT INTO tokens (id, hash, role, created_at) VALUES (?, ?, ?, ?)').run(id, hash, 'owner', Date.now())
  return id
}

export function requireOwner(db: Db, req: Req): string {
  const h = String(req.headers.authorization ?? '')
  const m = /^Bearer\s+(\S{16,512})$/.exec(h)
  if (!m) throw new HttpError(401, 'unauthorized', 'owner token required', undefined, { 'www-authenticate': 'Bearer' })
  const row = db.prepare('SELECT id FROM tokens WHERE hash = ? AND revoked_at IS NULL AND role = ?').get(sha256(m[1]), 'owner') as { id: string } | undefined
  if (!row) throw new HttpError(401, 'unauthorized', 'owner token not recognised', undefined, { 'www-authenticate': 'Bearer' })
  return row.id
}
