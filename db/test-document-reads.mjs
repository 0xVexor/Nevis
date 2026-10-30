import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv from './tests/tools/node_modules/ajv/dist/ajv.js'
import { documentToolContracts } from '../spike/tiptap/src/documents/contracts.ts'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { identifyBlocks } from '../spike/tiptap/src/documents/blockIdentity.ts'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/agent-documents/pages.json', import.meta.url), 'utf8'))
const pageId = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ajv = new Ajv({ strict: true })
const checks = Object.fromEntries(['list_documents', 'read_document'].map(name => [name, ajv.compile(documentToolContracts[name].outputSchema)]))
const valid = (tool, result) => assert.equal(checks[tool]({ ok: true, result }), true, JSON.stringify(checks[tool].errors))
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code)
async function setup() {
  const pages = fixtures.map(page => ({ ...page, content: identifyBlocks(page.content).content }))
  const storage = new MemoryDocumentStorage('fixed', pages)
  let now = 1000, active = true
  const host = { now: () => now, createId: randomUUID, defer: () => () => {}, emit() {}, report() {} }
  const service = new DocumentService({ storage, host })
  await service.init()
  const grant = { context: { vaultHandle: 'fixed', grantId: 'grant', grantRevision: '1' }, isActive: () => active, canRead: id => id !== pageId(7) }
  const reader = service.reader(grant, { now: () => now, cursorId: randomUUID, digest: async text => createHash('sha256').update(text).digest('hex') })
  return { reader, storage, pages, expire: () => { now += 900001 }, revoke: () => { active = false } }
}

test('browse: deterministic hierarchy/filter pages hide exclusions and bind cursors to arguments and grant', async () => {
  const h = await setup()
  const first = await h.reader.listDocuments({ parentId: pageId(1), limit: 2 })
  valid('list_documents', first)
  assert.equal(first.documents.length, 2)
  const second = await h.reader.listDocuments({ parentId: pageId(1), limit: 2, cursor: first.nextCursor })
  assert.ok(second.documents.every(page => !first.documents.some(old => old.documentId === page.documentId)))
  const all = await h.reader.listDocuments()
  assert.ok(all.documents.every(page => ![pageId(7), pageId(8)].includes(page.documentId)))
  const tagged = await h.reader.listDocuments({ tags: ['fixture'], kinds: ['folder'] })
  assert.deepEqual(tagged.documents.map(page => page.documentId), [pageId(1)])
  await rejects(h.reader.listDocuments({ limit: 3, cursor: first.nextCursor }), 'STALE_CURSOR')
  await rejects(h.reader.readDocument({ documentId: pageId(7), target: { kind: 'full' }, format: 'both' }), 'ACCESS_DENIED')
  h.revoke()
  await rejects(h.reader.listDocuments({ parentId: pageId(1), limit: 2, cursor: first.nextCursor }), 'ACCESS_DENIED')
})

test('selective reads: duplicate headings, section 60, nested targets and bounded continuations preserve source', async () => {
  const { reader, pages } = await setup()
  const long = pages.find(page => page.id === pageId(5))
  const heading = long.content.content.filter(node => node.type === 'heading')[59]
  const section = await reader.readDocument({ documentId: long.id, target: { kind: 'section', headingBlockId: heading.attrs.blockId }, format: 'both' })
  valid('read_document', section)
  assert.equal(section.chunks[0].range.fromBlockId, heading.attrs.blockId)
  assert.ok(section.chunks.length < 10)
  const mixed = pages.find(page => page.id === pageId(2))
  const outline = await reader.readDocument({ documentId: mixed.id, target: { kind: 'outline' }, format: 'structured' })
  assert.equal(new Set(outline.chunks.map(chunk => chunk.range.fromBlockId)).size, outline.chunks.length)
  const duplicate = outline.chunks.filter(chunk => chunk.structured[0].content[0].text === 'Example')[1]
  const exact = await reader.readDocument({ documentId: mixed.id, target: { kind: 'section', headingBlockId: duplicate.range.fromBlockId }, format: 'both' })
  assert.ok(exact.chunks.some(chunk => chunk.markdown?.includes('Second example')))
  assert.ok(exact.chunks.every(chunk => !chunk.markdown?.includes('First example')))
  const request = { documentId: long.id, target: { kind: 'full' }, format: 'structured', budget: { maxChars: 8000, maxBlocks: 2 } }
  const first = await reader.readDocument(request)
  const next = await reader.readDocument({ ...request, cursor: first.nextCursor })
  assert.equal(first.truncated, true)
  assert.notEqual(first.chunks[0].range.fromBlockId, next.chunks[0].range.fromBlockId)
  const table = pages.find(page => page.id === pageId(4)).content.content.find(node => node.type === 'table')
  const nested = table.content[1].content[1].content[0]
  const block = await reader.readDocument({ documentId: pageId(4), target: { kind: 'blocks', blockIds: [nested.attrs.blockId] }, format: 'structured' })
  assert.deepEqual(block.chunks[0].structured, [nested])
  await rejects(reader.readDocument({ documentId: pageId(4), target: { kind: 'blocks', blockIds: [table.attrs.blockId, nested.attrs.blockId] }, format: 'both' }), 'INVALID_TARGET')
})

test('read safety: unsupported JSON is retained, budgets fail explicitly, revisions/expired cursors reject stale reads', async () => {
  const h = await setup()
  const request = { documentId: pageId(6), target: { kind: 'full' }, format: 'both' }
  const read = await h.reader.readDocument(request)
  valid('read_document', read)
  const unsupported = h.pages.find(page => page.id === pageId(6)).content.content.find(node => node.type === 'futureWidget')
  assert.deepEqual(read.chunks.find(chunk => chunk.structured?.[0].type === 'futureWidget').structured, [unsupported])
  assert.ok(read.warnings.some(warning => warning.code === 'UNSUPPORTED_CONTENT'))
  await rejects(h.reader.readDocument({ ...request, budget: { maxChars: 1, maxBlocks: 1 } }), 'LIMIT_EXCEEDED')
  const bounded = { ...request, budget: { maxChars: 8000, maxBlocks: 1 } }
  const first = await h.reader.readDocument(bounded)
  h.expire()
  await rejects(h.reader.readDocument({ ...bounded, cursor: first.nextCursor }), 'STALE_CURSOR')
  const changed = structuredClone(h.pages.find(page => page.id === pageId(6)))
  changed.title += ' changed without timestamp'
  await h.storage.save({ upserts: [changed], removed: [], replaceAll: false, baseVersions: {} })
  await rejects(h.reader.readDocument({ ...request, expectedRevision: read.revision }), 'REVISION_CONFLICT')
})
