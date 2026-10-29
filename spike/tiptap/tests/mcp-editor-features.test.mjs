import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { getSchema } from '@tiptap/core'
import { DocumentService } from '../src/documents/service.ts'
import { MemoryDocumentStorage } from '../src/documents/memoryStorage.ts'
import { EDITOR_BLOCKS, EDITOR_INLINES, EDITOR_MARKS } from '../src/documents/editorProfile.ts'

// The schema uses the actual editor extensions. These browser hosts are inert:
// schema construction must not mount views, open dialogs or load attachments.
globalThis.window = { addEventListener() {}, dispatchEvent() {} }
globalThis.localStorage = { getItem() { return null }, setItem() {} }
globalThis.document = { documentElement: { dataset: {} }, body: {} }
globalThis.getComputedStyle = () => ({ colorScheme: 'light' })
globalThis.MutationObserver = class { observe() {} }
const { extensions } = await import('../src/editor/extensions.ts')
const schema = getSchema(extensions)
const digest = async value => createHash('sha256').update(value).digest('hex')
const txt = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = text => ({ type: 'paragraph', content: [txt(text)] })
const hash = 'a'.repeat(64), database = 'shared-database'
const rich = () => [
  { type: 'heading', attrs: { level: 2, dir: 'rtl', textAlign: 'right' }, content: [txt('معماری Nevis', [{ type: 'bold' }, { type: 'italic' }])] },
  { type: 'paragraph', content: [txt('A link', [{ type: 'link', attrs: { href: 'https://example.org', target: '_blank', rel: 'noopener noreferrer' } }]),
    { type: 'hardBreak' }, txt('code', [{ type: 'code' }]), txt('format', [{ type: 'underline' }, { type: 'strike' }]),
    { type: 'pageLink', attrs: { id: 'resources', label: 'Resources' } }, { type: 'mathInline', attrs: { latex: 'x^2' } }, { type: 'inlineIcon', attrs: { name: 'star', color: '#abc' } }] },
  { type: 'blockquote', content: [p('Quote')] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [p('Bullet')] }] },
  { type: 'orderedList', attrs: { start: 3, type: '1' }, content: [{ type: 'listItem', content: [p('Numbered')] }] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true, dir: 'rtl' }, content: [p('Done')] }] },
  { type: 'codeBlock', attrs: { language: 'typescript', textAlign: 'left' }, content: [txt('const ready = true')] },
  { type: 'horizontalRule' },
  { type: 'table', attrs: { dir: 'rtl', tableWidth: 75, tableAlign: 'center' }, content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: [140], align: 'right' }, content: [p('Header')] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [p('Cell')] }] },
  ] },
  { type: 'callout', attrs: { emoji: '💡' }, content: [p('An important constraint')] },
  { type: 'toggle', attrs: { open: false }, content: [p('Question'), p('Answer')] },
  { type: 'mathBlock', attrs: { latex: '\\sum_{i=1}^n i' } },
  { type: 'mermaid', attrs: { code: 'flowchart LR\n  Client --> Nevis' } },
  { type: 'layoutGroup', attrs: { widths: [35, 65], direction: 'rtl' }, content: [
    { type: 'layoutColumn', content: [p('First column')] }, { type: 'layoutColumn', content: [p('Second column')] },
  ] },
  { type: 'image', attrs: { src: `att:${hash}`, alt: 'Shared image', width: 50, align: 'center' } },
  { type: 'drawing', attrs: { scene: hash, preview: hash } },
  { type: 'databaseEmbed', attrs: { containerId: database } },
]
const page = (id, content, extra = {}) => ({ id, parentId: null, title: id, tags: [], favorite: false, sort: 0, updatedAt: 1, deletedAt: null, content: { type: 'doc', content }, ...extra })
const access = { context: { vaultHandle: 'rich', grantId: 'rich-grant', grantRevision: '1' }, isActive: () => true,
  canRead: id => id !== 'private', canWrite: id => id !== 'private', canCreate: () => true }
const host = { now: () => 10, createId: randomUUID, defer: () => () => {}, emit() {}, report() {} }

async function fixture() {
  const storage = new MemoryDocumentStorage('rich', [page('resources', [{ type: 'image', attrs: { src: `att:${hash}` } }], { dbHost: database })])
  const service = new DocumentService({ storage, host }); await service.init()
  return { service, storage, writer: service.editor(access, { digest }) }
}
test('MCP creates every registered editor node and mark; actual editor schema accepts saved structure; retries and undo preserve it', async () => {
  assert.deepEqual(Object.keys(schema.nodes).sort(), ['doc', ...EDITOR_BLOCKS, ...EDITOR_INLINES].sort())
  assert.deepEqual(Object.keys(schema.marks).sort(), [...EDITOR_MARKS].sort())
  const { writer, service } = await fixture()
  const request = { operationId: 'rich-create', parentId: null, kind: 'page', metadata: { title: 'Rich editor document', tags: ['mcp'], favorite: false }, content: { type: 'doc', content: rich() } }
  const created = await writer.createDocument(request), original = structuredClone(service.get(created.documentId).content)
  const doc = schema.nodeFromJSON(original); doc.check()
  const preserved = (input, parsed) => {
    for (const [key, value] of Object.entries(input.attrs ?? {})) assert.deepEqual(parsed.attrs?.[key], value, `${input.type}.${key} must survive the real schema`)
    for (const mark of input.marks ?? []) for (const [key, value] of Object.entries(mark.attrs ?? {})) assert.deepEqual(parsed.marks?.find(item => item.type === mark.type)?.attrs?.[key], value)
    for (const [index, child] of (input.content ?? []).entries()) preserved(child, parsed.content[index])
  }
  preserved(original, doc.toJSON())
  const present = new Set(); doc.descendants(node => present.add(node.type.name))
  assert.ok(EDITOR_BLOCKS.every(type => present.has(type)))
  assert.deepEqual((await writer.createDocument(request)).receipt, created.receipt)
  const callout = original.content.find(node => node.type === 'callout'), diagram = original.content.find(node => node.type === 'mermaid')
  const edit = { documentId: created.documentId, operationId: 'rich-edit', expectedRevision: created.revision, mode: 'apply', operations: [
    { kind: 'set_attributes', target: { blockId: callout.attrs.blockId }, attributes: { emoji: '✅' } },
    { kind: 'set_attributes', target: { blockId: diagram.attrs.blockId }, attributes: { code: 'flowchart LR\n  Nevis --> Document' } },
  ] }
  const saved = (await writer.editDocument(edit)).saved
  schema.nodeFromJSON(service.get(created.documentId).content).check()
  await writer.undoDocumentEdit({ documentId: created.documentId, operationId: 'rich-undo', undoOperationId: edit.operationId, expectedRevision: saved.revision })
  assert.deepEqual(service.get(created.documentId).content, original)
})

test('new rich content rejects unsafe links, malformed tables/layouts and private resource references before saving', async () => {
  const { writer, storage } = await fixture(), baseline = await storage.load()
  const bad = [
    { type: 'paragraph', content: [txt('Bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])] },
    { type: 'image', attrs: { src: 'file:///etc/passwd' } },
    { type: 'image', attrs: { src: `att:${'b'.repeat(64)}` } },
    { type: 'databaseEmbed', attrs: { containerId: 'private-database' } },
    { type: 'layoutGroup', attrs: { widths: [10, 90] }, content: [{ type: 'layoutColumn', content: [p('A')] }, { type: 'layoutColumn', content: [p('B')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { rowspan: 2 }, content: [p('Overflow')] }] }] },
    { type: 'toggle', content: [{ type: 'heading', content: [txt('Invalid title')] }] },
  ]
  for (const [index, node] of bad.entries()) {
    await assert.rejects(writer.createDocument({ operationId: `bad-${index}`, parentId: null, kind: 'page', metadata: { title: 'Rejected', tags: [], favorite: false }, content: { type: 'doc', content: [node] } }))
    assert.deepEqual(await storage.load(), baseline)
  }
})

test('page covers and drawing boards use native metadata/content shapes and retain undo', async () => {
  const { writer, service } = await fixture()
  const created = await writer.createDocument({ operationId: 'board-create', parentId: null, kind: 'board', metadata: { title: 'Board', tags: [], favorite: false, cover: { kind: 'gradient', id: 'aurora' } }, content: { type: 'doc', content: [{ type: 'drawing', attrs: { scene: hash, preview: hash } }] } })
  assert.equal(service.get(created.documentId).kind, 'board')
  assert.deepEqual(created.metadata.cover, { kind: 'gradient', id: 'aurora' })
  const changed = await writer.updateDocumentMetadata({ documentId: created.documentId, operationId: 'cover-image', expectedRevision: created.revision, patch: { cover: { kind: 'image', file: hash } } })
  assert.deepEqual(service.get(created.documentId).cover, { kind: 'image', file: hash })
  const undone = await writer.undoDocumentEdit({ documentId: created.documentId, operationId: 'cover-undo', undoOperationId: 'cover-image', expectedRevision: changed.revision })
  assert.deepEqual(service.get(created.documentId).cover, { kind: 'gradient', id: 'aurora' })
  await writer.updateDocumentMetadata({ documentId: created.documentId, operationId: 'cover-clear', expectedRevision: undone.revision, patch: { cover: null } })
  assert.equal(service.get(created.documentId).cover, undefined)
})

test('MCP final admission restores a removed attachment only from the same scoped undo origin', async () => {
  const { identifyBlocks } = await import('../src/documents/blockIdentity.ts')
  const { McpDocumentSession, MCP_PROTOCOL } = await import('../src/documents/mcp.ts')
  const identified = identifyBlocks({ type: 'doc', content: [{ type: 'image', attrs: { src: `att:${hash}` } }] }).content
  const storage = new MemoryDocumentStorage('resource-undo', [page('target', identified.content), page('private', [{ type: 'image', attrs: { src: `att:${'b'.repeat(64)}` } }])])
  const service = new DocumentService({ storage, host }); await service.init()
  const runtime = { now: () => 10, cursorId: randomUUID, digest }
  const session = new McpDocumentSession(service, { vaultId: 'resource-undo', grantId: 'resource-grant', revision: '1', policy: { wholeVault: true, rootIds: [], excludedIds: ['private'], allowWrites: true } }, runtime, () => true, true)
  let serial = 0
  const rpc = (method, params, notification = false) => session.dispatch({ jsonrpc: '2.0', ...(notification ? {} : { id: ++serial }), method, params }, { id: randomUUID(), expiresAt: 1010, active: () => true })
  await rpc('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  await rpc('notifications/initialized', {}, true)
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent
  const original = await call('read_document', { documentId: 'target', target: { kind: 'full' }, format: 'structured' })
  const blockId = original.result.chunks[0].structured[0].attrs.blockId
  const edited = await call('edit_document', { documentId: 'target', operationId: 'remove-image', expectedRevision: original.result.revision, mode: 'apply', operations: [{ kind: 'replace_blocks', target: { from: { blockId }, through: { blockId } }, blocks: [{ temporaryId: 'text', node: p('Image removed') }] }] })
  assert.equal(edited.ok, true, JSON.stringify(edited))
  const undone = await call('undo_document_edit', { documentId: 'target', operationId: 'restore-image', undoOperationId: 'remove-image', expectedRevision: edited.result.saved.revision })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal(service.get('target').content.content[0].attrs.src, `att:${hash}`)
  const denied = await call('edit_document', { documentId: 'target', operationId: 'private-image', expectedRevision: undone.result.revision, mode: 'apply', operations: [{ kind: 'set_attributes', target: { blockId }, attributes: { src: `att:${'b'.repeat(64)}` } }] })
  assert.equal(denied.error.code, 'ACCESS_DENIED')
})


test('uploaded raster images and drawing scenes persist native references and exact bytes, retry safely and reject invalid uploads', async () => {
  const storage = new MemoryDocumentStorage('rich', [], digest)
  const service = new DocumentService({ storage, host }); await service.init()
  const writer = service.editor(access, { digest, digestBytes: digest })
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const scene = Buffer.from(JSON.stringify({ type: 'excalidraw', version: 2, elements: [] }))
  const upload = (temporaryId, bytes, mimeType) => ({ temporaryId, mimeType, name: temporaryId, data: bytes.toString('base64') })
  const request = { operationId: 'upload-create', parentId: null, kind: 'page', metadata: { title: 'Uploaded content', tags: [], favorite: false },
    assets: [upload('photo', image, 'image/png'), upload('scene', scene, 'application/vnd.excalidraw+json')],
    content: { type: 'doc', content: [ { type: 'image', attrs: { src: 'upload:photo', alt: 'Pixel' } },
      { type: 'drawing', attrs: { scene: 'upload:scene', preview: 'upload:photo' } } ] } }
  const created = await writer.createDocument(request)
  const saved = service.get(created.documentId)
  const imageId = await digest(image), sceneId = await digest(scene)
  assert.equal(saved.content.content[0].attrs.src, `att:${imageId}`)
  assert.equal(saved.content.content[1].attrs.scene, sceneId)
  assert.deepEqual(Buffer.from((await storage.readAsset(imageId)).bytes), image)
  assert.deepEqual(Buffer.from((await storage.readAsset(sceneId)).bytes), scene)
  const exposed = await storage.readAsset(imageId); exposed.bytes.fill(0)
  assert.deepEqual(Buffer.from((await storage.readAsset(imageId)).bytes), image)
  schema.nodeFromJSON(saved.content).check()
  assert.deepEqual((await writer.createDocument(request)).receipt, created.receipt)
  const baseline = await storage.load()
  for (const asset of [ { ...request.assets[0], mimeType: 'image/jpeg' }, { ...request.assets[0], data: 'AAAA' } ]) {
    await assert.rejects(writer.createDocument({ ...request, operationId: randomUUID(), assets: [asset] }))
    assert.deepEqual(await storage.load(), baseline)
  }
  const missing = new DocumentService({ storage: new MemoryDocumentStorage('rich', []), host }); await missing.init()
  await assert.rejects(missing.editor(access, { digest }).createDocument(request), error => error.code === 'CAPABILITY_UNAVAILABLE')
})


test('MCP wire accepts new attachment uploads, applies final grant admission, previews without files and undoes insertion', async () => {
  const { McpDocumentSession, MCP_PROTOCOL } = await import('../src/documents/mcp.ts')
  const storage = new MemoryDocumentStorage('wire-uploads', [], digest)
  const service = new DocumentService({ storage, host }); await service.init()
  const runtime = { now: () => 10, cursorId: randomUUID, digest, digestBytes: digest }
  const session = new McpDocumentSession(service, { vaultId: 'wire-uploads', grantId: 'uploads-grant', revision: '1', policy: { wholeVault: true, rootIds: [], excludedIds: [], allowWrites: true } }, runtime, () => true, true)
  let serial = 0
  const rpc = (method, params, notification = false) => session.dispatch({ jsonrpc: '2.0', ...(notification ? {} : { id: ++serial }), method, params }, { id: randomUUID(), expiresAt: 1010, active: () => true })
  await rpc('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'upload-test', version: '1' } })
  await rpc('notifications/initialized', {}, true)
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent
  const created = await call('create_document', { operationId: 'wire-create', parentId: null, kind: 'page', metadata: { title: 'Upload target', tags: [], favorite: false }, content: { type: 'doc', content: [p('Before')] } })
  assert.equal(created.ok, true, JSON.stringify(created))
  const data = 'iVBORw0KGgo=', id = await digest(Buffer.from(data, 'base64'))
  const request = { documentId: created.result.documentId, operationId: 'wire-insert', expectedRevision: created.result.revision, mode: 'preview', operations: [
    { kind: 'insert_blocks', at: { position: 'end', parent: null }, assets: [{ temporaryId: 'pixel', name: 'pixel.png', mimeType: 'image/png', data }], blocks: [{ temporaryId: 'image', node: { type: 'image', attrs: { src: 'upload:pixel' } } }] },
  ] }
  assert.equal((await call('edit_document', request)).ok, true)
  assert.equal(await storage.readAsset(id), null)
  const before = structuredClone(service.get(request.documentId))
  const applied = await call('edit_document', { ...request, mode: 'apply' })
  assert.equal(applied.ok, true, JSON.stringify(applied)); assert.ok(await storage.readAsset(id))
  assert.equal(service.get(request.documentId).content.content[1].attrs.src, `att:${id}`)
  const undone = await call('undo_document_edit', { documentId: request.documentId, operationId: 'wire-undo', undoOperationId: request.operationId, expectedRevision: applied.result.saved.revision })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.deepEqual(service.get(request.documentId).content, before.content)
})
