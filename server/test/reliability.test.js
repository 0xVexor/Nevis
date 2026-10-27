import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { runGc } from '../src/gc.js'
import { usedBytes } from '../src/blobs.js'
import { snapshot as backupSnapshot, newEpochs } from '../src/backup.js'
import { call, changes, commit, login, newVault, putBlob, register, setup, sha } from './helpers.js'

const DAY = 86400000

describe('sync reliability', () => {
  let s, a, v
  beforeEach(async () => {
    s = await setup()
    a = await register(s)
    v = await newVault(s, a.token)
  })
  afterEach(async () => { await s.close() })
  const snapshot = query => call(s, 'GET', `/v1/vaults/${v}/snapshot${query ?? ''}`, { token: a.token })

  it('returns old live files in a full snapshot after tombstones were compacted', async () => {
    const made = await commit(s, a.token, v, [{ put: ['pages/live.json', 'keep'] }, { put: ['pages/gone.json', 'remove'] }])
    await commit(s, a.token, v, [{ del: ['pages/gone.json', made.body.results[1].rev] }])
    await runGc({ ...s, now: s.clock.t + 31 * DAY })
    assert.equal((await changes(s, a.token, v, 0)).status, 410)
    const full = await snapshot()
    assert.equal(full.status, 200)
    assert.deepEqual(full.body.files.map(f => f.path), ['pages/live.json'])
    assert.equal(full.body.head, 3)
    assert.equal(full.body.has_more, false)
  })

  it('restarts a snapshot when its head or generation changes between pages', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'a'] }, { put: ['pages/b.json', 'b'] }])
    const first = (await snapshot('?limit=1')).body
    assert.equal(first.has_more, true)
    const query = `?after=${encodeURIComponent(first.after)}&head=${first.head}&epoch=${first.epoch}&limit=1`
    assert.equal((await snapshot(query)).body.files[0].path, 'pages/b.json')
    newEpochs(s.db)
    assert.equal((await snapshot(query)).body.error, 'snapshot_changed')
    const current = (await snapshot('?limit=1')).body
    await commit(s, a.token, v, [{ put: ['pages/c.json', 'c'] }])
    assert.equal((await snapshot(`?after=${encodeURIComponent(current.after)}&head=${current.head}&epoch=${current.epoch}`)).status, 409)
    assert.equal((await snapshot('?after=pages/a.json')).status, 400)
  })

  it('roundtrips an empty file and repeats its upload without a new revision', async () => {
    const r = await commit(s, a.token, v, [{ put: ['files/ab/empty', ''] }])
    assert.equal(r.body.results[0].ok, true)
    const read = await call(s, 'GET', `/v1/vaults/${v}/rev/${r.body.results[0].rev}`, { token: a.token })
    assert.equal(read.status, 200)
    assert.equal(read.raw.length, 0)
    const repeated = await commit(s, a.token, v, [{ put: ['files/ab/empty', ''] }])
    assert.equal(repeated.body.results[0].rev, r.body.results[0].rev)
  })

  it('reserves quota across simultaneous uploads and across unfinished pieces', async () => {
    s.cfg.quotaBytes = 10
    const replies = await Promise.all(['aaaaaa', 'bbbbbb'].map(text => call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha(text)}`, { token: a.token, body: Buffer.from(text) })))
    assert.deepEqual(replies.map(r => r.status).sort(), [201, 507])
    assert.equal(usedBytes(s.db, a.userId), 6)
    s.cfg.quotaBytes = 20
    const pending = await call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha('cccccccccc')}`, { token: a.token, body: Buffer.from('ccccc'), headers: { 'content-range': 'bytes 0-4/10' } })
    assert.equal(pending.status, 202)
    assert.equal(s.db.prepare('SELECT SUM(size) AS n FROM upload_reservations').get().n, 10)
    const other = await call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha('dddddd')}`, { token: a.token, body: Buffer.from('dddddd') })
    assert.equal(other.status, 507)
    await runGc({ ...s, now: s.clock.t + 2 * DAY })
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM upload_reservations').get().n, 0)
  })

  it('serializes two writers of the same immutable blob', async () => {
    const body = Buffer.from('same content')
    const replies = await Promise.all([1, 2].map(() => call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha(body)}`, { token: a.token, body })))
    assert.deepEqual(replies.map(r => r.status).sort(), [200, 201])
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 1)
  })

  it('refuses a new reference while GC has claimed its blob, then permits a clean retry', async () => {
    const hash = await putBlob(s, a.token, v, 'only copy')
    s.clock.t += 2 * DAY
    const del = s.storage.del.bind(s.storage)
    let attempted
    s.storage.del = async key => {
      if (key.includes(hash)) attempted = await call(s, 'POST', `/v1/vaults/${v}/commit`, { token: a.token, body: { op_id: 'during-blob-gc', ops: [{ op: 'put', path: 'pages/a.json', base_rev: 0, sha256: hash }] } })
      return del(key)
    }
    await runGc({ ...s, now: s.clock.t })
    assert.equal(attempted.body.results[0].ok, false)
    assert.equal(attempted.body.results[0].error, 'blob_deleting')
    const retry = await commit(s, a.token, v, [{ put: ['pages/a.json', 'only copy'] }])
    assert.equal(retry.body.results[0].ok, true)
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/rev/${retry.body.results[0].rev}`, { token: a.token })).raw.toString(), 'only copy')
  })

  it('keeps the deletion claim after an object-store failure so a later GC can resume', async () => {
    await putBlob(s, a.token, v, 'orphan')
    const del = s.storage.del.bind(s.storage)
    s.storage.del = async () => { throw new Error('storage unavailable') }
    await assert.rejects(runGc({ ...s, now: s.clock.t + 2 * DAY }), /storage unavailable/)
    assert.equal(s.db.prepare('SELECT deleting FROM blobs').get().deleting, 1)
    s.storage.del = del
    await runGc({ ...s, now: s.clock.t + 2 * DAY })
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 0)
  })

  it('rejects a restore after permanent cleanup has started', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'kept'] }])
    await call(s, 'DELETE', `/v1/vaults/${v}`, { token: a.token })
    const del = s.storage.del.bind(s.storage)
    let restore
    s.storage.del = async key => {
      restore ??= await call(s, 'POST', `/v1/vaults/${v}/undelete`, { token: a.token, body: {} })
      return del(key)
    }
    await runGc({ ...s, now: s.clock.t + 31 * DAY })
    assert.equal(restore.status, 409)
    assert.equal(restore.body.error, 'vault_deleting')
  })

  it('does not purge a later candidate that was restored while an earlier purge was pending', async () => {
    const second = await newVault(s, a.token, 'second')
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'first'] }])
    await commit(s, a.token, second, [{ put: ['pages/a.json', 'second'] }])
    for (const id of [v, second]) await call(s, 'DELETE', `/v1/vaults/${id}`, { token: a.token })
    const del = s.storage.del.bind(s.storage)
    let restored
    s.storage.del = async key => {
      restored ??= await call(s, 'POST', `/v1/vaults/${second}/undelete`, { token: a.token, body: {} })
      return del(key)
    }
    await runGc({ ...s, now: s.clock.t + 31 * DAY })
    assert.equal(restored.status, 200)
    assert.equal((await call(s, 'GET', `/v1/vaults/${second}/state`, { token: a.token })).status, 200)
  })

  it('rejects login cancellation once account cleanup owns the deletion', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'kept'] }])
    await call(s, 'DELETE', '/v1/account', { token: a.token, body: { password: 'correct horse battery' } })
    const del = s.storage.del.bind(s.storage)
    let restored
    s.storage.del = async key => {
      restored ??= await login(s, 'alice', 'correct horse battery')
      return del(key)
    }
    await runGc({ ...s, now: s.clock.t + 31 * DAY })
    assert.equal(restored.status, 409)
    assert.equal(restored.body.error, 'account_deleting')
  })

  it('retains objects referenced by an index backup after live revisions expire', async () => {
    const first = await commit(s, a.token, v, [{ put: ['pages/a.json', 'old'] }])
    await backupSnapshot(s.db, s.storage, s.cfg)
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'new', first.body.results[0].rev] }])
    await runGc({ ...s, now: s.clock.t + 31 * DAY })
    const read = await call(s, 'GET', `/v1/vaults/${v}/blobs/${sha('old')}`, { token: a.token })
    assert.equal(read.status, 200)
    assert.equal(read.raw.toString(), 'old')
  })

  it('permits a case-only replacement without discarding the old tombstone', async () => {
    const old = await commit(s, a.token, v, [{ put: ['pages/A.json', 'old'] }])
    await commit(s, a.token, v, [{ del: ['pages/A.json', old.body.results[0].rev] }])
    const next = await commit(s, a.token, v, [{ put: ['pages/a.json', 'new'] }])
    assert.equal(next.body.results[0].ok, true)
    assert.equal(s.db.prepare('SELECT deleted FROM files WHERE path = ?').get('pages/A.json').deleted, 1)
    assert.equal((await snapshot()).body.files[0].path, 'pages/a.json')
  })

  it('holds a deletion burst split into single-file requests until it is confirmed', async () => {
    const made = await commit(s, a.token, v, Array.from({ length: 6 }, (_, i) => ({ put: [`pages/${i}.json`, `${i}`] })))
    for (let i = 0; i < 5; i++) assert.equal((await commit(s, a.token, v, [{ del: [`pages/${i}.json`, made.body.results[i].rev] }])).body.results[0].ok, true)
    const last = [{ del: ['pages/5.json', made.body.results[5].rev] }]
    assert.equal((await commit(s, a.token, v, last)).body.results[0].error, 'bulk_delete')
    assert.equal((await commit(s, a.token, v, last, { confirm_bulk: true })).body.results[0].ok, true)
  })
})
