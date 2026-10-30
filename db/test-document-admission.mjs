import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import './tests/tools/node_modules/fake-indexeddb/auto/index.mjs'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { IndexedDbDocumentStorage } from '../spike/tiptap/src/platform/documents/indexedDb.ts'
import { McpDocumentSession } from '../spike/tiptap/src/documents/mcp.ts'
import { documentRevision } from '../spike/tiptap/src/documents/revision.ts'
const digest = async value => createHash('sha256').update(value).digest('hex')
const page = (id, parentId = null) => ({ id, parentId, title: id, tags: [], favorite: false, sort: 0, updatedAt: 1, deletedAt: null, content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'p1' } }] } })
for (const backend of ['memory', 'indexeddb']) test(`${backend}: final admission rejects changed ancestor scope and cancellation without a receipt or partial save`, async () => {
 let active = true
 const open = () => new Promise((resolve, reject) => { const request = indexedDB.open(randomUUID(), 1); request.onupgradeneeded = () => { request.result.createObjectStore('pages', { keyPath: 'id' }); request.result.createObjectStore('kv'); request.result.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId') }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
 // Keep one database handle for this adapter, including concurrent transactions.
 const db = backend === 'indexeddb' ? await open() : null
 const storage = backend === 'memory' ? new MemoryDocumentStorage('fixed') : new IndexedDbDocumentStorage('fixed', async () => db)
 const rows = [page('root'), page('note', 'root'), page('private')]
 await storage.save({ upserts: rows, removed: [], replaceAll: true, baseVersions: {} })
 const service = new DocumentService({ storage, host: { now: () => 100, createId: randomUUID, defer: () => () => {}, emit() {}, report() {} } }); await service.init()
 const session = new McpDocumentSession(service, { vaultId: 'vault', grantId: 'grant', revision: 'revision', policy: { wholeVault: false, rootIds: ['root'], excludedIds: ['private'], allowWrites: true } }, { now: () => 100, cursorId: randomUUID, digest }, () => active, true)
 const send = message => session.dispatch(message, { id: randomUUID(), expiresAt: 1000, active: () => active })
 await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: {}, capabilities: {} } }); await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
 const original = storage.commitOperationResult.bind(storage)
 storage.commitOperationResult = async (record, admission) => {
  assert.ok(admission?.native.requestId)
  await storage.save({ upserts: [{ ...rows[0], parentId: 'private' }], removed: [], replaceAll: false, baseVersions: {} })
  return original(record, admission)
 }
 const input = { documentId: 'note', operationId: 'rename', expectedRevision: await documentRevision(rows[1], digest), patch: { title: 'must not save' } }
 const call = () => send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'update_document_metadata', arguments: input } })
 assert.equal((await call()).result.structuredContent.error.code, 'ACCESS_DENIED')
 assert.equal(await storage.findOperation('grant', 'rename'), null); assert.equal((await storage.load()).find(p => p.id === 'note').title, 'note')
 await storage.save({ upserts: [rows[0]], removed: [], replaceAll: false, baseVersions: {} })
 storage.commitOperationResult = async (record, admission) => { active = false; return original(record, admission) }
 assert.equal((await call()).result.structuredContent.error.code, 'APP_UNAVAILABLE')
 assert.equal(await storage.findOperation('grant', 'rename'), null); assert.equal((await storage.load()).find(p => p.id === 'note').title, 'note')
 db?.close()
})
