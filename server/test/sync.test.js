import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { call, changes, commit, newVault, putBlob, register, setup, sha } from './helpers.js'

describe('vaults and commits', () => {
  let s, a, v
  beforeEach(async () => {
    s = await setup()
    a = await register(s)
    v = await newVault(s, a.token)
  })
  afterEach(() => s.close())

  const files = async (since = 0) => (await changes(s, a.token, v, since)).body.files

  it('creates a vault once, and answers the same vault when asked again', async () => {
    const again = await call(s, 'POST', '/v1/vaults', { token: a.token, body: { id: v, name: 'notes' } })
    assert.equal(again.status, 200)
    assert.equal(again.body.created, false)
    const list = await call(s, 'GET', '/v1/vaults', { token: a.token })
    assert.equal(list.body.vaults.length, 1)
  })

  it('keeps vaults of different users apart, and does not reveal that they exist', async () => {
    const b = await register(s, 'bob')
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/state`, { token: b.token })).status, 404)
    assert.equal((await changes(s, b.token, v)).status, 404)
    const take = await call(s, 'POST', '/v1/vaults', { token: b.token, body: { id: v, name: 'mine' } })
    assert.equal(take.status, 409)
    assert.equal(take.body.error, 'vault_taken')
    assert.equal((await call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha('x')}`, { token: b.token, body: Buffer.from('x') })).status, 404)
    assert.equal((await call(s, 'POST', `/v1/vaults/${v}/commit`, { token: b.token, body: { op_id: 'intruder-op-1', ops: [{ op: 'delete', path: 'pages/x.json', base_rev: 0 }] } })).status, 404)
  })

  it('a committed file shows up in the changes with its content hash and a rev', async () => {
    const r = await commit(s, a.token, v, [{ put: ['pages/a.json', '{"t":1}'] }])
    assert.equal(r.status, 200)
    assert.equal(r.body.results[0].ok, true)
    assert.equal(r.body.results[0].rev, 1)
    const list = await files()
    assert.equal(list.length, 1)
    assert.equal(list[0].path, 'pages/a.json')
    assert.equal(list[0].sha256, sha('{"t":1}'))
    assert.equal(list[0].deleted, false)
    assert.equal(s.writes.n > 0, true)
  })

  it('answers a repeated op_id with the same result and changes nothing twice', async () => {
    const sha256 = await putBlob(s, a.token, v, 'one')
    const body = { op_id: 'same-operation-1', ops: [{ op: 'put', path: 'pages/a.json', sha256, base_rev: 0 }] }
    const first = await call(s, 'POST', `/v1/vaults/${v}/commit`, { token: a.token, body })
    const second = await call(s, 'POST', `/v1/vaults/${v}/commit`, { token: a.token, body })
    assert.equal(first.body.results[0].rev, 1)
    assert.equal(second.body.results[0].rev, 1)
    assert.equal(second.body.replay, true)
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/state`, { token: a.token })).body.seq, 1)
  })

  it('refuses a write based on an old rev and shows the current state instead (compare and swap)', async () => {
    const first = await commit(s, a.token, v, [{ put: ['pages/a.json', 'v1'] }])
    const rev1 = first.body.results[0].rev
    const phone = await commit(s, a.token, v, [{ put: ['pages/a.json', 'phone edit', rev1] }])
    assert.equal(phone.body.results[0].ok, true)
    const laptop = await commit(s, a.token, v, [{ put: ['pages/a.json', 'laptop edit', rev1] }])
    const r = laptop.body.results[0]
    assert.equal(r.ok, false)
    assert.equal(r.error, 'conflict')
    assert.equal(r.current.sha256, sha('phone edit'))
    assert.equal(r.current.rev, phone.body.results[0].rev)
    assert.equal((await files())[0].sha256, sha('phone edit')) // nothing was overwritten
  })

  it('accepts a second write of identical content as a no-op even if its base is stale', async () => {
    const first = await commit(s, a.token, v, [{ put: ['pages/a.json', 'same'] }])
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'newer', first.body.results[0].rev] }])
    const r = await commit(s, a.token, v, [{ put: ['pages/a.json', 'newer', 1] }])
    assert.equal(r.body.results[0].ok, true)
    assert.equal(r.body.results[0].noop, true)
  })

  it('a path that exists cannot be created again from nothing', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'v1'] }])
    const r = await commit(s, a.token, v, [{ put: ['pages/a.json', 'other', 0] }])
    assert.equal(r.body.results[0].error, 'conflict')
  })

  it('a delete is a tombstone with its own rev, and a stale delete does not remove a newer edit', async () => {
    const created = await commit(s, a.token, v, [{ put: ['pages/a.json', 'v1'] }])
    const rev1 = created.body.results[0].rev
    const edited = await commit(s, a.token, v, [{ put: ['pages/a.json', 'v2', rev1] }])
    const stale = await commit(s, a.token, v, [{ del: ['pages/a.json', rev1] }])
    assert.equal(stale.body.results[0].error, 'conflict')
    assert.equal((await files())[0].deleted, false)
    const del = await commit(s, a.token, v, [{ del: ['pages/a.json', edited.body.results[0].rev] }])
    assert.equal(del.body.results[0].ok, true)
    const f = (await files())[0]
    assert.equal(f.deleted, true)
    assert.equal(f.rev, del.body.results[0].rev)
    assert.equal(f.sha256, '')
  })

  it('an edit made before another device deleted the file brings it back, and deleting twice is harmless', async () => {
    const created = await commit(s, a.token, v, [{ put: ['pages/a.json', 'v1'] }])
    const rev1 = created.body.results[0].rev
    await commit(s, a.token, v, [{ del: ['pages/a.json', rev1] }])
    const stale = await commit(s, a.token, v, [{ put: ['pages/a.json', 'edit after', rev1] }])
    assert.equal(stale.body.results[0].error, 'conflict')
    assert.equal(stale.body.results[0].current.deleted, true)
    const back = await commit(s, a.token, v, [{ put: ['pages/a.json', 'edit after', 0] }])
    assert.equal(back.body.results[0].ok, true)
    assert.equal((await files())[0].deleted, false)
    const del1 = await commit(s, a.token, v, [{ del: ['pages/a.json', back.body.results[0].rev] }])
    const del2 = await commit(s, a.token, v, [{ del: ['pages/a.json', back.body.results[0].rev] }])
    assert.equal(del1.body.results[0].ok, true)
    assert.equal(del2.body.results[0].ok, true)
    assert.equal(del2.body.results[0].noop, true)
  })

  it('an atomic commit applies everything or nothing', async () => {
    const first = await commit(s, a.token, v, [{ put: ['pages/a.json', 'v1'] }])
    const r = await commit(s, a.token, v, [{ put: ['pages/b.json', 'new'] }, { put: ['pages/a.json', 'stale', 0] }], { atomic: true })
    assert.deepEqual(
      r.body.results.map((x) => x.ok),
      [false, false],
    )
    assert.equal((await files()).length, 1)
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/state`, { token: a.token })).body.seq, first.body.seq)
    const again = await commit(s, a.token, v, [{ put: ['pages/b.json', 'new'] }, { put: ['pages/c.json', 'new'] }], { atomic: true })
    assert.equal(again.body.results.every((x) => x.ok), true)
  })

  it('without atomic, the ops that fit are applied and the others report why not', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'v1'] }])
    const r = await commit(s, a.token, v, [{ put: ['pages/b.json', 'new'] }, { put: ['pages/a.json', 'stale', 0] }])
    assert.deepEqual(
      r.body.results.map((x) => x.ok),
      [true, false],
    )
  })

  it('refuses to commit content that was never uploaded', async () => {
    const r = await call(s, 'POST', `/v1/vaults/${v}/commit`, { token: a.token, body: { op_id: 'no-blob-here-1', ops: [{ op: 'put', path: 'pages/a.json', sha256: sha('ghost'), base_rev: 0 }] } })
    assert.equal(r.body.results[0].error, 'blob_missing')
  })

  it('refuses paths that are outside the vault, unsafe on another system, or equal when letters are folded', async () => {
    for (const bad of ['../x', '/abs', 'other/a.json', 'pages/CON', 'pages/a:b', 'pages/a\\b', 'pages//a', 'pages/a.', 'pages/.x.tmp', 'pages']) {
      const r = await commit(s, a.token, v, [{ put: [bad, 'x'] }])
      assert.equal(r.body.results[0].error, 'bad_path', bad)
    }
    assert.equal((await commit(s, a.token, v, [{ put: ['.noviq/vault.json', '{}'] }])).body.results[0].ok, true)
    assert.equal((await commit(s, a.token, v, [{ put: ['pages/Abc.json', 'x'] }])).body.results[0].ok, true)
    assert.equal((await commit(s, a.token, v, [{ put: ['pages/aBC.json', 'x'] }])).body.results[0].error, 'path_case_clash')
  })

  it('a bad request is a 400, not a crash', async () => {
    const r = await call(s, 'POST', `/v1/vaults/${v}/commit`, { token: a.token, body: { op_id: 'x', ops: [] } })
    assert.equal(r.status, 400)
    const r2 = await call(s, 'POST', `/v1/vaults/${v}/commit`, { token: a.token, body: { op_id: 'long-enough-id', ops: [null, 5, { op: 'launch' }] } })
    assert.deepEqual(
      r2.body.results.map((x) => x.error),
      ['bad_op', 'bad_op', 'bad_op'],
    )
  })

  it('holds back a mass deletion unless the client confirms it', async () => {
    const put = []
    for (let i = 0; i < 12; i++) put.push({ put: [`pages/p${i}.json`, `page ${i}`] })
    const made = await commit(s, a.token, v, put)
    const revs = made.body.results.map((r) => r.rev)
    const dels = revs.map((rev, i) => ({ del: [`pages/p${i}.json`, rev] }))
    const refused = await commit(s, a.token, v, dels)
    assert.equal(refused.body.results.every((r) => r.error === 'bulk_delete'), true)
    assert.equal((await files()).filter((f) => !f.deleted).length, 12)
    const few = await commit(s, a.token, v, dels.slice(0, 2))
    assert.equal(few.body.results.every((r) => r.ok), true)
    const ok = await commit(s, a.token, v, dels.slice(2), { confirm_bulk: true })
    assert.equal(ok.body.results.every((r) => r.ok), true)
  })

  it('pages through the changes in the order they happened', async () => {
    for (let i = 0; i < 5; i++) await commit(s, a.token, v, [{ put: [`pages/p${i}.json`, `page ${i}`] }])
    const one = (await changes(s, a.token, v, 0, 2)).body
    assert.equal(one.files.length, 2)
    assert.equal(one.has_more, true)
    assert.equal(one.next, one.files.at(-1).rev)
    const two = (await changes(s, a.token, v, one.next, 2)).body
    const three = (await changes(s, a.token, v, two.next, 2)).body
    assert.deepEqual([...one.files, ...two.files, ...three.files].map((f) => f.path), ['pages/p0.json', 'pages/p1.json', 'pages/p2.json', 'pages/p3.json', 'pages/p4.json'])
    assert.equal(three.has_more, false)
    assert.equal(three.next, three.head)
    assert.deepEqual((await changes(s, a.token, v, three.head)).body.files, []) // nothing new: an empty answer
  })

  it('a file that changed twice appears once, with its latest rev', async () => {
    const first = await commit(s, a.token, v, [{ put: ['pages/a.json', 'v1'] }])
    await commit(s, a.token, v, [{ put: ['pages/b.json', 'b'] }])
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'v2', first.body.results[0].rev] }])
    const list = await files()
    assert.deepEqual(list.map((f) => [f.path, f.rev]), [['pages/b.json', 2], ['pages/a.json', 3]])
  })

  it('serves the content of an old revision and can put it back', async () => {
    const first = await commit(s, a.token, v, [{ put: ['pages/a.json', 'first version'] }])
    const rev1 = first.body.results[0].rev
    const second = await commit(s, a.token, v, [{ put: ['pages/a.json', 'second version', rev1] }])
    const old = await call(s, 'GET', `/v1/vaults/${v}/rev/${rev1}`, { token: a.token })
    assert.equal(old.raw.toString(), 'first version')
    const hist = await call(s, 'GET', `/v1/vaults/${v}/revisions?path=pages/a.json`, { token: a.token })
    assert.deepEqual(hist.body.revisions.map((r) => r.rev), [second.body.results[0].rev, rev1])
    const back = await call(s, 'POST', `/v1/vaults/${v}/restore`, { token: a.token, body: { path: 'pages/a.json', rev: rev1 } })
    assert.equal(back.body.ok, true)
    assert.equal((await files())[0].sha256, sha('first version'))
    assert.equal((await call(s, 'POST', `/v1/vaults/${v}/restore`, { token: a.token, body: { path: 'pages/a.json', rev: 999 } })).status, 404)
  })

  it('answers for one path as it is right now, tombstones included', async () => {
    const q = (p) => call(s, 'GET', `/v1/vaults/${v}/file?path=${encodeURIComponent(p)}`, { token: a.token })
    assert.equal((await q('pages/a.json')).status, 404)
    const made = await commit(s, a.token, v, [{ put: ['pages/a.json', 'x'] }])
    assert.equal((await q('pages/a.json')).body.file.sha256, sha('x'))
    await commit(s, a.token, v, [{ del: ['pages/a.json', made.body.results[0].rev] }])
    assert.equal((await q('pages/a.json')).body.file.deleted, true)
  })

  it('the state has a root hash that changes with the content and not with the order of events', async () => {
    const r0 = (await call(s, 'GET', `/v1/vaults/${v}/state`, { token: a.token })).body.root
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'a'] }, { put: ['pages/b.json', 'b'] }])
    const r1 = (await call(s, 'GET', `/v1/vaults/${v}/state`, { token: a.token })).body.root
    const w = await newVault(s, a.token, 'other')
    await commit(s, a.token, w, [{ put: ['pages/b.json', 'b'] }])
    await commit(s, a.token, w, [{ put: ['pages/a.json', 'a'] }])
    const r2 = (await call(s, 'GET', `/v1/vaults/${w}/state`, { token: a.token })).body.root
    assert.notEqual(r0, r1)
    assert.equal(r1, r2)
  })

  it('trashing a vault hides it, and it can be brought back', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'a'] }])
    assert.equal((await call(s, 'DELETE', `/v1/vaults/${v}`, { token: a.token })).status, 200)
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/state`, { token: a.token })).status, 404)
    assert.equal((await call(s, 'GET', '/v1/vaults', { token: a.token })).body.vaults.length, 0)
    assert.equal((await call(s, 'GET', '/v1/vaults?trashed=1', { token: a.token })).body.vaults.length, 1)
    assert.equal((await call(s, 'POST', '/v1/vaults', { token: a.token, body: { id: v, name: 'x' } })).body.error, 'vault_deleted')
    assert.equal((await call(s, 'POST', `/v1/vaults/${v}/undelete`, { token: a.token })).status, 200)
    assert.equal((await files()).length, 1)
  })

  it('deletes a trashed vault for good, with its files in the storage, and only a trashed one', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'gone for good'] }])
    const keep = await call(s, 'DELETE', `/v1/vaults/${v}/permanent`, { token: a.token })
    assert.equal(keep.status, 409) // not in the trash: a mistake must not remove a live vault
    assert.equal(keep.body.error, 'not_in_trash')
    await call(s, 'DELETE', `/v1/vaults/${v}`, { token: a.token })
    const other = await register(s, 'mallory')
    // A missing vault and another account's vault are indistinguishable; neither is removed.
    assert.equal((await call(s, 'DELETE', `/v1/vaults/${v}/permanent`, { token: other.token })).status, 200)
    assert.equal((await call(s, 'GET', '/v1/vaults?trashed=1', { token: a.token })).body.vaults.length, 1)
    assert.equal((await call(s, 'DELETE', `/v1/vaults/${v}/permanent`, { token: a.token })).status, 200)
    assert.equal((await call(s, 'GET', '/v1/vaults?trashed=1', { token: a.token })).body.vaults.length, 0)
    assert.equal((await call(s, 'DELETE', `/v1/vaults/${v}/permanent`, { token: a.token })).status, 200)
    assert.equal(await s.storage.has(`v/${v}/b/${sha('gone for good').slice(0, 2)}/${sha('gone for good')}`), false)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0)
    assert.equal((await call(s, 'GET', '/v1/account', { token: a.token })).body.quota.used, 0)
    assert.equal((await call(s, 'POST', `/v1/vaults/${v}/undelete`, { token: a.token })).status, 404)
  })

  it('advertises supported sync paths and keeps database records through trash and restore', async () => {
    const health = (await call(s, 'GET', '/v1/health')).body
    assert.ok(health.capabilities.includes('database_sync'))
    assert.ok(health.capabilities.includes('permanent_delete'))
    assert.ok(health.sync_roots.includes('databases'))
    const dirs = ['containers', 'sources', 'properties', 'views', 'relations', 'edges', 'templates', 'workflows', 'comments', 'principals', 'grants', 'events', 'allocators']
    for (const dir of dirs) {
      const r = await commit(s, a.token, v, [{ put: [`databases/${dir}/item~3a1.json`, '{"revision":1}'] }])
      assert.equal(r.body.results[0].ok, true, dir)
    }
    const before = await files()
    await call(s, 'DELETE', `/v1/vaults/${v}`, { token: a.token })
    await call(s, 'POST', `/v1/vaults/${v}/undelete`, { token: a.token })
    assert.deepEqual(await files(), before)
    for (const f of before) {
      const data = await call(s, 'GET', `/v1/vaults/${v}/rev/${f.rev}`, { token: a.token })
      assert.equal(data.raw.toString(), '{"revision":1}')
    }
  })

  it('rejects unsafe database paths without changing existing records', async () => {
    await commit(s, a.token, v, [{ put: ['databases/views/v1.json', 'keep'] }])
    const before = await files()
    for (const path of ['databases/nope/a.json', 'databases/views/sub/a.json', 'databases/views/a.exe', 'databases/views/.hidden.json', 'databases/views/../a.json']) {
      const r = await commit(s, a.token, v, [{ put: [path, 'bad'] }])
      assert.equal(r.body.results[0].error, 'bad_path', path)
      assert.ok(r.body.results[0].detail)
    }
    assert.deepEqual(await files(), before)
  })

  it('schedules durable backups for vault metadata changes', async () => {
    let before = s.writes.n
    await call(s, 'PATCH', `/v1/vaults/${v}`, { token: a.token, body: { name: 'renamed' } })
    assert.equal(s.writes.n, ++before)
    await call(s, 'DELETE', `/v1/vaults/${v}`, { token: a.token })
    assert.equal(s.writes.n, ++before)
    await call(s, 'POST', `/v1/vaults/${v}/undelete`, { token: a.token })
    assert.equal(s.writes.n, ++before)
  })

  it('limits the number of vaults per account', async () => {
    await s.close()
    s = await setup({ maxVaults: 2 })
    a = await register(s)
    await newVault(s, a.token, 'one')
    await newVault(s, a.token, 'two')
    const r = await call(s, 'POST', '/v1/vaults', { token: a.token, body: { name: 'three' } })
    assert.equal(r.status, 403)
  })
})

describe('instant notification', () => {
  let s, a, v
  beforeEach(async () => {
    s = await setup()
    a = await register(s)
    v = await newVault(s, a.token)
  })
  afterEach(() => s.close())

  it('answers a waiting request the moment another device commits', async () => {
    const t0 = Date.now()
    const waiting = call(s, 'GET', `/v1/vaults/${v}/state?since=0&wait=20`, { token: a.token })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(s.hub.size, 1)
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'hello'] }])
    const r = await waiting
    assert.equal(r.body.seq, 1)
    assert.ok(Date.now() - t0 < 2000, 'it did not wait for the timeout')
    assert.equal(s.hub.size, 0)
  })

  it('answers at once when the vault is already past `since`, and after the wait when nothing happens', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'hello'] }])
    const t0 = Date.now()
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/state?since=0&wait=20`, { token: a.token })).body.seq, 1)
    assert.ok(Date.now() - t0 < 500)
    const t1 = Date.now()
    const idle = await call(s, 'GET', `/v1/vaults/${v}/state?since=1&wait=1`, { token: a.token })
    assert.equal(idle.body.seq, 1)
    assert.ok(Date.now() - t1 >= 900)
  })

  it('wakes every waiting device, not just one', async () => {
    const waits = [1, 2, 3].map(() => call(s, 'GET', `/v1/vaults/${v}/state?since=0&wait=20`, { token: a.token }))
    await new Promise((r) => setTimeout(r, 50))
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'hello'] }])
    const all = await Promise.all(waits)
    assert.deepEqual(all.map((r) => r.body.seq), [1, 1, 1])
  })

  it('a commit that changed nothing does not wake anyone', async () => {
    await commit(s, a.token, v, [{ put: ['pages/a.json', 'hello'] }])
    const waiting = call(s, 'GET', `/v1/vaults/${v}/state?since=1&wait=1`, { token: a.token })
    await new Promise((r) => setTimeout(r, 50))
    const noop = await commit(s, a.token, v, [{ put: ['pages/a.json', 'hello', 1] }])
    assert.equal(noop.body.results[0].noop, true)
    const t0 = Date.now()
    await waiting
    assert.ok(Date.now() - t0 > 500, 'it kept waiting')
  })
})
