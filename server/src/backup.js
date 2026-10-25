// The database is small and the blobs live in S3, so the whole server can be rebuilt from a copy of the database.
// A copy goes to the storage a few seconds after the last write and when the process is told to stop (a deploy).
// If the database file is missing at start (a new container without a persistent disk) the newest copy is restored,
// and every vault gets a new `epoch`: devices that notice it start over from what they hold, never deleting anything,
// so whatever the copy was too old to know is put back by the devices.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const LATEST = '_backup/index-latest.db.gz'
const KEEP = 24

export const dbFile = (cfg) => path.join(cfg.dataDir, 'noviq.db')

export async function snapshot(db, storage, cfg, now = new Date()) {
  const tmp = path.join(cfg.dataDir, 'backup.tmp.db')
  await rm(tmp, { force: true })
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`)
  const gz = gzipSync(await readFile(tmp))
  await rm(tmp, { force: true })
  await storage.put(LATEST, gz)
  const hourly = `_backup/index-${now.toISOString().slice(0, 13).replaceAll(/[-:]/g, '')}.db.gz`
  await storage.put(hourly, gz)
  const old = (await storage.list('_backup/index-2')).sort() // the dated copies; "latest" sorts elsewhere
  for (const k of old.slice(0, Math.max(0, old.length - KEEP))) await storage.del(k)
  return { bytes: gz.length, key: hourly }
}

/** Restores the newest copy when there is no database file. Returns true when it did. */
export async function restoreIfMissing(storage, cfg) {
  await mkdir(cfg.dataDir, { recursive: true })
  const file = dbFile(cfg)
  try {
    await stat(file)
    return false
  } catch {
    // no database here
  }
  const gz = await storage.read(LATEST)
  if (!gz) return false
  await writeFile(file, gunzipSync(gz))
  return true
}

/** After a restore: nobody may believe the old numbering still holds. */
export function newEpochs(db) {
  for (const v of db.prepare('SELECT id FROM vaults').all()) db.prepare('UPDATE vaults SET epoch = ? WHERE id = ?').run(randomBytes(9).toString('base64url'), v.id)
}

/** Calls `snapshot` shortly after the last of a burst of writes. */
export function debouncedBackup(run, delayMs, log = () => {}) {
  let timer = null
  let running = false
  let again = false
  const go = async () => {
    timer = null
    if (running) {
      again = true
      return
    }
    running = true
    try {
      await run()
    } catch (e) {
      log(`backup failed: ${e.message}`)
    } finally {
      running = false
      if (again) {
        again = false
        trigger()
      }
    }
  }
  const trigger = () => {
    if (!timer) timer = setTimeout(go, delayMs)
  }
  /** Runs one now (shutdown). */
  const flush = async () => {
    if (timer) clearTimeout(timer)
    timer = null
    await go()
  }
  return { trigger, flush }
}
