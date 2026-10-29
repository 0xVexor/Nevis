import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DocumentService } from '../../../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../../../spike/tiptap/src/documents/memoryStorage.ts'
import { McpDocumentSession } from '../../../spike/tiptap/src/documents/mcp.ts'

// This fixture exercises the official client against the real handlers. Native HTTP guards have separate Rust tests.
test('official HTTP client initializes, discovers nine schemas, reads Persian and receives scoped errors', { timeout: 10000 }, async t => {
  const page = { id: 'note', parentId: null, title: 'فارسی', tags: [], favorite: false, sort: 0, updatedAt: 1, deletedAt: null,
    content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'متن فارسی Java' }] }] } }
  const service = new DocumentService({ storage: new MemoryDocumentStorage('fixed', [page]), host: { now: Date.now, createId: randomUUID, defer: () => () => {}, emit() {}, report() {} } }); await service.init()
  const session = new McpDocumentSession(service, { vaultId: 'vault', grantId: 'grant', revision: '1', policy: { wholeVault: true, rootIds: [], excludedIds: [], allowWrites: false } }, { now: Date.now, cursorId: randomUUID, digest: async text => createHash('sha256').update(text).digest('hex') }, () => true)
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    try {
      const result = await session.dispatch(JSON.parse(Buffer.concat(chunks)), { id: randomUUID(), expiresAt: Date.now() + 1000, active: () => true })
      res.writeHead(result === null ? 202 : 200, { 'Content-Type': 'application/json' }).end(result === null ? undefined : JSON.stringify(result))
    } catch { res.writeHead(500).end() }
  })
  t.after(() => { session.close(); server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const client = new Client({ name: 'nevis-http-check', version: '1' })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer fixture-token' } } }))
  const { tools } = await client.listTools(); assert.equal(tools.length, 9)
  const result = await client.callTool({ name: 'read_document', arguments: { documentId: 'note', target: { kind: 'full' }, format: 'both' } })
  assert.equal(result.structuredContent.ok, true); assert.ok(JSON.stringify(result.structuredContent).includes('متن فارسی Java'))
  const denied = await client.callTool({ name: 'create_document', arguments: { operationId: 'create', parentId: null, kind: 'page', metadata: { title: 'new', tags: [], favorite: false }, content: { type: 'doc', content: [] } } })
  assert.equal(denied.structuredContent.error.code, 'ACCESS_DENIED'); assert.equal(denied.isError, true)
  await client.close()
})
