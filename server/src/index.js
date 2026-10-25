// Entry point: `npm start`. Everything is configured by environment variables, see config.js and README.md.

import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildApp } from './app.js'
import { dbFile, debouncedBackup, newEpochs, restoreIfMissing, snapshot } from './backup.js'
import { configProblems, loadConfig } from './config.js'
import { openDb } from './db.js'
import { runGc } from './gc.js'
import { Hub } from './hub.js'
import { acquireLock } from './lock.js'
import { createStorage } from './storage.js'

const cfg = loadConfig()
const problems = configProblems(cfg)
if (problems.length) {
  for (const p of problems) console.error(`config: ${p}`)
  process.exit(1)
}

// the folder of the database and of half-finished uploads. In some hosts the app folder cannot be written: then a temporary one
// is used (the database is copied to the storage and restored from it, see backup.js), and DATA_DIR on a persistent disk is the better setup
try {
  await mkdir(cfg.dataDir, { recursive: true })
} catch (e) {
  const alt = path.join(os.tmpdir(), 'noviq-data')
  console.warn(`cannot create DATA_DIR ${cfg.dataDir} (${e.code}); using ${alt}. Set DATA_DIR to a persistent disk to keep the database between restarts.`)
  cfg.dataDir = alt
  await mkdir(alt, { recursive: true })
}
const storage = await createStorage(cfg)
const lock = cfg.lock ? await acquireLock(storage).catch((e) => (console.error(e.message), process.exit(1))) : { release: async () => {} }
const restored = await restoreIfMissing(storage, cfg)
const db = openDb(dbFile(cfg))
if (restored) {
  newEpochs(db)
  console.warn('restored the database from the last backup; every vault has a new epoch')
}

const hub = new Hub()
const backup = debouncedBackup(() => snapshot(db, storage, cfg), cfg.backupDelaySec * 1000, (m) => console.error(m))
const app = await buildApp({ cfg, db, storage, hub, onWrite: backup.trigger, logger: { level: 'info', redact: ['req.headers.authorization'] } })

const gc = () => runGc({ db, storage, cfg }).then((s) => app.log.info({ gc: s }, 'housekeeping done'), (e) => app.log.error({ err: e.message }, 'housekeeping failed'))
const timers = [setInterval(gc, 3600 * 1000), setInterval(() => app.limiter.sweep(), 5 * 60 * 1000), setTimeout(gc, 60 * 1000)]
timers.forEach((t) => t.unref())

let stopping = false
const stop = async (sig) => {
  if (stopping) return
  stopping = true
  app.log.info({ sig }, 'stopping')
  hub.releaseAll()
  try {
    await app.close()
    await backup.flush() // the last writes reach the storage before the container goes away
    db.close()
    await lock.release()
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))

await app.listen({ port: cfg.port, host: '0.0.0.0' })
