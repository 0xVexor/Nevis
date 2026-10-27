// Housekeeping, run every hour. Nothing here removes data a user could still want:
// deleted files, old revisions and trashed vaults are kept for `retentionDays` (30), unreferenced blobs for a day.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { sweepStaging, expireReservations } from './blobs.js'
import { tx } from './db.js'
import { maintenance } from './maintenance.js'
import { protectedBlobs } from './backup.js'
import { HttpError } from './vaults.js'
import { blobKey } from './storage.js'

const DAY = 24 * 3600 * 1000

/** Removes every blob of a vault from the storage; the rows go with the vault (or are deleted here). */
async function dropVaultBlobs(db, storage, vaultId) {
  for (const b of db.prepare('SELECT sha256 FROM blobs WHERE vault_id = ?').all(vaultId)) await storage.del(blobKey(vaultId, b.sha256))
  db.prepare('DELETE FROM blobs WHERE vault_id = ?').run(vaultId)
}

/** Removes a vault for good: its blobs from the storage, then its rows (files and revisions go with it). */
const activePurges = new WeakMap()
export async function purgeVault(db, storage, vaultId, before = Infinity) {
  let active = activePurges.get(db)
  if (!active) activePurges.set(db, active = new Set())
  if (active.has(vaultId)) throw new HttpError(409, 'vault_deleting')
  const current = db.prepare(`SELECT v.deleted_at, v.deleting, u.deleting AS account_deleting
    FROM vaults v JOIN users u ON u.id = v.user_id WHERE v.id = ?`).get(vaultId)
  if (!current) return false
  if (!current.deleting && !current.account_deleting && (current.deleted_at === null || current.deleted_at >= before)) return false
  // Persistent claim precedes the first asynchronous delete. After a crash a
  // later GC resumes the claim; restore and uploads cannot report success.
  db.prepare('UPDATE vaults SET deleting = 1 WHERE id = ?').run(vaultId)
  active.add(vaultId)
  try {
    await dropVaultBlobs(db, storage, vaultId)
    db.prepare('DELETE FROM ops WHERE vault_id = ?').run(vaultId)
    db.prepare('DELETE FROM vaults WHERE id = ?').run(vaultId)
    return true
  } finally { active.delete(vaultId) }
}

const collections = new WeakMap()
export function runGc(args) {
  const running = collections.get(args.db)
  if (running) return running
  const task = maintenance(args.db, () => collect(args)).finally(() => collections.delete(args.db))
  collections.set(args.db, task)
  return task
}

async function collect({ db, storage, cfg, now = Date.now() }) {
  const stats = { tombstones: 0, revisions: 0, blobs: 0, vaults: 0, users: 0, ops: 0, staging: 0 }
  const keep = now - cfg.retentionDays * DAY

  // a deleted file that every device has had 30 days to hear about is forgotten; devices older than that start over (see `compacted`)
  tx(db, () => {
    for (const v of db.prepare('SELECT DISTINCT vault_id FROM files WHERE deleted = 1 AND server_time < ?').all(keep)) {
      const top = db.prepare('SELECT MAX(rev) AS r FROM files WHERE vault_id = ? AND deleted = 1 AND server_time < ?').get(v.vault_id, keep).r
      const gone = db.prepare('DELETE FROM files WHERE vault_id = ? AND deleted = 1 AND server_time < ?').run(v.vault_id, keep)
      db.prepare('UPDATE vaults SET compacted = MAX(compacted, ?) WHERE id = ?').run(top, v.vault_id)
      stats.tombstones += gone.changes
    }
    // old revisions that are not the current one
    stats.revisions = db
      .prepare(
        `DELETE FROM revisions WHERE server_time < ? AND NOT EXISTS
           (SELECT 1 FROM files f WHERE f.vault_id = revisions.vault_id AND f.rev = revisions.rev)`,
      )
      .run(keep).changes
    stats.ops = db.prepare('DELETE FROM ops WHERE created_at < ?').run(now - 7 * DAY).changes
    db.prepare('DELETE FROM pow_used WHERE at < ?').run(now - 3600 * 1000)
  })

  // blobs that no revision refers to and that were uploaded more than a day ago (an upload nobody committed, or an expired revision)
  const orphans = db
    .prepare(
      `SELECT b.vault_id, b.sha256 FROM blobs b WHERE b.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = b.vault_id AND r.sha256 = b.sha256)
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.vault_id = b.vault_id AND f.sha256 = b.sha256)`,
    )
    .all(now - DAY)
  const protectedKeys = await protectedBlobs(storage)
  for (const o of orphans) {
    if (protectedKeys === null || protectedKeys.has(blobKey(o.vault_id, o.sha256))) continue
    // Claim only if it is still unreferenced. Commits reject this durable state
    // until deletion completes; a stale candidate can never delete a new ref.
    const claim = db.prepare(`UPDATE blobs SET deleting = 1 WHERE vault_id = ? AND sha256 = ?
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = blobs.vault_id AND r.sha256 = blobs.sha256)
      AND NOT EXISTS (SELECT 1 FROM files f WHERE f.vault_id = blobs.vault_id AND f.sha256 = blobs.sha256)`).run(o.vault_id, o.sha256)
    if (!claim.changes) continue
    await storage.del(blobKey(o.vault_id, o.sha256))
    db.prepare('DELETE FROM blobs WHERE vault_id = ? AND sha256 = ?').run(o.vault_id, o.sha256)
    stats.blobs++
  }

  // trashed vaults and accounts past their grace period
  for (const v of db.prepare('SELECT id FROM vaults WHERE deleting = 1 OR (deleted_at IS NOT NULL AND deleted_at < ?)').all(keep)) {
    if (activePurges.get(db)?.has(v.id)) continue
    if (await purgeVault(db, storage, v.id, keep)) stats.vaults++
  }
  for (const u of db.prepare('SELECT id FROM users WHERE deleting = 1 OR (delete_after IS NOT NULL AND delete_after < ?)').all(now)) {
    const claim = db.prepare('UPDATE users SET deleting = 1 WHERE id = ? AND (deleting = 1 OR (delete_after IS NOT NULL AND delete_after < ?))').run(u.id, now)
    if (!claim.changes) continue
    for (const v of db.prepare('SELECT id FROM vaults WHERE user_id = ?').all(u.id)) await purgeVault(db, storage, v.id)
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id) // vaults, devices, files and revisions go with it (foreign keys)
    stats.users++
  }

  expireReservations(db, cfg, now)
  stats.staging = await sweepStaging(cfg, now)
  return stats
}

export async function removeStagingDir(cfg) {
  await rm(path.join(cfg.dataDir, 'staging'), { recursive: true, force: true })
}
