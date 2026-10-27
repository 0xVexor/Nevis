import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Load the repository against a storage seam without opening a browser or a real
// user vault. Keep the production repository implementation intact in the test.
const source = readFileSync(new URL('./repo.ts', import.meta.url), 'utf8')
  .replace(/^import .* from '\.\/normalize'\n/m, 'const normalizeFa = s => s\n')
  .replace(/^import .* from '\.\/db'\n/m, 'const { addVersion, allPages, deleteVersions, isTauri, listVersions, savePages, vaultStamp } = storage\n')
  .replace(/^export /gm, '')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const load = new Function('storage', 'window', 'localStorage', 'navigator', `${compiled}; return Repo`)
const page = (title = 'local', at = 100) => ({ id: 'p', parentId: null, title, favorite: false, sort: 0, content: { type: 'doc', content: [] }, updatedAt: at, deletedAt: null })

function harness(overrides = {}) {
  let rows = [page()], stamp = 'one'
  const events = [], writes = []
  const storage = {
    isTauri: true, allPages: async () => structuredClone(rows), vaultStamp: async () => stamp,
    savePages: async upserts => { writes.push(structuredClone(upserts)); rows = structuredClone(upserts); stamp += '!'; return { pages: rows } },
    addVersion: async () => {}, deleteVersions: async () => {}, listVersions: async () => [], ...overrides,
  }
  const window = { setTimeout: () => 1, dispatchEvent: e => { events.push(e); return true } }
  const Repo = load(storage, window, { getItem: () => null }, {})
  return { repo: new Repo(() => [page('seed')]), events, writes, setRows: r => { rows = r; stamp += '!' } }
}

test('a failed initial read never writes a replacement workspace', async () => {
  const h = harness({ allPages: async () => { throw new Error('read failed') } })
  await assert.rejects(h.repo.init(), /read failed/)
  assert.equal(h.writes.length, 0)
})

test('refresh notices equal-timestamp remote content changes', async () => {
  const h = harness()
  await h.repo.init()
  h.setRows([page('remote', 100)])
  await h.repo.poll()
  assert.equal(h.repo.get('p').title, 'remote')
  assert.ok(h.events.some(e => e.type === 'external-change'))
})

test('a write records the persisted version returned by storage, including a retained newer page', async () => {
  const writes = []
  const h = harness({ savePages: async upserts => { writes.push(structuredClone(upserts)); return { pages: [page('newer on disk', 500)] } } })
  await h.repo.init()
  h.repo.update('p', { title: 'first' })
  await h.repo.flushed()
  h.repo.update('p', { title: 'next' })
  await h.repo.flushed()
  assert.equal(writes[1][0]._base, 500)
})

test('restoring a complete version retains metadata and repairs a cyclic parent', async () => {
  const h = harness()
  await h.repo.init()
  h.repo.update('p', { icon: 'i:star' }, { history: false })
  h.repo.restoreVersion('p', { title: 'restored', content: { type: 'doc', content: [] }, page: { parentId: 'p', tags: ['kept'], cover: { kind: 'image', file: 'abc' }, favorite: true } })
  assert.equal(h.repo.get('p').parentId, null)
  assert.deepEqual(h.repo.get('p').tags, ['kept'])
  assert.equal(h.repo.get('p').cover.file, 'abc')
  assert.equal(h.repo.get('p').favorite, true)
  assert.equal(h.repo.get('p').icon, undefined)
})

test('an in-flight refresh cannot replace an edit queued after it began', async () => {
  let reads = 0, release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const h = harness({
    vaultStamp: async () => 'fixed-stamp',
    allPages: async () => { if (++reads === 1) return [page()]; entered(); return blocked },
  })
  await h.repo.init()
  const refreshing = h.repo.poll()
  await ready
  h.repo.update('p', { title: 'typed while refreshing' })
  await h.repo.flushed()
  release([page('stale read')])
  await refreshing
  assert.equal(h.repo.get('p').title, 'typed while refreshing')
})
