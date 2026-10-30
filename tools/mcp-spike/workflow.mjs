import { acceptanceEndpoint, acceptanceToken } from './acceptance-auth.mjs'
/** Deterministic desktop acceptance and measurements. Credentials stay in memory; only synthetic fixtures are supported. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as pause } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const [endpoint, fixturePath, grantId, reportPath] = process.argv.slice(2)
if (!endpoint?.startsWith('http://127.0.0.1:') || !fixturePath || !grantId || !reportPath) throw new Error('Usage: node workflow.mjs <loopback-url> <fixture.json> <grant-id> <report.json>')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.ok(fixture.vaultPath.startsWith('/tmp/nevis-mcp-acceptance/'), 'Only the disposable acceptance fixture is allowed')
const url = acceptanceEndpoint(endpoint), token = acceptanceToken(grantId, endpoint)
const client = new Client({ name: 'nevis-desktop-acceptance', version: '1' }), calls = [], run = Date.now().toString(36)
const start = performance.now()
const report = { environment: { platform: process.platform, arch: process.arch, client: 'official MCP TypeScript SDK 2.4.0', transport: 'packaged Tauri HTTP -> webview -> native persistence', syntheticFixture: true }, calls, assertions: [], completed: false }
let previousCall = 0
async function call(name, args, expected = true) {
  // Keep a deterministic scripted run below the native admission-rate budget.
  await pause(Math.max(0, 125 - (performance.now() - previousCall)))
  previousCall = performance.now()
  const started = performance.now(), result = await client.callTool({ name, arguments: args })
  const value = result.structuredContent
  calls.push({ name, durationMs: Number((performance.now() - started).toFixed(2)), returnedBytes: Buffer.byteLength(JSON.stringify(result)), ok: value?.ok === true })
  assert.equal(value?.ok, expected, JSON.stringify(value))
  assert.ok(!JSON.stringify(value).includes('PRIVATE_SENTINEL_DO_NOT_DISCLOSE'))
  return value.ok ? value.result : value.error
}
const read = documentId => call('read_document', { documentId, target: { kind: 'full' }, format: 'both' })
try {
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  assert.equal((await client.listTools()).tools.length, 14)
  const editor = await call('get_editor_capabilities', {})
  assert.equal(editor.profileVersion, 2)
  for (const type of ['callout', 'toggle', 'mermaid', 'drawing', 'image', 'table', 'layoutGroup']) assert.ok(editor.nodes.some(node => node.type === type))
  const listed = await call('list_documents', { limit: 100 }); assert.ok(listed.documents.some(d => d.documentId === fixture.documentId)); assert.ok(listed.documents.every(d => d.documentId !== fixture.excludedId))
  const search = await call('search_documents', { query: 'محفوظ', mode: 'keywords' }); assert.ok(search.hits.some(hit => hit.documentId === fixture.documentId))
  await call('read_document', { documentId: fixture.documentId, target: { kind: 'outline' }, format: 'structured' })
  const original = await read(fixture.documentId)
  const denied = await call('read_document', { documentId: fixture.excludedId, target: { kind: 'full' }, format: 'both' }, false); assert.equal(denied.code, 'ACCESS_DENIED')
  const edit = { documentId: fixture.documentId, operationId: `accept-edit-${run}`, expectedRevision: original.revision, mode: 'apply', operations: [{ kind: 'insert_blocks', at: { position: 'end', parent: null }, blocks: [{ temporaryId: 'new', node: { type: 'paragraph', content: [{ type: 'text', text: 'ACCEPTANCE_APPEND فارسی' }] } }] }] }
  const preview = await call('edit_document', { ...edit, mode: 'preview' }); assert.equal(preview.persisted, false)
  const saved = (await call('edit_document', edit)).saved
  const retry = (await call('edit_document', edit)).saved; assert.equal(retry.replayed, true); assert.deepEqual(retry.receipt, saved.receipt)
  const conflict = await call('edit_document', { ...edit, operationId: `accept-stale-${run}` }, false); assert.equal(conflict.code, 'REVISION_CONFLICT')
  assert.ok(JSON.stringify(await read(fixture.documentId)).includes('ACCEPTANCE_APPEND فارسی'))
  const history = await call('get_document_history', { documentId: fixture.documentId }); assert.ok(history.versions.some(v => v.operationId === edit.operationId))
  await call('get_document_history', { documentId: fixture.documentId, versionId: `before:${edit.operationId}`, format: 'structured' })
  await call('undo_document_edit', { documentId: fixture.documentId, operationId: `undo-${run}`, undoOperationId: edit.operationId, expectedRevision: saved.revision })
  const restored = await read(fixture.documentId); assert.deepEqual(restored.chunks, original.chunks)
  const tableRequest = { documentId: fixture.documentId, expectedRevision: restored.revision, operationId: `table-${run}`, mode: 'apply', operations: [{ kind: 'set_table_cell', table: { blockId: 'table' }, cell: { blockId: 'cell2' }, blocks: [{ temporaryId: 'cell-text', node: { type: 'paragraph', attrs: { dir: 'ltr' }, content: [{ type: 'text', text: 'CELL_ACCEPTANCE فارسی' }] } }] }] }
  tableRequest.operations.push({ kind: 'insert_table_row', table: { blockId: 'table' }, row: { blockId: 'row1' }, position: 'after', cells: ['row-a', 'row-b'].map(id => ({ kind: 'cell', blocks: [{ temporaryId: id, node: { type: 'paragraph', content: [{ type: 'text', text: `Inserted ${id} فارسی` }] } }] })) })
  const tableSaved = (await call('edit_document', tableRequest)).saved
  assert.ok(JSON.stringify(await read(fixture.documentId)).includes('CELL_ACCEPTANCE فارسی'))
  await call('undo_document_edit', { documentId: fixture.documentId, operationId: `undo-table-${run}`, undoOperationId: tableRequest.operationId, expectedRevision: tableSaved.revision })
  assert.deepEqual((await read(fixture.documentId)).chunks, original.chunks)
  const create = { operationId: `create-${run}`, parentId: fixture.rootId, kind: 'page', metadata: { title: 'Synthetic created فارسی', tags: ['acceptance'], favorite: false }, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Created through native MCP' }] }] } }
  const created = await call('create_document', create); assert.equal((await call('create_document', create)).documentId, created.documentId)
  const metadata = await call('update_document_metadata', { documentId: created.documentId, operationId: `metadata-${run}`, expectedRevision: created.revision, patch: { title: 'Renamed synthetic fixture' } }); assert.equal(metadata.metadata.title, 'Renamed synthetic fixture')
  await call('undo_document_edit', { documentId: created.documentId, operationId: `undo-metadata-${run}`, undoOperationId: `metadata-${run}`, expectedRevision: metadata.revision })
  const cleanCreate = await call('create_document', { ...create, operationId: `create-undo-${run}` })
  await call('undo_document_edit', { documentId: cleanCreate.documentId, operationId: `undo-create-${run}`, undoOperationId: `create-undo-${run}`, expectedRevision: cleanCreate.revision })
  report.assertions = ['fourteen tools discovered', 'scoped browse/search/read', 'excluded content denied', 'preview without persistence', 'durable original retry receipt', 'stale revision rejected', 'saved read-back', 'retained version read', 'edit undo restores exact chunks', 'merged table cell edit, row insertion and undo', 'creation retry identity', 'metadata update and undo', 'creation undo tombstone']
  report.completed = true
} finally {
  await client.close()
  report.totalDurationMs = Number((performance.now() - start).toFixed(2))
  report.summary = { toolCalls: calls.length, returnedBytes: calls.reduce((n, call) => n + call.returnedBytes, 0), maxReturnedBytes: Math.max(0, ...calls.map(call => call.returnedBytes)), expectedRejections: calls.filter(call => !call.ok).length }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ completed: report.completed, ...report.summary, reportPath }))
}
