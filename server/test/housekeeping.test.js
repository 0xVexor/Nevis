import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { dbFile, newEpochs, restoreIfMissing, snapshot } from '../src/backup.js'
import { openDb } from '../src/db.js'
import { runGc } from '../src/gc.js'
import { MemStorage, blobKey } from '../src/storage.js'
import { call, changes, commit, login, newVault, putBlob, register, setup, sha } from './helpers.js'

const DAY = 24 * 3600 * 1000

describe('housekeeping', () => {
  let s, a, v
  beforeEach(async () => {
    s = await setup()
    a = await register(s)
    v = await newVault(s, a.token)
  })
  afterEach(() => s.close())

  const gc = (days) => runGc({ db: s.db, storage: s.storage, cfg: s.cfg, now: s.clock.t + days * DAY })

  it('keeps a deleted file for the retention period and then forgets it; older devices must start over', async () => {
    const made = await commit(s, a.token, v, [{ put: ['pages/a.json', 'a'] }, { put: ['pages/b.json', 'b'] }])
    await commit(s, a.token, v, [{ del: ['pages/a.json', made.body.results[0].rev] }])
    assert.equal((await gc(10)).tombstones, 0)
    assert.equal((await changes(s, a.token, v, 0)).body.files.length, 2)
    assert.equal((await gc(31)).tombstones, 1)
    const ok = await changes(s, a.token, v, 3) // a device that was online recently is fine
    assert.equal(ok.status, 200)
    const old = await changes(s, a.token, v, 0) // one that was away longer cannot know what was deleted
    assert.equal(old.status, 410)
    assert.equal(old.body.error, 'since_too_old')
  })

  it('removes old revisions and blobs nothing refers to any more, but not the current ones', async () => {
    const first = await commit(s, a.token, v, [{ put: ['pages/a.json', 'one'] }])
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'two', first.body.results[0].rev] }])
    const orphan = await putBlob(s, a.token, v, 'never committed')
    const stats = await gc(31)
    assert.equal(stats.revisions, 1)
    assert.equal(stats.blobs, 2) // 'one' and the orphan
    assert.equal(await s.storage.has(blobKey(v, sha('one'))), false)
    assert.equal(await s.storage.has(blobKey(v, orphan)), false)
    assert.equal(await s.storage.has(blobKey(v, sha('two'))), true)
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/rev/${first.body.results[0].rev}`, { token: a.token })).status, 404)
  })

  it('does not touch a blob that was uploaded a moment ago and is about to be committed', async () => {
    await putBlob(s, a.token, v, 'in flight')
    assert.equal((await gc(0)).blobs, 0)
  })

  it('removes a trashed vault with its blobs after the retention period', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'a'] }])
    await call(s, 'DELETE', `/v1/vaults/${v}`, { token: a.token })
    assert.equal((await gc(5)).vaults, 0)
    assert.equal(await s.storage.has(blobKey(v, sha('a'))), true)
    assert.equal((await gc(31)).vaults, 1)
    assert.equal(await s.storage.has(blobKey(v, sha('a'))), false)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0)
  })

  it('removes an account that was deleted, with everything in it, once the grace period is over', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'a'] }])
    await call(s, 'DELETE', '/v1/account', { token: a.token, body: { password: 'correct horse battery' } })
    assert.equal((await gc(5)).users, 0)
    assert.equal((await gc(31)).users, 1)
    assert.equal(await s.storage.has(blobKey(v, sha('a'))), false)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
    assert.equal((await login(s, 'alice', 'correct horse battery')).status, 401)
  })
})

describe('backup', () => {
  let s, a, v, dir
  beforeEach(async () => {
    s = await setup()
    a = await register(s)
    v = await newVault(s, a.token)
    dir = mkdtempSync(path.join(tmpdir(), 'noviq-restore-'))
  })
  afterEach(async () => {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a copy of the database in the storage brings the whole server back on an empty disk, with new epochs', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'kept'] }])
    const storage = new MemStorage()
    const info = await snapshot(s.db, storage, s.cfg, new Date('2026-10-25T10:20:00Z'))
    assert.match(info.key, /index-20261025T10\.db\.gz$/)
    const cfg = { ...s.cfg, dataDir: dir }
    assert.equal(await restoreIfMissing(storage, cfg), true)
    assert.equal(await restoreIfMissing(storage, cfg), false, 'an existing database is never replaced')
    const db = openDb(dbFile(cfg))
    const before = s.db.prepare('SELECT epoch FROM vaults').get().epoch
    newEpochs(db)
    assert.notEqual(db.prepare('SELECT epoch FROM vaults').get().epoch, before)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1)
    assert.equal(db.prepare('SELECT username FROM users').get().username, 'alice')
    db.close()
  })

  it('keeps only the most recent hourly copies', async () => {
    const storage = new MemStorage()
    for (let h = 0; h < 30; h++) await snapshot(s.db, storage, s.cfg, new Date(Date.UTC(2026, 9, 25, 0, 0) + h * 3600 * 1000))
    const keys = await storage.list('_backup/')
    assert.equal(keys.filter(k => k.endsWith('.gz')).length, 25) // 24 dated copies and latest
    assert.equal(keys.filter(k => k.endsWith('.refs.json')).length, 25)
    assert.ok(!keys.some((k) => k.includes('20261025T00')))
  })

  it('nothing to restore from when there is no copy', async () => {
    assert.equal(await restoreIfMissing(new MemStorage(), { ...s.cfg, dataDir: dir }), false)
  })
})
