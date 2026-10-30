import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv from './tests/tools/node_modules/ajv/dist/ajv.js'
import './tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { documentToolContracts } from '../spike/tiptap/src/documents/contracts.ts'
import { identifyBlocks } from '../spike/tiptap/src/documents/blockIdentity.ts'
import { PortableLexicalIndex, sourcePassage } from '../spike/tiptap/src/documents/lexicalSearch.ts'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { IndexedDbDocumentStorage } from '../spike/tiptap/src/platform/documents/indexedDb.ts'

const raw = JSON.parse(readFileSync(new URL('./fixtures/agent-documents/pages.json', import.meta.url), 'utf8'))
raw[1].content.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'عَلْمـ 😀' }] })
const pages = raw.map(page => ({ ...page, content: identifyBlocks(page.content).content }))
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const schema = new Ajv({ strict: true }).compile(documentToolContracts.search_documents.outputSchema)
const valid = result => assert.equal(schema({ ok: true, result }), true, JSON.stringify(schema.errors))
const write = upserts => ({ upserts, removed: [], replaceAll: false, baseVersions: {} })
async function reader(storage) {
  await storage.save(write(pages))
  const host = { now: () => 1, createId: randomUUID, defer: () => () => {}, emit() {}, report() {} }
  const service = new DocumentService({ storage, host })
  await service.init()
  return service.reader({ context: { vaultHandle: 'search', grantId: 'grant', grantRevision: '1' }, isActive: () => true, canRead: value => value !== id(7) },
    { now: () => 1, cursorId: randomUUID, digest: async text => createHash('sha256').update(text).digest('hex') })
}
function openDb() {
  let opening
  return () => opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(`search-${randomUUID()}`, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages', { keyPath: 'id' })
      request.result.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

test('judged lexical cases preserve Persian spans, exact code, phrase order and metadata ranking', t => {
  const before = JSON.stringify(pages), started = performance.now()
  const index = new PortableLexicalIndex(pages.filter(page => page.id !== id(7)))
  const built = performance.now()
  const persian = index.search('کلاس 123', 'keywords').find(hit => hit.documentId === id(2))
  assert.ok(sourcePassage(persian, 512).includes('كلاس'))
  assert.ok(sourcePassage(persian, 512).includes('۱۲۳'))
  assert.ok(sourcePassage(index.search('برنامه نویسی', 'phrase')[0], 512).includes('برنامه‌نویسی'))
  assert.ok(sourcePassage(index.search('علم', 'keywords')[0], 512).includes('عَلْمـ'))
  assert.ok(index.search('count++', 'literal').some(hit => hit.text.includes('count++;')))
  assert.equal(index.search('Count++', 'literal').length, 0)
  assert.ok(index.search('second example', 'phrase').some(hit => hit.text.startsWith('Second example:')))
  assert.equal(index.search('example second', 'phrase').length, 0)
  assert.equal(index.search('java', 'keywords')[0].source, 'title')
  assert.ok(index.search('java', 'keywords').some(hit => hit.source === 'tag' && hit.blockId === null))
  assert.ok(index.search('Java synchronized', 'keywords').some(hit => hit.source === 'body'))
  assert.equal(JSON.stringify(pages), before)
  t.diagnostic(`fixture: ${JSON.stringify(index.statistics())}; cold build ${(built - started).toFixed(2)}ms; judged queries ${(performance.now() - built).toFixed(2)}ms`)
})

test('memory and IndexedDB run identical scoped search and rich attribute hits resolve to the read revision', async () => {
  const results = []
  for (const storage of [new MemoryDocumentStorage('search'), new IndexedDbDocumentStorage('search', openDb())]) {
    const api = await reader(storage)
    const result = await api.searchDocuments({ query: 'E = mc^2', mode: 'literal', documentIds: [id(4)] })
    valid(result)
    assert.equal(result.hits.length, 1)
    const hit = result.hits[0]
    const read = await api.readDocument({ documentId: hit.documentId, expectedRevision: hit.revision, target: { kind: 'blocks', blockIds: [hit.range.fromBlockId] }, format: 'structured' })
    assert.equal(read.chunks[0].structured[0].attrs.latex, hit.passage)
    assert.equal(result.search.indexedRevision, hit.revision)
    const diagram = await api.searchDocuments({ query: 'Read --> Validate', mode: 'literal' })
    assert.ok(diagram.hits.some(item => item.passage.includes('flowchart LR')))
    const title = await api.searchDocuments({ query: 'Happens-before', mode: 'literal', tags: pages[2].tags })
    valid(title)
    assert.equal(title.hits[0].source, 'title')
    assert.equal(title.hits[0].range, null)
    results.push({ result, diagram, title })
  }
  assert.deepEqual(results[0], results[1])
})

test('search pagination obeys budgets/scope and rejects changed visible snapshots without hidden-note influence', async () => {
  const storage = new MemoryDocumentStorage('search'), api = await reader(storage)
  assert.equal((await api.searchDocuments({ query: pages[6].title, mode: 'literal' })).hits.length, 0)
  await assert.rejects(api.searchDocuments({ query: 'anything', mode: 'keywords', documentIds: [id(7)] }), error => error.code === 'ACCESS_DENIED')
  const query = { query: 'example', mode: 'keywords', documentIds: [id(2)], limit: 1 }
  const first = await api.searchDocuments(query)
  valid(first)
  assert.equal(first.truncated, true)
  await storage.save(write([{ ...pages[6], title: 'hidden change' }]))
  const next = await api.searchDocuments({ ...query, cursor: first.nextCursor })
  assert.notEqual(next.hits[0].range.fromBlockId, first.hits[0].range.fromBlockId)
  await assert.rejects(api.searchDocuments({ ...query, budget: { maxChars: 1, maxBlocks: 1 } }), error => error.code === 'LIMIT_EXCEEDED')
  await storage.save(write([{ ...pages[1], title: 'same timestamp change' }]))
  await assert.rejects(api.searchDocuments({ ...query, cursor: first.nextCursor }), error => error.code === 'STALE_CURSOR')
})
