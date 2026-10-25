// Housekeeping, run every hour. Nothing here removes data a user could still want:
// deleted files, old revisions and trashed vaults are kept for `retentionDays` (30), unreferenced blobs for a day.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { sweepStaging } from './blobs.js'
import { tx } from './db.js'
import { blobKey } from './storage.js'

const DAY = 24 * 3600 * 1000

/** Removes every blob of a vault from the storage; the rows go with the vault (or are deleted here). */
async function dropVaultBlobs(db, storage, vaultId) {
  for (const b of db.prepare('SELECT sha256 FROM blobs WHERE vault_id = ?').all(vaultId)) await storage.del(blobKey(vaultId, b.sha256))
  db.prepare('DELETE FROM blobs WHERE vault_id = ?').run(vaultId)
}

/** Removes a vault for good: its blobs from the storage, then its rows (files and revisions go with it). */
export async function purgeVault(db, storage, vaultId) {
  await dropVaultBlobs(db, storage, vaultId)
  db.prepare('DELETE FROM ops WHERE vault_id = ?').run(vaultId)
  db.prepare('DELETE FROM vaults WHERE id = ?').run(vaultId)
}

export async function runGc({ db, storage, cfg, now = Date.now() }) {
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
  for (const o of orphans) {
    await storage.del(blobKey(o.vault_id, o.sha256))
    db.prepare('DELETE FROM blobs WHERE vault_id = ? AND sha256 = ?').run(o.vault_id, o.sha256)
    stats.blobs++
  }

  // trashed vaults and accounts past their grace period
  for (const v of db.prepare('SELECT id FROM vaults WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(keep)) {
    await dropVaultBlobs(db, storage, v.id)
    db.prepare('DELETE FROM vaults WHERE id = ?').run(v.id)
    stats.vaults++
  }
  for (const u of db.prepare('SELECT id FROM users WHERE delete_after IS NOT NULL AND delete_after < ?').all(now)) {
    for (const v of db.prepare('SELECT id FROM vaults WHERE user_id = ?').all(u.id)) await dropVaultBlobs(db, storage, v.id)
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id) // vaults, devices, files and revisions go with it (foreign keys)
    stats.users++
  }

  stats.staging = await sweepStaging(cfg, now)
  return stats
}

export async function removeStagingDir(cfg) {
  await rm(path.join(cfg.dataDir, 'staging'), { recursive: true, force: true })
}
