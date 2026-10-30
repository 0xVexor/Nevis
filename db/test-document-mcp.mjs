import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import Ajv from './tests/tools/node_modules/ajv/dist/ajv.js'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { McpDocumentSession, McpDocumentScope, MCP_PROTOCOL, matchesDocumentSchema, validMcpPolicy } from '../spike/tiptap/src/documents/mcp.ts'
import { documentToolContracts } from '../spike/tiptap/src/documents/contracts.ts'

const digest = async text => createHash('sha256').update(text).digest('hex')
const body = text => ({ type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text }] }] })
const page = (id, parentId = null) => ({ id, parentId, title: id, tags: [], favorite: false, sort: 0, updatedAt: 1, deletedAt: null, content: body(`فارسی saved ${id}`) })
export async function fixture({ policy = { wholeVault: true, rootIds: [], excludedIds: ['private'], allowWrites: false }, writesReleased = false } = {}) {
  let active = true, now = 100, sequence = 0
  const storage = new MemoryDocumentStorage('fixed', [page('outer'), page('root', 'outer'), page('note', 'root'), page('private', 'root'), page('secret', 'private')])
  const host = { now: () => now, createId: () => `generated-${++sequence}`, defer: () => () => {}, emit() {}, report() {}}
  const service = new DocumentService({ storage, host }); await service.init()
  const runtime = { now: () => now, cursorId: randomUUID, digest }
  const connection = { vaultId: 'vault', grantId: 'grant', revision: 'revision', policy }
  const session = new McpDocumentSession(service, connection, runtime, () => active, writesReleased)
  const dispatch = message => session.dispatch(message, { id: randomUUID(), expiresAt: now + 1000, active: () => active })
  let id = 0
  const rpc = (method, params) => dispatch({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) })
  const initialize = async () => { const result = await rpc('initialize', { protocolVersion: MCP_PROTOCOL, clientInfo: { name: 'test', version: '1' }, capabilities: {} }); assert.equal(result.result.protocolVersion, MCP_PROTOCOL); await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }) }
  const checks = Object.fromEntries(Object.entries(documentToolContracts).map(([name, contract]) => [name, new Ajv({ strict: true }).compile(contract.outputSchema)]))
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args })
    assert.ok(result.result, JSON.stringify(result)); const out = result.result.structuredContent
    assert.ok(checks[name](out), JSON.stringify(checks[name].errors)); assert.equal(result.result.content[0].text, JSON.stringify(out))
    return out
  }
  return { service, storage, session, connection, dispatch, rpc, initialize, call, revoke: () => { active = false }, expire: () => { now += 2000 } }
}

test('scopes inherit exclusions, hide missing/cyclic ancestry and preserve selected roots', () => {
  const policy = { wholeVault: false, rootIds: ['root'], excludedIds: ['private'], allowWrites: true }
  assert.ok(validMcpPolicy(policy)); assert.equal(validMcpPolicy({ ...policy, rootIds: [] }), false)
  const scope = new McpDocumentScope(policy)
  scope.observe([page('outer'), page('root', 'outer'), page('note', 'root'), page('private', 'root'), page('secret', 'private'), page('orphan', 'missing'), page('cycle', 'cycle')])
  for (const id of ['root', 'note']) assert.equal(scope.canRead(id), true)
  for (const id of ['outer', 'private', 'secret', 'orphan', 'cycle']) assert.equal(scope.canRead(id), false)
  assert.equal(scope.canCreate(null), false); assert.equal(scope.canCreate('root'), true); assert.equal(scope.canCreate('private'), false)
})

test('handshake, nine contracts, strict validation, bounded saved reads and explicit host write capability', async () => {
  const h = await fixture({ policy: { wholeVault: false, rootIds: ['root'], excludedIds: ['private'], allowWrites: true } })
  assert.equal((await h.rpc('tools/list')).error.code, -32002); await h.initialize()
  const tools = (await h.rpc('tools/list')).result.tools
  assert.deepEqual(tools.map(t => t.name), Object.keys(documentToolContracts))
  assert.equal((await h.rpc('tools/list', { cursor: 'unknown' })).error.code, -32602)
  const capabilities = await h.call('get_editor_capabilities'); assert.equal(capabilities.ok, true); assert.ok(capabilities.result.nodes.some(node => node.type === 'mermaid' && node.attributes.code)); assert.ok(capabilities.result.marks.some(mark => mark.type === 'link'))
  const listed = await h.call('list_documents'); assert.deepEqual(listed.result.documents.map(d => d.documentId).sort(), ['note', 'root'])
  assert.equal(listed.result.documents.find(d => d.documentId === 'root').parentId, null)
  assert.equal((await h.call('read_document', { documentId: 'secret', target: { kind: 'full' }, format: 'both' })).error.code, 'ACCESS_DENIED')
  h.service.update('note', { content: body('unsaved PRIVATE draft') }); h.service.setEditorDirty('note', true)
  const read = await h.call('read_document', { documentId: 'note', target: { kind: 'full' }, format: 'both' })
  assert.equal(read.ok, true); assert.ok(JSON.stringify(read).includes('فارسی saved note')); assert.ok(!JSON.stringify(read).includes('PRIVATE'))
  const search = await h.call('search_documents', { query: 'saved', mode: 'keywords' }); assert.equal(search.ok, true); assert.ok(!JSON.stringify(search).includes('secret'))
  assert.equal((await h.call('get_document_history', { documentId: 'note' })).ok, true)
  assert.equal((await h.call('list_documents', { limit: 101 })).error.code, 'INVALID_ARGUMENT')
  assert.equal((await h.call('list_documents', JSON.parse('{"constructor":{}}'))).error.code, 'INVALID_ARGUMENT')
  assert.equal((await h.call('create_document', { operationId: 'create', parentId: 'root', kind: 'page', metadata: { title: 'test', tags: [], favorite: false }, content: { type: 'doc', content: [] } })).error.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal((await h.rpc('tools/call', { name: '__proto__' })).error.code, -32602)
  const schema = documentToolContracts.read_document.inputSchema
  assert.equal(matchesDocumentSchema({ documentId: 'note', target: { kind: 'full' }, format: 'both', extra: true }, schema), false)
  h.revoke(); assert.equal((await h.rpc('tools/list')).error.code, -32000)
})

test('all mutation handlers delegate to shared services with receipts/history under a test-only write grant', async () => {
  const h = await fixture({ policy: { wholeVault: true, rootIds: [], excludedIds: ['private'], allowWrites: true }, writesReleased: true }); await h.initialize()
  const created = await h.call('create_document', { operationId: 'create', parentId: 'root', kind: 'page', metadata: { title: 'created', tags: [], favorite: false }, content: { type: 'doc', content: [{ type: 'paragraph' }] } })
  assert.equal(created.ok, true)
  const renamed = await h.call('update_document_metadata', { documentId: created.result.documentId, operationId: 'rename', expectedRevision: created.result.revision, patch: { title: 'renamed' } }); assert.equal(renamed.ok, true)
  const edited = await h.call('edit_document', { documentId: created.result.documentId, operationId: 'edit', expectedRevision: renamed.result.revision, mode: 'apply', operations: [{ kind: 'insert_blocks', at: { position: 'end', parent: null }, blocks: [{ temporaryId: 'new', node: { type: 'paragraph', content: [{ type: 'text', text: 'agent text' }] } }] }] }); assert.equal(edited.ok, true)
  const history = await h.call('get_document_history', { documentId: created.result.documentId }); assert.equal(history.result.versions.length, 5)
  const undone = await h.call('undo_document_edit', { documentId: created.result.documentId, operationId: 'undo', undoOperationId: 'edit', expectedRevision: edited.result.saved.revision }); assert.equal(undone.ok, true)
  const retry = await h.call('create_document', { operationId: 'create', parentId: 'root', kind: 'page', metadata: { title: 'created', tags: [], favorite: false }, content: { type: 'doc', content: [{ type: 'paragraph' }] } }); assert.equal(retry.result.replayed, true)
})

test('scope changes during async reads, revocation, deadlines and unexpected errors disclose no content', async () => {
  const h = await fixture(); await h.initialize()
  const original = h.storage.load.bind(h.storage); let loads = 0
  h.storage.load = async () => { const result = await original(); if (++loads === 3) return result.map(p => p.id === 'note' ? { ...p, parentId: 'private' } : p); return result }
  const changed = await h.call('read_document', { documentId: 'note', target: { kind: 'full' }, format: 'both' }); assert.equal(changed.error.code, 'ACCESS_DENIED')
  h.storage.load = async () => { throw new Error('secret note body and password') }
  const failed = await h.call('list_documents'); assert.equal(failed.error.code, 'APP_UNAVAILABLE'); assert.ok(!JSON.stringify(failed).includes('password'))
  h.storage.load = async () => { h.expire(); return original() }
  const expired = await h.call('list_documents'); assert.equal(expired.error.code, 'APP_UNAVAILABLE')
  h.session.close(); assert.equal((await h.rpc('tools/list')).error.code, -32000)
})


test('webview dispatch remains bounded when a storage read stalls', async () => {
  const h = await fixture(); await h.initialize()
  const load = h.storage.load.bind(h.storage)
  let release, entered
  const blocked = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  h.storage.load = async () => { entered(); await blocked; return load() }
  const pending = [h.rpc('tools/call', { name: 'list_documents', arguments: {} })]
  await started
  for (let i = 0; i < 7; i++) pending.push(h.rpc('ping'))
  assert.equal((await h.rpc('ping')).error.message, 'Request capacity exceeded')
  release(); await Promise.all(pending)
  assert.deepEqual((await h.rpc('ping')).result, {})
})
