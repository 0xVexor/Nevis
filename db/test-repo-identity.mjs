import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Exercise the real Repo and its write queue against a memory implementation of
// the existing db adapter. No vault, singleton store or native runtime is loaded.
const mockDb = 'data:text/javascript;base64,' + Buffer.from(`
        const store = () => globalThis.identityTestStore;
        export const isTauri = true;
        export const allPages = async () => structuredClone(store().pages);
        export const vaultStamp = async () => store().stamp;
        export const listVersions = async () => [];
        export const addVersion = async () => {};
        export const deleteVersions = async () => {};
        export async function savePages(upserts, removed, full) {
          if (store().fail) throw Error('synthetic persistence failure');
          store().writes.push(structuredClone(upserts));
          const byId = new Map((full ? [] : store().pages).map(p => [p.id, p]));
          for (const page of upserts) { const { _base, ...saved } = page; byId.set(page.id, structuredClone(saved)); }
          for (const id of removed) byId.delete(id);
          store().pages = [...byId.values()];
          store().stamp += '!';
        }
`).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './db' && context.parentURL?.endsWith('/repo.ts')) return { url: mockDb, shortCircuit: true }
    try { return nextResolve(specifier, context) } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context)
      throw error
    }
  },
})
const { Repo } = await import('../spike/tiptap/src/repo.ts')
hooks.deregister()
const page = (id = 'doc', content = { type: 'doc', content: [{ type: 'paragraph', attrs: { dir: 'rtl' }, content: [{ type: 'text', text: 'سلام' }] }] }) =>
  ({ id, parentId: null, title: 'note', content, favorite: false, sort: 0, updatedAt: 1, deletedAt: null })
function setup(pages) {
  globalThis.identityTestStore = { pages: structuredClone(pages), stamp: 'initial', writes: [], fail: false }
  globalThis.window = Object.assign(new EventTarget(), { setTimeout })
  globalThis.localStorage = { getItem: () => null }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {} } })
  return globalThis.identityTestStore
}

test('repository persists one-time migration and reloads identical IDs after restart', async () => {
  const legacy = page()
  legacy.recordMeta = { revision: 7 }
  const store = setup([legacy])
  const repo = new Repo(() => [])
  await repo.init()
  assert.equal(store.writes.length, 1)
  assert.equal(store.writes[0][0]._base, 1)
  assert.equal(repo.get('doc').content.attrs.blockIdentityVersion, 1)
  assert.equal(repo.get('doc').recordMeta.revision, 8)
  const saved = JSON.stringify(repo.get('doc').content)
  const restarted = new Repo(() => [])
  await restarted.init()
  assert.equal(store.writes.length, 1)
  assert.equal(JSON.stringify(restarted.get('doc').content), saved)
})

test('repository handles sync legacy input, restore and copied pages', async () => {
  const store = setup([page()])
  const repo = new Repo(() => [])
  await repo.init()
  const original = structuredClone(repo.get('doc').content)
  const copy = repo.create(null)
  repo.update(copy.id, { content: original }, { copyContent: true })
  await repo.flushed()
  assert.notEqual(repo.get(copy.id).content.content[0].attrs.blockId, original.content[0].attrs.blockId)
  store.pages.push(page('synced'))
  store.stamp = 'external'
  assert.equal(await repo.refreshFromStore(), true)
  await repo.flushed()
  assert.ok(store.pages.find(p => p.id === 'synced').content.content[0].attrs.blockId)
  repo.restore([page('restored')])
  await repo.flushed()
  assert.equal(store.pages[0].id, 'restored')
  assert.ok(store.pages[0].content.content[0].attrs.blockId)
})

test('migration write failures remain pending and retry without changing IDs', async () => {
  const store = setup([page()])
  store.fail = true
  const repo = new Repo(() => [])
  const log = console.error
  console.error = () => {}
  try { await repo.init() } finally { console.error = log }
  const pending = JSON.stringify(repo.get('doc').content)
  store.fail = false
  await repo.flushBeforeUpdate()
  assert.equal(JSON.stringify(store.pages[0].content), pending)
})

test('future identity versions are retained without migration or body overwrite', async () => {
  const future = page('future', { type: 'doc', attrs: { blockIdentityVersion: 2 }, content: [{ type: 'paragraph' }] })
  const store = setup([future])
  const repo = new Repo(() => [])
  await repo.init()
  assert.equal(store.writes.length, 0)
  assert.throws(() => repo.update('future', { content: future.content }), /Unsupported/)
  assert.throws(() => repo.update('future', { content: { type: 'doc', content: [] } }), /Unsupported/)
  assert.deepEqual(store.pages[0], future)
})
