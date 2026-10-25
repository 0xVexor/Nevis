// Receiving file contents. A blob is named by its SHA-256 and is uploaded before the commit that points at it,
// possibly in several pieces (Content-Range) so that a connection that dies halfway costs only the missing part.
// Nothing is visible to other devices until `commit` names the blob, and a blob is only recorded once the server
// has re-computed its hash and found it equal to the name it was uploaded under.

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from './vaults.js'
import { blobKey } from './storage.js'

const HEX64 = /^[0-9a-f]{64}$/

export const usedBytes = (db, userId) =>
  db.prepare('SELECT COALESCE(SUM(b.size), 0) AS n FROM blobs b JOIN vaults v ON v.id = b.vault_id WHERE v.user_id = ?').get(userId).n

export const blobRow = (db, vaultId, sha) => db.prepare('SELECT * FROM blobs WHERE vault_id = ? AND sha256 = ?').get(vaultId, sha)

const stagingFile = (cfg, vaultId, sha) => path.join(cfg.dataDir, 'staging', `${vaultId}_${sha}`)

/** How many bytes of a half-uploaded blob the server already holds (0 when none). */
export async function receivedBytes(cfg, vaultId, sha) {
  try {
    return (await stat(stagingFile(cfg, vaultId, sha))).size
  } catch {
    return 0
  }
}

/**
 * Stores one piece of a blob. `range` is `{ start, end, total }` (inclusive end) or null for the whole body.
 * Returns `{ complete: true, size, md5 }` or `{ complete: false, received }`.
 */
export async function receiveBlob({ db, storage, cfg, user, vault, sha, range, body, now = Date.now() }) {
  if (!HEX64.test(sha)) throw new HttpError(400, 'bad_sha')
  const have = blobRow(db, vault.id, sha)
  if (have) return { complete: true, size: have.size, md5: have.md5, existed: true }

  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
  const r = range ?? { start: 0, end: buf.length - 1, total: buf.length }
  if (r.end - r.start + 1 !== buf.length || r.start < 0 || r.end < r.start) throw new HttpError(400, 'bad_range')
  if (r.total > cfg.maxBlobBytes) throw new HttpError(413, 'too_large', { limit: cfg.maxBlobBytes })
  if (r.total === 0 && sha !== createHash('sha256').update('').digest('hex')) throw new HttpError(422, 'hash_mismatch')
  if (usedBytes(db, user.id) + r.total > cfg.quotaBytes) throw new HttpError(507, 'quota_exceeded', { limit: cfg.quotaBytes })

  const file = stagingFile(cfg, vault.id, sha)
  await mkdir(path.dirname(file), { recursive: true })
  if (r.start === 0) await writeFile(file, buf)
  else {
    const size = await receivedBytes(cfg, vault.id, sha)
    if (size < r.start) throw new HttpError(409, 'out_of_order', { received: size })
    if (size > r.start) await truncate(file, r.start) // a piece that was sent again: the file is cut back to where it begins
    await appendFile(file, buf)
  }
  if (r.end + 1 < r.total) return { complete: false, received: r.end + 1 }

  const all = await readFile(file)
  if (all.length !== r.total) {
    await rm(file, { force: true })
    throw new HttpError(422, 'size_mismatch')
  }
  const sum = createHash('sha256').update(all).digest('hex')
  if (sum !== sha) {
    await rm(file, { force: true })
    throw new HttpError(422, 'hash_mismatch')
  }
  const md5 = createHash('md5').update(all).digest('hex')
  await storage.put(blobKey(vault.id, sha), all) // only now does the blob exist for the server
  db.prepare('INSERT OR IGNORE INTO blobs (vault_id, sha256, md5, size, created_at) VALUES (?, ?, ?, ?, ?)').run(vault.id, sha, md5, all.length, now)
  await rm(file, { force: true })
  return { complete: true, size: all.length, md5 }
}

/** Half-uploaded files nobody finished within a day. */
export async function sweepStaging(cfg, now = Date.now(), maxAgeMs = 24 * 3600 * 1000) {
  const dir = path.join(cfg.dataDir, 'staging')
  let n = 0
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const f = path.join(dir, name)
    try {
      if (now - (await stat(f)).mtimeMs > maxAgeMs) {
        await rm(f, { force: true })
        n++
      }
    } catch {
      // gone already
    }
  }
  return n
}
