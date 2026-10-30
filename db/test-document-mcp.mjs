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
export async function fixture({ policy = { wholeVault: true, rootIds: [], excludedIds: ['private'], allowWrites: false }, writesReleased = false, markdown } = {}) {
  let active = true, now = 100, sequence = 0
  const storage = new MemoryDocumentStorage('fixed', [page('outer'), page('root', 'outer'), page('note', 'root'), page('private', 'root'), page('secret', 'private')])
  const host = { now: () => now, createId: () => `generated-${++sequence}`, defer: () => () => {}, emit() {}, report() {}}
  const service = new DocumentService({ storage, host }); await service.init()
  const runtime = { now: () => now, cursorId: randomUUID, digest }
  const connection = { vaultId: 'vault', grantId: 'grant', revision: 'revision', policy }
  const session = new McpDocumentSession(service, connection, runtime, () => active, writesReleased, markdown)
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

test('markdown is accepted for create_document and insert_markdown, converted before validation, and retries replay', async () => {
  // the real converter lives in the webview; here a stand-in turns each non-empty line into a paragraph
  const markdown = text => text.split('\n').filter(Boolean).map(line => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
  const h = await fixture({ policy: { wholeVault: true, rootIds: [], excludedIds: ['private'], allowWrites: true }, writesReleased: true, markdown }); await h.initialize()
  const args = { operationId: 'md-create', parentId: 'root', kind: 'page', metadata: { title: 'from markdown', tags: [], favorite: false }, markdown: 'first line\nsecond line فارسی' }
  const created = await h.call('create_document', args); assert.equal(created.ok, true, JSON.stringify(created))
  const read = await h.call('read_document', { documentId: created.result.documentId, target: { kind: 'full' }, format: 'markdown' })
  assert.match(JSON.stringify(read), /second line فارسی/)
  assert.equal((await h.call('create_document', args)).result.replayed, true)
  const both = await h.call('create_document', { ...args, operationId: 'md-both', content: { type: 'doc', content: [{ type: 'paragraph' }] } }); assert.equal(both.ok, false); assert.equal(both.error.code, 'INVALID_ARGUMENT')
  const neither = { ...args, operationId: 'md-neither' }; delete neither.markdown
  assert.equal((await h.call('create_document', neither)).error.code, 'INVALID_ARGUMENT')
  const edit = { documentId: created.result.documentId, operationId: 'md-edit', expectedRevision: created.result.revision, mode: 'apply', operations: [{ kind: 'insert_markdown', at: { position: 'end', parent: null }, markdown: 'appended by markdown' }] }
  const edited = await h.call('edit_document', edit); assert.equal(edited.ok, true, JSON.stringify(edited))
  assert.match(JSON.stringify(await h.call('read_document', { documentId: created.result.documentId, target: { kind: 'full' }, format: 'markdown' })), /appended by markdown/)
  const plain = await fixture({ policy: { wholeVault: true, rootIds: [], excludedIds: [], allowWrites: true }, writesReleased: true }); await plain.initialize()
  assert.equal((await plain.call('create_document', args)).error.code, 'CAPABILITY_UNAVAILABLE')
})

test('pages saved as an HTML string by old versions are converted once and become readable with stable block ids', async () => {
  const legacy = { ...page('legacy'), content: '<p>old فارسی page</p>' }
  const storage = new MemoryDocumentStorage('fixed', [legacy])
  const host = { now: () => 100, createId: () => 'x', defer: () => () => {}, emit() {}, report() {}, legacyHtmlToDoc: html => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: html.replace(/<[^>]+>/g, '') }] }] }) }
  const service = new DocumentService({ storage, host }); await service.init()
  const session = new McpDocumentSession(service, { vaultId: 'vault', grantId: 'grant', revision: 'revision', policy: { wholeVault: true, rootIds: [], excludedIds: [], allowWrites: false } }, { now: () => 100, cursorId: randomUUID, digest }, () => true, false)
  const send = (message) => session.dispatch(message, { id: randomUUID(), expiresAt: 1100, active: () => true })
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, clientInfo: { name: 'test', version: '1' }, capabilities: {} } })
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const read = await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_document', arguments: { documentId: 'legacy', target: { kind: 'full' }, format: 'markdown' } } })
  assert.equal(read.result.structuredContent.ok, true, JSON.stringify(read.result.structuredContent))
  assert.match(JSON.stringify(read.result.structuredContent), /old فارسی page/)
})

test('database tools list, describe and read rows as plain values, and respect the document scope', async () => {
  const { DatabaseService: DbService } = await import('../spike/tiptap/src/database/service.ts')
  const { MemoryPages } = await import('../spike/tiptap/src/database/state.ts')
  const { MemoryStorage } = await import('../spike/tiptap/src/database/storage/memory.ts')
  const { MemoryPageHost } = await import('../spike/tiptap/src/database/fixtures.ts')
  const { createDatabaseTools } = await import('../spike/tiptap/src/database/mcpTools.ts')
  const dbPages = new MemoryPages()
  const dbService = new DbService({ vaultId: 'v', storage: new MemoryStorage(dbPages), pages: dbPages, host: new MemoryPageHost(dbPages), deviceId: 'D1', zone: 'UTC' })
  await dbService.open()
  const created = await dbService.one('database.create', { title: 'Bugs' })
  const severity = (await dbService.one('property.create', { sourceId: created.sourceId, name: 'Severity', kind: 'select', config: { options: [{ name: 'Low' }, { name: 'High' }] } })).propertyId
  const hours = (await dbService.one('property.create', { sourceId: created.sourceId, name: 'Hours', kind: 'number' })).propertyId
  const high = dbService.state.get('property', severity).config.options[1].id
  for (let i = 0; i < 3; i++) await dbService.one('row.create', { sourceId: created.sourceId, title: `Bug ${i}`, explicitValues: { [severity]: { kind: 'select', optionId: high }, [hours]: { kind: 'number', value: i + 1 } } })

  const open = async excludedIds => {
    const storage = new MemoryDocumentStorage('fixed', [page(created.hostPageId)])
    const host = { now: () => 100, createId: () => 'x', defer: () => () => {}, emit() {}, report() {} }
    const service = new DocumentService({ storage, host }); await service.init()
    const session = new McpDocumentSession(service, { vaultId: 'vault', grantId: 'grant', revision: 'revision', policy: { wholeVault: true, rootIds: [], excludedIds, allowWrites: false } }, { now: () => 100, cursorId: randomUUID, digest }, () => true, false, undefined, createDatabaseTools(async () => dbService))
    let n = 0
    const send = message => session.dispatch(message, { id: randomUUID(), expiresAt: 1100, active: () => true })
    await send({ jsonrpc: '2.0', id: ++n, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, clientInfo: { name: 'test', version: '1' }, capabilities: {} } })
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const checks = Object.fromEntries(['list_databases', 'describe_database', 'query_database_rows'].map(name => [name, new Ajv({ strict: true }).compile(documentToolContracts[name].outputSchema)]))
    return async (name, args = {}) => {
      const out = (await send({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })).result.structuredContent
      assert.ok(checks[name](out), JSON.stringify(checks[name].errors) + JSON.stringify(out)); return out
    }
  }
  const call = await open([])
  const listed = await call('list_databases'); assert.equal(listed.ok, true)
  assert.deepEqual(listed.result.databases.map(d => [d.name, d.rowCount, d.documentId]), [['Bugs', 3, created.hostPageId]])
  const described = await call('describe_database', { sourceId: created.sourceId })
  assert.deepEqual(described.result.properties.find(p => p.name === 'Severity').options.map(o => o.name), ['Low', 'High'])
  const rows = await call('query_database_rows', { sourceId: created.sourceId, limit: 2 })
  assert.equal(rows.result.rows.length, 2); assert.equal(rows.result.truncated, true); assert.equal(rows.result.total, 3)
  assert.deepEqual(rows.result.rows[0].values[severity], ['High'])
  const next = await call('query_database_rows', { sourceId: created.sourceId, limit: 2, cursor: rows.result.nextCursor })
  assert.equal(next.result.rows.length, 1); assert.equal(next.result.nextCursor, null)
  assert.equal((await call('query_database_rows', { sourceId: created.sourceId, limit: 500 })).error.code, 'INVALID_ARGUMENT')
  assert.equal((await call('describe_database', { sourceId: 'nope' })).error.code, 'NOT_FOUND')

  const hidden = await open([created.hostPageId])
  assert.deepEqual((await hidden('list_databases')).result.databases, [])
  assert.equal((await hidden('describe_database', { sourceId: created.sourceId })).error.code, 'NOT_FOUND')
  assert.equal((await hidden('query_database_rows', { sourceId: created.sourceId })).error.code, 'NOT_FOUND')
})

test('database write tools build a database with fake records, replay safely, reject bad values and honour the write grant', async () => {
  const { DatabaseService: DbService } = await import('../spike/tiptap/src/database/service.ts')
  const { MemoryPages } = await import('../spike/tiptap/src/database/state.ts')
  const { MemoryStorage } = await import('../spike/tiptap/src/database/storage/memory.ts')
  const { MemoryPageHost } = await import('../spike/tiptap/src/database/fixtures.ts')
  const { createDatabaseTools } = await import('../spike/tiptap/src/database/mcpTools.ts')
  const dbPages = new MemoryPages()
  const dbService = new DbService({ vaultId: 'v', storage: new MemoryStorage(dbPages), pages: dbPages, host: new MemoryPageHost(dbPages), deviceId: 'D1', zone: 'UTC' })
  await dbService.open()
  const open = async (allowWrites, known = []) => {
    const service = new DocumentService({ storage: new MemoryDocumentStorage('fixed', [page('anchor'), ...known.map(id => page(id))]), host: { now: () => 100, createId: () => 'x', defer: () => () => {}, emit() {}, report() {} } }); await service.init()
    const session = new McpDocumentSession(service, { vaultId: 'vault', grantId: 'grant', revision: 'revision', policy: { wholeVault: true, rootIds: [], excludedIds: [], allowWrites } }, { now: () => 100, cursorId: randomUUID, digest }, () => true, allowWrites, undefined, createDatabaseTools(async () => dbService))
    let n = 0
    const send = message => session.dispatch(message, { id: randomUUID(), expiresAt: 1100, active: () => true })
    await send({ jsonrpc: '2.0', id: ++n, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, clientInfo: { name: 'test', version: '1' }, capabilities: {} } })
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const checks = Object.fromEntries(['create_database', 'add_database_rows'].map(name => [name, new Ajv({ strict: true }).compile(documentToolContracts[name].outputSchema)]))
    return async (name, args) => {
      const out = (await send({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })).result.structuredContent
      assert.ok(checks[name](out), JSON.stringify(checks[name].errors) + JSON.stringify(out)); return out
    }
  }
  const call = await open(true)
  const fakeRows = Array.from({ length: 25 }, (_, i) => ({ title: `Fake customer ${i + 1}`, values: { Plan: ['Free', 'Pro', 'Team'][i % 3], Seats: i + 1, Active: i % 2 === 0, Tags: ['demo', 'fake'], Site: `https://example.com/${i}`, Signup: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, Notes: `نمونه ${i + 1}` } }))
  const args = {
    operationId: 'fake-db', parentId: null, title: 'Fake customers',
    properties: [{ name: 'Plan', kind: 'select', options: ['Free', 'Pro', 'Team'] }, { name: 'Seats', kind: 'number' }, { name: 'Active', kind: 'checkbox' }, { name: 'Tags', kind: 'multi_select', options: ['demo', 'fake'] }, { name: 'Site', kind: 'url' }, { name: 'Signup', kind: 'date' }, { name: 'Notes', kind: 'text' }],
    rows: fakeRows,
  }
  const created = await call('create_database', args); assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.result.rowIds.length, 25); assert.equal(created.result.properties.length, 8) // 7 + the title column
  const result = dbService.query(created.result.sourceId, { limit: 100 })
  assert.equal(result.total, 25)
  const plan = created.result.properties.find(p => p.name === 'Plan').propertyId
  const probe = dbService.query(created.result.sourceId, { limit: 3, projection: [plan] })
  assert.deepEqual(probe.rows[0].values[plan].ids.length, 1)

  const again = await call('create_database', args); assert.equal(again.ok, true)
  assert.equal(again.result.sourceId, created.result.sourceId)
  assert.equal(dbService.query(created.result.sourceId, { limit: 100 }).total, 25, 'replay must not duplicate rows')
  assert.equal(dbService.state.live('source').filter(s => s.name === 'Fake customers').length, 1, 'replay must not duplicate the database')

  // in the app the new host page reaches the document scope through the shared page store; the test reopens the session to model that
  const call2 = await open(true, [created.result.pageId])
  const more = await call2('add_database_rows', { operationId: 'more-rows', sourceId: created.result.sourceId, rows: [{ title: 'Extra', values: { Plan: 'Pro', Seats: 99 } }] })
  assert.equal(more.ok, true, JSON.stringify(more)); assert.equal(more.result.rowIds.length, 1)
  assert.equal(dbService.query(created.result.sourceId, { limit: 100 }).total, 26)

  const bad = await call2('add_database_rows', { operationId: 'bad-rows', sourceId: created.result.sourceId, rows: [{ title: 'Ok', values: { Seats: 1 } }, { title: 'Bad', values: { Plan: 'Platinum' } }] })
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'INVALID_ARGUMENT')
  assert.equal(dbService.query(created.result.sourceId, { limit: 100 }).total, 26, 'a rejected batch writes nothing')
  assert.equal((await call2('add_database_rows', { operationId: 'unknown-prop', sourceId: created.result.sourceId, rows: [{ title: 'x', values: { Nope: 1 } }] })).error.code, 'INVALID_ARGUMENT')
  assert.equal((await call('create_database', { operationId: 'dup-names', parentId: null, title: 'x', properties: [{ name: 'A', kind: 'text' }, { name: 'a', kind: 'text' }] })).error.code, 'INVALID_ARGUMENT')
  assert.equal((await call('create_database', { operationId: 'formula', parentId: null, title: 'x', properties: [{ name: 'F', kind: 'text' }] })).ok, true)

  const readOnly = await open(false, [created.result.pageId])
  assert.equal((await readOnly('create_database', { operationId: 'ro', parentId: null, title: 'nope' })).error.code, 'ACCESS_DENIED')
  assert.equal((await readOnly('add_database_rows', { operationId: 'ro2', sourceId: created.result.sourceId, rows: [{ title: 'nope' }] })).error.code, 'ACCESS_DENIED')
})
