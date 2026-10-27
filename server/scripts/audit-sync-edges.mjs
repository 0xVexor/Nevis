// Diagnostic reproductions, not acceptance tests. Exit 0 means the probes ran;
// inspect `observed` and `hazard` below. Each probe uses a disposable in-memory
// database and object store; no credentials or production services are used.
import assert from 'node:assert/strict'
import { call, changes, commit, newVault, putBlob, register, setup, sha } from '../test/helpers.js'
import { runGc } from '../src/gc.js'
import { usedBytes } from '../src/blobs.js'

const results = []
async function probe(id, title, expected, run, cfg = {}) {
  const s = await setup(cfg)
  try {
    const a = await register(s)
    const v = await newVault(s, a.token)
    const { observed, hazard } = await run(s, a, v)
    results.push({ id, title, expected, observed, hazard })
  } finally {
    await s.close()
  }
}

await probe('SYNC-01', 'Database record paths', 'Client-supported database paths can be committed', async (s, a, v) => {
  const r = await commit(s, a.token, v, [{ put: ['databases/views/a.json', '{}'] }])
  return { observed: r.body.results[0], hazard: r.body.results[0].error === 'bad_path' }
})

await probe('SYNC-02', 'Full reset after compaction', 'A new client can fetch a complete live snapshot', async (s, a, v) => {
  await commit(s, a.token, v, [{ put: ['pages/live.json', 'still here'] }])
  const p = await commit(s, a.token, v, [{ put: ['pages/deleted.json', 'gone'] }])
  await commit(s, a.token, v, [{ del: ['pages/deleted.json', p.body.results[0].rev] }])
  s.clock.t += 31 * 86400000
  await runGc({ ...s, now: s.clock.t })
  const first = await changes(s, a.token, v, 0)
  const retry = await changes(s, a.token, v, 0)
  const full = await call(s, 'GET', `/v1/vaults/${v}/snapshot`, { token: a.token })
  return { observed: { incremental: first.status, retry: retry.status, snapshot: full.status, paths: full.body.files?.map(f => f.path) }, hazard: full.status !== 200 || !full.body.files?.some(f => f.path === 'pages/live.json') }
})

await probe('SYNC-22', 'Empty blob', 'A zero-byte file can be uploaded using its valid SHA-256', async (s, a, v) => {
  const r = await call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha('')}`, { token: a.token, body: Buffer.alloc(0) })
  return { observed: { status: r.status, body: r.body }, hazard: r.status === 400 && r.body.error === 'bad_range' }
})

await probe('SYNC-23', 'Concurrent quota checks', 'Concurrent uploads cannot exceed the account quota', async (s, a, v) => {
  const replies = await Promise.all(['aaaaaa', 'bbbbbb'].map(body => call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha(body)}`, { token: a.token, body: Buffer.from(body) })))
  const used = usedBytes(s.db, a.userId)
  return { observed: { statuses: replies.map(r => r.status), used, quota: s.cfg.quotaBytes }, hazard: used > s.cfg.quotaBytes }
}, { quotaBytes: 10 })

await probe('SYNC-24', 'Commit while GC deletes an orphan', 'A successful commit keeps its referenced blob downloadable', async (s, a, v) => {
  const hash = await putBlob(s, a.token, v, 'only copy')
  s.clock.t += 2 * 86400000
  const originalDel = s.storage.del.bind(s.storage)
  let committed
  // Force the legal interleaving: GC selected the orphan, then the commit
  // arrives while asynchronous object deletion is in progress.
  s.storage.del = async key => {
    if (key.includes(hash)) {
      committed = await call(s, 'POST', `/v1/vaults/${v}/commit`, { token: a.token, body: { op_id: 'gc-race-operation', ops: [{ op: 'put', path: 'pages/a.json', base_rev: 0, sha256: hash }] } })
    }
    return originalDel(key)
  }
  await runGc({ ...s, now: s.clock.t })
  assert.ok(committed, 'GC reached the intended interleaving')
  const r = await call(s, 'GET', `/v1/vaults/${v}/rev/${committed.body.results[0].rev}`, { token: a.token })
  return { observed: { commitOk: committed.body.results[0].ok, download: r.status, body: r.body }, hazard: committed.body.results[0].ok === true && r.status === 404 }
})

await probe('SYNC-25', 'Case-only replacement after deletion', 'A deleted case variant does not indefinitely reserve the live path', async (s, a, v) => {
  const p = await commit(s, a.token, v, [{ put: ['pages/A.json', 'old'] }])
  await commit(s, a.token, v, [{ del: ['pages/A.json', p.body.results[0].rev] }])
  const r = await commit(s, a.token, v, [{ put: ['pages/a.json', 'new'] }])
  return { observed: r.body.results[0], hazard: r.body.results[0].error === 'path_case_clash' }
})

await probe('SYNC-26', 'Scope of the server bulk-delete guard', 'An independent server guard detects a whole-vault deletion split into requests', async (s, a, v) => {
  const p = await commit(s, a.token, v, Array.from({ length: 6 }, (_, i) => ({ put: [`pages/${i}.json`, `${i}`] })))
  const deleted = []
  for (let i = 0; i < 6; i++) {
    const r = await commit(s, a.token, v, [{ del: [`pages/${i}.json`, p.body.results[i].rev] }])
    deleted.push(r.body.results[0].ok)
  }
  return { observed: { deletedWithoutConfirmation: deleted }, hazard: deleted.every(Boolean) }
})

await probe('SYNC-27', 'Restore while expired-vault GC runs', 'A successful restore is serialized against permanent deletion', async (s, a, v) => {
  await commit(s, a.token, v, [{ put: ['pages/a.json', 'kept'] }])
  await call(s, 'DELETE', `/v1/vaults/${v}`, { token: a.token })
  s.clock.t += 31 * 86400000
  const originalDel = s.storage.del.bind(s.storage)
  let restore
  s.storage.del = async key => {
    if (!restore) restore = await call(s, 'POST', `/v1/vaults/${v}/undelete`, { token: a.token, body: {} })
    return originalDel(key)
  }
  await runGc({ ...s, now: s.clock.t })
  assert.ok(restore, 'GC reached the intended restore interleaving')
  const r = await call(s, 'GET', `/v1/vaults/${v}/state`, { token: a.token })
  return { observed: { restore: restore.status, afterGc: r.status, body: r.body }, hazard: restore.status === 200 && r.status === 404 }
})

console.log(JSON.stringify({ meaning: 'hazard=true confirms the described problem or guard limitation; exit 0 does not mean the product is correct', probes: results.length, hazardsObserved: results.filter(r => r.hazard).length, results }, null, 2))
