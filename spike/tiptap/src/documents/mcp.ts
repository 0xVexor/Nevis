import { editorCapabilities } from './editorProfile.ts'
import { documentLinks, documentResources, undoResources } from './admission.ts'
import { documentToolContracts, ERROR_CODES, LIMITS } from './contracts.ts'
import type { DocumentToolName, Schema } from './contracts.ts'
import { canonicalDocumentValue } from './revision.ts'
import type { DocumentService } from './service.ts'
import type { DocumentReadRuntime } from './reader.ts'
import type { Page } from './model.ts'

export const MCP_PROTOCOL = '2025-11-25'
export interface McpPolicy { wholeVault: boolean; rootIds: string[]; excludedIds: string[]; allowWrites: boolean }
export interface McpConnection {
  writesAvailable?: boolean
  grantId: string; revision: string; vaultId: string; policy: McpPolicy
}
const reads = new Set<DocumentToolName>(['get_editor_capabilities', 'list_documents', 'search_documents', 'read_document', 'get_document_history'])
const descriptions: Record<DocumentToolName, string> = {
  get_editor_capabilities: 'Discover every supported editor node, mark, attribute schema, content model and rich authoring example before writing a document.',
  list_documents: 'Browse permitted saved documents with bounded pagination.',
  search_documents: 'Search permitted saved documents using original Persian/English passages and stable references.',
  read_document: 'Read a saved document outline, section, blocks or bounded full content.',
  get_document_history: 'Read retained operation versions for this grant on this device; retention is incomplete and bounded.',
  create_document: 'Create a document once with a durable operation ID.',
  edit_document: 'Preview or apply a revision-gated block edit.',
  update_document_metadata: 'Update allowlisted metadata with an exact revision.',
  undo_document_edit: 'Preview or apply retained, revision-gated undo.',
}
const bytes = (value: unknown) => [...JSON.stringify(value)].reduce((n, c) => n + (c.codePointAt(0)! < 128 ? 1 : c.codePointAt(0)! < 2048 ? 2 : c.codePointAt(0)! < 65536 ? 3 : 4), 0)
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)

/** A small validator for the closed schema vocabulary used by our eight contracts. */
export function matchesDocumentSchema(value: unknown, schema: Schema, root = schema, depth = 0): boolean {
  if (!schema || depth > 80) return false
  const s = schema as Record<string, any>
  if (s.$ref) return matchesDocumentSchema(value, (root as any).definitions?.[s.$ref.split('/').at(-1)], root, depth + 1)
  if (s.anyOf) return s.anyOf.some((part: Schema) => matchesDocumentSchema(value, part, root, depth + 1))
  if (s.oneOf) return s.oneOf.filter((part: Schema) => matchesDocumentSchema(value, part, root, depth + 1)).length === 1
  if ('const' in s && value !== s.const) return false
  if (s.enum && !s.enum.includes(value)) return false
  if (s.type === 'null') return value === null
  if (s.type === 'string') return typeof value === 'string' && [...value].length >= (s.minLength ?? 0) && [...value].length <= (s.maxLength ?? Infinity)
  if (s.type === 'boolean') return typeof value === 'boolean'
  if (s.type === 'number' || s.type === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (s.type !== 'integer' || Number.isInteger(value)) && value >= (s.minimum ?? -Infinity) && value <= (s.maximum ?? Infinity)
  if (s.type === 'array') return Array.isArray(value) && value.length >= (s.minItems ?? 0) && value.length <= (s.maxItems ?? Infinity)
    && (!s.uniqueItems || new Set(value.map(canonicalDocumentValue)).size === value.length)
    && value.every(item => matchesDocumentSchema(item, s.items, root, depth + 1))
  if (s.type === 'object') return object(value) && Object.keys(value).length >= (s.minProperties ?? 0)
    && (s.required ?? []).every((key: string) => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, item]) => Object.hasOwn(s.properties ?? {}, key)
      ? matchesDocumentSchema(item, s.properties[key], root, depth + 1) : s.additionalProperties !== false)
  return true
}
export function validMcpPolicy(policy: unknown): policy is McpPolicy {
  return object(policy) && Object.keys(policy).sort().join(',') === 'allowWrites,excludedIds,rootIds,wholeVault'
    && typeof policy.wholeVault === 'boolean' && typeof policy.allowWrites === 'boolean'
    && [policy.rootIds, policy.excludedIds].every(ids => Array.isArray(ids) && ids.length <= 100 && new Set(ids).size === ids.length
      && ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)))
    && (policy.wholeVault || policy.rootIds.length > 0)
}
export class McpDocumentScope {
  private pages = new Map<string, Page>()
  private readonly policy: McpPolicy
  constructor(policy: McpPolicy) {
    if (!validMcpPolicy(policy)) throw new Error('Invalid MCP scope')
    this.policy = JSON.parse(JSON.stringify(policy))
  }
  observe(pages: Page[]) { this.pages = new Map(pages.map(page => [page.id, page])) }
  canRead = (id: string): boolean => {
    let current: string | null = id, selected = this.policy.wholeVault
    const seen = new Set<string>()
    while (current !== null) {
      if (seen.has(current) || seen.size >= 128 || this.policy.excludedIds.includes(current)) return false
      seen.add(current)
      const page = this.pages.get(current)
      if (!page) return false
      if (this.policy.rootIds.includes(current)) selected = true
      current = page.parentId
    }
    return selected
  }
  canWrite = (id: string) => this.policy.allowWrites && this.canRead(id)
  canCreate = (parentId: string | null) => this.policy.allowWrites && (parentId === null ? this.policy.wholeVault : this.canRead(parentId))
}
const toolError = (code: typeof ERROR_CODES[number]) => ({ ok: false as const, error: { code, message: code.replaceAll('_', ' ').toLowerCase(), retryable: ['APP_UNAVAILABLE', 'EDITOR_BUSY'].includes(code) } })
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
type Invocation = { id: string; expiresAt: number; active(): boolean }

/** One authenticated client grant, serialized so its cursor-owning services remain stable across requests. */
export class McpDocumentSession {
  private readonly scope: McpDocumentScope
  private readonly reader: ReturnType<DocumentService['reader']>
  private readonly editor: ReturnType<DocumentService['editor']>
  private current: Invocation | null = null
  private closed = false
  private pending = 0
  private initialized = false
  private ready = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly connection: McpConnection
  private readonly service: DocumentService
  private readonly runtime: DocumentReadRuntime
  private readonly active: () => boolean
  private readonly writesAvailable: boolean
  // A host must explicitly advertise write support in addition to the user grant.
  constructor(service: DocumentService, connection: McpConnection, runtime: DocumentReadRuntime, active: () => boolean, writesAvailable = false) {
    this.service = service; this.connection = JSON.parse(JSON.stringify(connection)); this.runtime = runtime; this.active = active; this.writesAvailable = writesAvailable
    this.scope = new McpDocumentScope(connection.policy)
    const grant = { context: { vaultHandle: service.vaultHandle, grantId: connection.grantId, grantRevision: connection.revision },
      isActive: () => this.live(), canRead: this.scope.canRead, canWrite: this.scope.canWrite, canCreate: this.scope.canCreate,
      admission: () => {
        const invocation = this.current!
        return { native: { requestId: invocation.id, revision: this.connection.revision }, check: (pages: Page[], record: import('./operations.ts').DocumentOperationRecord, undoOrigin?: import('./operations.ts').DocumentOperationRecord | null) => {
          if (!this.live() || this.current !== invocation) throw { code: 'APP_UNAVAILABLE' }
          const scope = new McpDocumentScope(this.connection.policy); scope.observe(pages)
          if (record.before ? !scope.canWrite(record.before.id) : !scope.canCreate(record.after.parentId)) throw { code: 'ACCESS_DENIED' }
          if (record.before && record.before.parentId !== record.after.parentId && !scope.canCreate(record.after.parentId)) throw { code: 'ACCESS_DENIED' }
          const previous = documentLinks(record.before?.content)
          for (const id of documentLinks(record.after.content)) if (!previous.has(id) && !scope.canRead(id)) throw { code: 'ACCESS_DENIED' }
          const previousResources = documentResources(record.before), availableResources = new Set<string>()
          for (const page of pages) if (page.deletedAt === null && scope.canRead(page.id)) for (const id of documentResources(page)) availableResources.add(id)
          for (const id of undoResources(record, undoOrigin)) availableResources.add(id)
          for (const id of documentResources(record.after)) if (!previousResources.has(id) && !availableResources.has(id)) throw { code: 'ACCESS_DENIED' }
        } }
      } }
    this.reader = service.reader(grant, runtime); this.editor = service.editor(grant, runtime)
  }
  close() { this.closed = true }
  private live() { return !this.closed && this.active() && (!this.current || (this.current.active() && this.runtime.now() <= this.current.expiresAt)) }
  dispatch(message: unknown, invocation: Invocation): Promise<unknown> {
    if (this.pending >= 8) return Promise.resolve(object(message) && Object.hasOwn(message, 'id') ? rpcError(message.id, -32000, 'Request capacity exceeded') : null)
    this.pending++
    const run = this.queue.then(async () => { this.current = invocation; try { return await this.handle(message) } finally { this.current = null; this.pending-- } })
    this.queue = run.catch(() => undefined)
    return run
  }
  private async refresh() { this.scope.observe(await this.service.persistedPages()) }
  private async handle(message: unknown): Promise<unknown> {
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || (Object.hasOwn(message, 'id') && !(typeof message.id === 'string' && message.id.length <= 256 || Number.isSafeInteger(message.id)))) return rpcError(null, -32600, 'Invalid request')
    const id = message.id, notification = !Object.hasOwn(message, 'id')
    if (!this.live()) return notification ? null : rpcError(id, -32000, 'App unavailable')
    if (bytes(message) > LIMITS.requestBytes + 4096) return rpcError(id ?? null, -32600, 'Request limit exceeded')
    const response = (result: unknown) => ({ jsonrpc: '2.0', id, result })
    if (message.method === 'initialize') {
      const p = message.params
      if (notification || !object(p) || typeof p.protocolVersion !== 'string' || !object(p.capabilities) || !object(p.clientInfo)) return rpcError(id ?? null, -32602, 'Invalid initialization')
      this.initialized = true
      return response({ protocolVersion: MCP_PROTOCOL, serverInfo: { name: 'nevis-documents', version: '1.0.0' }, capabilities: { tools: { listChanged: false } },
        instructions: `Call get_editor_capabilities for native rich-block examples, including tables, callouts, diagrams and columns. Only explicitly permitted saved documents are accessible. ${this.connection.policy.allowWrites && this.writesAvailable ? 'Editing requires exact revisions and durable operation IDs. Preview before applying.' : 'This connection is read-only.'} Nevis must stay open.` })
    }
    if (message.method === 'notifications/initialized') { if (this.initialized) this.ready = true; return null }
    if (message.method === 'ping') return notification ? null : response({})
    if (notification) return null
    if (!this.initialized || !this.ready) return rpcError(id, -32002, 'Initialize connection first')
    if (message.method === 'tools/list' && message.params !== undefined && (!object(message.params) || Object.keys(message.params).some(key => key !== '_meta'))) return rpcError(id, -32602, 'Invalid list parameters')
    if (message.method === 'tools/list') return response({ tools: Object.entries(documentToolContracts).map(([name, contract]) => ({ name, description: descriptions[name as DocumentToolName],
      inputSchema: contract.inputSchema, outputSchema: { type: 'object', ...contract.outputSchema }, annotations: { readOnlyHint: reads.has(name as DocumentToolName), destructiveHint: !reads.has(name as DocumentToolName), idempotentHint: true, openWorldHint: false } })) })
    if (message.method !== 'tools/call') return rpcError(id, -32601, 'Method not found')
    const params = message.params
    if (!object(params) || typeof params.name !== 'string' || !Object.hasOwn(documentToolContracts, params.name) || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))) return rpcError(id, -32602, 'Unknown tool or invalid parameters')
    const name = params.name as DocumentToolName, contract = documentToolContracts[name], input = params.arguments ?? {}
    const resultEnvelope = (structuredContent: unknown) => response({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: (structuredContent as any).ok === false })
    if (!matchesDocumentSchema(input, contract.inputSchema) || bytes(input) > LIMITS.requestBytes) return resultEnvelope(toolError('INVALID_ARGUMENT'))
    let structured: unknown
    try {
      await this.refresh()
      if (!this.live()) throw { code: 'APP_UNAVAILABLE' }
      if (!reads.has(name) && (!this.connection.policy.allowWrites || !this.writesAvailable)) throw { code: this.connection.policy.allowWrites ? 'CAPABILITY_UNAVAILABLE' : 'ACCESS_DENIED' }
      const handlers = {
        get_editor_capabilities: () => editorCapabilities(),
        list_documents: () => this.reader.listDocuments(input), search_documents: () => this.reader.searchDocuments(input), read_document: () => this.reader.readDocument(input),
        get_document_history: () => this.editor.getDocumentHistory(input), create_document: () => this.editor.createDocument(input), edit_document: () => this.editor.editDocument(input),
        update_document_metadata: () => this.editor.updateDocumentMetadata(input), undo_document_edit: () => this.editor.undoDocumentEdit(input),
      }
      const result = await handlers[name]()
      await this.refresh()
      if (!this.live()) throw { code: 'APP_UNAVAILABLE' }
      // Recheck returned identities after async reads, including parent metadata from a prior scope snapshot.
      const verify = (value: any) => {
        if (!value || typeof value !== 'object') return
        for (const [key, child] of Object.entries(value)) {
          if ((key === 'documentId' || key === 'parentId') && typeof child === 'string' && !this.scope.canRead(child)) throw { code: 'ACCESS_DENIED' }
          if (key !== 'structured' && key !== 'metadata') { if (Array.isArray(child)) child.forEach(verify); else verify(child) }
        }
      }
      verify(result)
      structured = { ok: true, result }
      if (!matchesDocumentSchema(structured, contract.outputSchema) || bytes(structured) > LIMITS.responseBytes) throw { code: 'LIMIT_EXCEEDED' }
    } catch (error) {
      const code = !this.live() ? 'APP_UNAVAILABLE' : object(error) && ERROR_CODES.includes(error.code) ? error.code : 'APP_UNAVAILABLE'
      structured = toolError(code)
    }
    const output = resultEnvelope(structured)
    return bytes(output) <= LIMITS.responseBytes * 4 ? output : resultEnvelope(toolError('LIMIT_EXCEEDED'))
  }
}
