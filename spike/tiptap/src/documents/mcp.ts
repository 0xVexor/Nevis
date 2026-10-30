import { editorCapabilities } from './editorProfile.ts'
import { documentLinks, documentResources, undoResources } from './admission.ts'
import { documentToolContracts, ERROR_CODES, LIMITS } from './contracts.ts'
import type { DocumentToolName, Schema } from './contracts.ts'
import type { DatabaseToolHost } from './databaseHost.ts'
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
const reads = new Set<DocumentToolName>(['get_editor_capabilities', 'list_documents', 'search_documents', 'read_document', 'get_document_history', 'list_databases', 'describe_database', 'query_database_rows'])
const descriptions: Record<DocumentToolName, string> = {
  get_editor_capabilities: 'Call this first before writing. Returns every node and mark the Nevis editor supports, with attribute schemas, nesting rules and a ready-to-use JSON example for each (tables, callouts, toggles, formulas, Mermaid, columns, images, drawings, page links). Use those examples as the exact shape of block content in create_document and edit_document.',
  list_documents: 'List the saved documents this connection may access, with title, kind, tags, parentId and the current revision. Use parentId and recursive to walk the page tree; follow nextCursor while truncated. Start here to find a documentId.',
  search_documents: 'Full-text search over permitted documents. Works with Persian and English (Arabic/Persian letter and digit variants match). Required arguments: query and mode, one of keywords (all words, any order), phrase (words in order) or literal (exact text). Returns passages with documentId, revision and block range; read_document gives the full context.',
  read_document: 'Read one document. Required arguments: documentId, format (markdown, structured or both) and target, an object whose kind is outline (headings only, cheapest), section (also headingBlockId), blocks (also blockIds) or full, for example {"kind":"outline"}. Every block has a stable blockId; use those ids and the returned revision for edits. Pass expectedRevision to fail instead of reading a newer version. Reads show saved content only, never unsaved text in the open editor.',
  get_document_history: 'List the retained edit versions this connection made to a document, or read one with versionId. History is bounded and local to this device and grant, so an empty list does not mean the document never changed.',
  list_databases: 'List the databases (tables, boards, calendars) inside the documents this connection may access: sourceId, name, the page that hosts it and the row count. Use the sourceId with describe_database and query_database_rows. Databases on hidden pages are not listed.',
  describe_database: 'Show the properties of one database: propertyId, name, kind (text, number, select, status, date, checkbox, relation, formula ...) and, for select and status, the option names. Call this before query_database_rows so you know what each propertyId means.',
  query_database_rows: 'Read the rows of one database, up to limit (default 50, max 100) per call; follow nextCursor while truncated is true. Each row has its pageId (the row is also a page), title and values keyed by propertyId. Values are plain text, numbers, booleans, dates or arrays; select and multi-select values are lists of option names. Read-only.',
  create_database: 'Create a new database page with its properties and, optionally, up to 100 rows in one call. properties: [{name, kind, options}] where kind is text, number, checkbox, select, multi_select, url, email, phone or date, and options lists the allowed names for select kinds. rows: [{title, values}] where values is keyed by property name: text and url as strings, number as a number, checkbox as true/false, select as an option name, multi_select as a list of option names, date as "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm". parentId null creates it at the top level. Choose a fresh operationId; repeating the call with the same operationId completes or replays it without duplicates.',
  add_database_rows: 'Add up to 100 rows to an existing database (sourceId from list_databases). rows: [{title, values}] with values keyed by property name or propertyId, in the formats described for create_database; call describe_database first. All rows are added together or none. Choose a fresh operationId.',
  create_document: 'Create a new page, folder, board or to-do list. Choose a fresh operationId (any unique string); repeating the same call with the same operationId returns the original result instead of creating a duplicate. parentId null creates at the top level. The simplest way to write the page body is markdown: pass `markdown` (headings, lists, [ ] tasks, tables, > quotes, ```code and ```mermaid fences, $$math$$) instead of `content`. Use `content` (the shape returned by get_editor_capabilities) only for things markdown cannot express. Give exactly one of the two.',
  edit_document: 'Edit a document by block. Read it first, then send documentId, the revision you read as expectedRevision, a fresh operationId and a list of operations (insert_markdown, insert_blocks, replace_blocks, move_blocks, delete_blocks, set_attributes, set_table_cell, insert_table_row, set_internal_link) that target blockIds. Use mode preview to see the change without saving, then mode apply with the same operations. To add text, prefer insert_markdown with {kind, at, markdown}. Block ids and temporaryIds are assigned by the app; refer to new blocks by the temporaryId you gave them.',
  update_document_metadata: 'Change title, icon, tags, status, favorite, text direction or cover without touching the content. Needs the documentId, the current revision as expectedRevision and a fresh operationId. Only the fields in patch change.',
  undo_document_edit: 'Undo one earlier edit made through this connection while it is still retained. Give the undoOperationId of that edit (see get_document_history or the receipt), the current revision and a fresh operationId. Use mode preview first. It fails with REVISION_CONFLICT if the document changed after that edit.',
}
const titles: Record<DocumentToolName, string> = {
  get_editor_capabilities: 'Editor capabilities', list_documents: 'List documents', search_documents: 'Search documents', read_document: 'Read document',
  get_document_history: 'Document history', create_database: 'Create database', add_database_rows: 'Add database rows', list_databases: 'List databases', describe_database: 'Describe database', query_database_rows: 'Read database rows', create_document: 'Create document', edit_document: 'Edit document',
  update_document_metadata: 'Update document metadata', undo_document_edit: 'Undo edit',
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
const toolError = (code: typeof ERROR_CODES[number], field?: string) => ({ ok: false as const, error: { code, message: code.replaceAll('_', ' ').toLowerCase(), retryable: ['APP_UNAVAILABLE', 'EDITOR_BUSY'].includes(code), ...(field && ['INVALID_ARGUMENT', 'LIMIT_EXCEEDED'].includes(code) ? { details: { field } } : {}) } })
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
type Invocation = { id: string; expiresAt: number; active(): boolean }

/** One authenticated client grant, serialized so its cursor-owning services remain stable across requests. */
/** Markdown text to editor block nodes; the host supplies the real editor schema. */
export type { DatabaseToolHost }
export type MarkdownConverter = (markdown: string) => unknown[]

export class McpDocumentSession {
  private databaseTools(): DatabaseToolHost { if (!this.databases) throw { code: 'CAPABILITY_UNAVAILABLE' }; return this.databases }
  /** `markdown` on create_document and `insert_markdown` operations become ordinary block content before validation and replay hashing. */
  private expandMarkdown(name: string, input: any): any {
    const wantsMarkdown = (name === 'create_document' && 'markdown' in input) || (name === 'edit_document' && Array.isArray(input.operations) && input.operations.some((op: any) => op?.kind === 'insert_markdown'))
    if (name === 'create_document' && ('markdown' in input) === ('content' in input)) return 'invalid'
    if (!wantsMarkdown) return input
    if (!this.markdown) return 'unavailable'
    const convert = this.markdown
    try {
      if (name === 'create_document') { const { markdown, ...rest } = input; return { ...rest, content: { type: 'doc', content: convert(markdown) } } }
      return { ...input, operations: input.operations.map((op: any) => op.kind !== 'insert_markdown' ? op : { kind: 'insert_blocks', at: op.at, blocks: convert(op.markdown).map((node, index) => ({ temporaryId: `md${index}`, node })), ...(op.assets ? { assets: op.assets } : {}) }) }
    } catch { return 'invalid' }
  }

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
  private readonly markdown?: MarkdownConverter
  private readonly databases?: DatabaseToolHost
  // A host must explicitly advertise write support in addition to the user grant.
  constructor(service: DocumentService, connection: McpConnection, runtime: DocumentReadRuntime, active: () => boolean, writesAvailable = false, markdown?: MarkdownConverter, databases?: DatabaseToolHost) {
    this.markdown = markdown; this.databases = databases
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
          for (const asset of record.assets ?? []) availableResources.add(`attachment:${asset.id}`)
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
        instructions: [
          'Nevis notes (Persian/English, right-to-left aware). Only documents the user permitted are visible; the app must stay open.',
          'Workflow: search_documents or list_documents to find a documentId, read_document (outline first, then the section or blocks you need), then edit.',
          this.connection.policy.allowWrites && this.writesAvailable
            ? 'Before writing call get_editor_capabilities once and copy the example shapes. Every write needs the revision you last read (expectedRevision) and a fresh operationId; preview, then apply. Never edit from memory of an older read: on REVISION_CONFLICT read again and redo the change. If a call times out or the connection drops, repeat it with the same operationId and payload; you get the original result and nothing is applied twice. Edits are undoable with undo_document_edit.'
            : 'This connection is read-only; create, edit, metadata and undo calls are refused.',
          'Errors carry a code and retryable flag. EDITOR_BUSY and APP_UNAVAILABLE mean wait (details.retryAfterMs) and retry; ACCESS_DENIED means the document is outside the permitted scope; do not retry it. Keep Persian text as written; do not transliterate, change digits or add direction marks.',
        ].join(' ') })
    }
    if (message.method === 'notifications/initialized') { if (this.initialized) this.ready = true; return null }
    if (message.method === 'ping') return notification ? null : response({})
    if (notification) return null
    if (!this.initialized || !this.ready) return rpcError(id, -32002, 'Initialize connection first')
    if (message.method === 'tools/list' && message.params !== undefined && (!object(message.params) || Object.keys(message.params).some(key => key !== '_meta'))) return rpcError(id, -32602, 'Invalid list parameters')
    if (message.method === 'tools/list') return response({ tools: Object.entries(documentToolContracts).map(([name, contract]) => ({ name, title: titles[name as DocumentToolName], description: descriptions[name as DocumentToolName],
      inputSchema: contract.inputSchema, outputSchema: { type: 'object', ...contract.outputSchema }, annotations: { readOnlyHint: reads.has(name as DocumentToolName), destructiveHint: !reads.has(name as DocumentToolName) && !['create_document', 'create_database', 'add_database_rows'].includes(name), idempotentHint: true, openWorldHint: false } })) })
    if (message.method !== 'tools/call') return rpcError(id, -32601, 'Method not found')
    const params = message.params
    if (!object(params) || typeof params.name !== 'string' || !Object.hasOwn(documentToolContracts, params.name) || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))) return rpcError(id, -32602, 'Unknown tool or invalid parameters')
    const name = params.name as DocumentToolName, contract = documentToolContracts[name]
    let input = params.arguments ?? {}
    const resultEnvelope = (structuredContent: unknown) => response({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: (structuredContent as any).ok === false })
    if (!matchesDocumentSchema(input, contract.inputSchema) || bytes(input) > LIMITS.requestBytes) return resultEnvelope(toolError('INVALID_ARGUMENT'))
    const expanded = this.expandMarkdown(name, input)
    if (expanded === 'invalid') return resultEnvelope(toolError('INVALID_ARGUMENT'))
    if (expanded === 'unavailable') return resultEnvelope(toolError('CAPABILITY_UNAVAILABLE'))
    input = expanded
    let structured: unknown
    try {
      await this.refresh()
      if (!this.live()) throw { code: 'APP_UNAVAILABLE' }
      if (!reads.has(name) && (!this.connection.policy.allowWrites || !this.writesAvailable)) throw { code: this.connection.policy.allowWrites ? 'CAPABILITY_UNAVAILABLE' : 'ACCESS_DENIED' }
      const handlers = {
        get_editor_capabilities: () => editorCapabilities(),
        list_documents: () => this.reader.listDocuments(input), search_documents: () => this.reader.searchDocuments(input), read_document: () => this.reader.readDocument(input),
        get_document_history: () => this.editor.getDocumentHistory(input), create_document: () => this.editor.createDocument(input), edit_document: () => this.editor.editDocument(input),
        create_database: () => this.databaseTools().createDatabase(input, this.scope),
        add_database_rows: () => this.databaseTools().addRows(input, this.scope),
        list_databases: () => this.databaseTools().list(this.scope.canRead),
        describe_database: () => this.databaseTools().describe(input.sourceId, this.scope.canRead),
        query_database_rows: () => this.databaseTools().rows(input, this.scope.canRead),
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
      // a tool may name the offending field (a bounded identifier, never user content)
      const field = object(error) && typeof error.field === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.field) ? error.field : undefined
      structured = toolError(code, field)
    }
    const output = resultEnvelope(structured)
    return bytes(output) <= LIMITS.responseBytes * 4 ? output : resultEnvelope(toolError('LIMIT_EXCEEDED'))
  }
}
