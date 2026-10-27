import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import Ajv from './tests/tools/node_modules/ajv/dist/ajv.js'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { identifyBlocks } from '../spike/tiptap/src/documents/blockIdentity.ts'
import { PortableLexicalIndex } from '../spike/tiptap/src/documents/lexicalSearch.ts'
import { ManagedLexicalIndex } from '../spike/tiptap/src/documents/searchLifecycle.ts'
import { documentToolContracts } from '../spike/tiptap/src/documents/contracts.ts'

const page = text => ({ id: 'note', parentId: null, title: 'note', favorite: false, sort: 0, updatedAt: 1, deletedAt: null,
  content: identifyBlocks({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }).content })
const write = upserts => ({ upserts, removed: [], replaceAll: false, baseVersions: {} })
const schema = new Ajv({ strict: true }).compile(documentToolContracts.search_documents.outputSchema)
const readRuntime = { now: () => 1, cursorId: randomUUID, digest: async value => createHash('sha256').update(value).digest('hex') }
function setup(search = {}) {
  const storage = new MemoryDocumentStorage('fixed', [page('initial')]), events = []
  const host = { now: () => 1, createId: randomUUID, defer: () => () => {}, emit: (event, detail) => events.push({ event, detail }), report() {} }
  const service = new DocumentService({ storage, host, search })
  const reader = service.reader({ context: { vaultHandle: 'fixed', grantId: 'grant', grantRevision: '1' }, isActive: () => true, canRead: () => true }, readRuntime)
  return { service, storage, events, reader, host }
}

test('save/reload/adopt/restore/startup reconcile same-timestamp edits and remove deleted notes from UI/scoped search', async () => {
  let builds = 0
  const h = setup({ build: pages => { builds++; return new PortableLexicalIndex(pages) } })
  await h.service.init()
  assert.equal((await h.service.searchPersisted('initial')).length, 1)
  await h.service.searchPersisted('initial')
  assert.equal(builds, 1)
  h.service.update('note', { content: page('saved').content }, { history: false })
  await h.service.flushBeforeUpdate()
  assert.equal(h.service.searchStatus(), 'pending')
  assert.equal((await h.service.searchPersisted('saved')).length, 1)
  assert.equal((await h.service.searchPersisted('initial')).length, 0)
  h.service.remove('note'); await h.service.flushed()
  assert.equal((await h.service.searchPersisted('saved')).length, 0)
  h.service.restoreFromTrash('note'); await h.service.flushed()
  assert.equal((await h.reader.searchDocuments({ query: 'saved', mode: 'keywords' })).hits.length, 1)
  await h.storage.save(write([page('synced')]))
  assert.equal(await h.service.refreshFromStore(), true)
  assert.ok(h.events.some(event => event.event === 'external-change' && event.detail.includes('note')))
  assert.equal((await h.service.searchPersisted('synced')).length, 1)
  await h.storage.save(write([page('adopted')]))
  h.service.adoptDatabase([page('adopted')], [])
  assert.equal((await h.service.searchPersisted('adopted')).length, 1)
  assert.equal((await h.reader.searchDocuments({ query: 'saved', mode: 'keywords' })).hits.length, 0)
  h.service.restore([page('restored')]); await h.service.flushed()
  const reopened = new DocumentService({ storage: h.storage, host: h.host })
  await reopened.init()
  assert.equal((await reopened.searchPersisted('restored')).length, 1)
  assert.equal((await reopened.searchPersisted('adopted')).length, 0)
  h.service.purge('note'); await h.service.flushed()
  assert.equal((await h.service.searchPersisted('restored')).length, 0)
})

test('failed indexing never rolls back a saved page or reports a fresh empty search; retry recovers', async () => {
  let fail = false
  const h = setup({ build: pages => { if (fail) throw Error('synthetic index failure'); return new PortableLexicalIndex(pages) } })
  await h.service.init()
  await h.service.searchPersisted('initial')
  h.service.update('note', { content: page('durable').content }, { history: false })
  fail = true
  await h.service.flushBeforeUpdate()
  await assert.rejects(h.service.searchPersisted('durable'), error => error.state === 'failed')
  assert.equal(h.service.searchStatus(), 'failed')
  const failed = await h.reader.searchDocuments({ query: 'durable', mode: 'keywords' })
  assert.equal(schema({ ok: true, result: failed }), true, JSON.stringify(schema.errors))
  assert.equal(failed.search.state, 'failed')
  assert.equal(failed.warnings[0].code, 'INDEX_FAILED')
  assert.deepEqual((await h.storage.load())[0].content, page('durable').content)
  await h.service.flushBeforeUpdate()
  fail = false
  assert.equal((await h.service.searchPersisted('durable')).length, 1)
  assert.equal((await h.reader.searchDocuments({ query: 'durable', mode: 'keywords' })).search.state, 'fresh')
})

test('superseded builds cannot publish and projection-version changes rebuild instead of reusing a stale cache', async () => {
  let release, builds = 0
  const waiting = new Promise(resolve => { release = resolve })
  const cache = new ManagedLexicalIndex({ yield: () => waiting, build: pages => { builds++; return new PortableLexicalIndex(pages) } })
  const old = cache.prepare([page('old')], 'old')
  cache.invalidate()
  const latest = cache.prepare([page('new')], 'new')
  assert.equal(cache.status(), 'pending')
  release()
  assert.equal((await old).state, 'pending')
  const ready = await latest
  assert.equal(ready.state, 'fresh')
  assert.equal(ready.index.search('old', 'keywords').length, 0)
  assert.equal(ready.index.search('new', 'keywords').length, 1)
  const count = builds
  await cache.prepare([page('new')], 'new')
  assert.equal(builds, count)
  await cache.prepare([page('new')], 'new', 2)
  assert.equal(builds, count + 1)
})
