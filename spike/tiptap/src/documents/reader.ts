import { BLOCK_TYPES, BLOCK_IDENTITY_VERSION, identityVersion, isBlockId } from './blockIdentity.ts'
import type { IdentityNode } from './blockIdentity.ts'
import { cloneDocumentValue } from './clone.ts'
import { CONTRACT_VERSION, LIMITS } from './contracts.ts'
import type { DocumentAccessContext } from './contracts.ts'
import type { Page, PageKind } from './model.ts'
import { readMarkdown } from './readMarkdown.ts'
import { LEXICAL_PROJECTION_VERSION, LexicalSearchError, sourcePassage } from './lexicalSearch.ts'
import { ManagedLexicalIndex } from './searchLifecycle.ts'
import type { SearchIndexRuntime } from './searchLifecycle.ts'
import type { SearchMode } from './lexicalSearch.ts'
import { canonicalDocumentValue as canonical, documentRevision } from './revision.ts'

export interface DocumentReadGrant {
  readonly context: DocumentAccessContext
  isActive(): boolean
  /** Trusted host policy must include inherited exclusions. Never derived from notes. */
  canRead(documentId: string): boolean
}
export interface DocumentReadRuntime {
  now(): number
  /** Host supplies cryptographically random opaque tokens, not sequential IDs. */
  cursorId(): string
  /** Host supplies SHA-256 (or stronger) over the exact canonical snapshot. */
  digest(canonicalSnapshot: string): Promise<string>
}
export interface DocumentReadSource {
  readonly vaultHandle: string
  /** Only a trusted retained-snapshot source may opt in; live readers exclude tombstones. */
  includeDeleted?: boolean
  searchRuntime?: SearchIndexRuntime
  load(): Promise<Page[]>
}
export interface ListDocumentsInput {
  parentId?: string | null; recursive?: boolean; kinds?: PageKind[]; tags?: string[]
  favorite?: boolean; limit?: number; cursor?: string
}
export interface ReadDocumentInput {
  documentId: string; expectedRevision?: string
  target: { kind: 'outline' | 'full' } | { kind: 'section'; headingBlockId: string } | { kind: 'blocks'; blockIds: string[] }
  format: 'markdown' | 'structured' | 'both'
  budget?: { maxChars: number; maxBlocks: number }; cursor?: string
}
export interface SearchDocumentsInput {
  query: string; mode: SearchMode; documentIds?: string[]; tags?: string[]
  budget?: { maxChars: number; maxBlocks: number }; limit?: number; cursor?: string
}
type ReadCode = 'ACCESS_DENIED' | 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'INVALID_TARGET' | 'LIMIT_EXCEEDED' | 'STALE_CURSOR' | 'REVISION_CONFLICT' | 'CAPABILITY_UNAVAILABLE' | 'APP_UNAVAILABLE'
export class DocumentReadError extends Error {
  readonly code: ReadCode
  readonly retryable: boolean
  readonly details?: { currentRevision: string }
  constructor(code: ReadCode, details?: { currentRevision: string }) {
    super(code.replaceAll('_', ' ').toLowerCase())
    this.code = code
    this.retryable = code === 'APP_UNAVAILABLE'
    this.details = details
  }
}
function fail(code: ReadCode): never { throw new DocumentReadError(code) }
const chars = (value: string) => [...value].length
const bytes = (value: string) => { let size = 0; for (const char of value) { const cp = char.codePointAt(0)!; size += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4 } return size }
const fields = (value: object, allowed: string[]) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENT') }
const integer = (value: number, max: number) => { if (!Number.isInteger(value) || value < 1 || value > max) fail('INVALID_ARGUMENT'); return value }
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && chars(value) <= 256
const blockTypes = new Set<string>(BLOCK_TYPES)
const readable = [...BLOCK_TYPES, 'text', 'hardBreak', 'pageLink', 'mathInline', 'inlineIcon']
const capabilities = {
  contractVersion: CONTRACT_VERSION, blockIdentity: 'stable' as const, readableNodeTypes: readable,
  writableNodeTypes: [], writableMarks: [], writableAttributes: [], operations: [], preservesUntouchedUnsupportedNodes: false,
}
type Warning = { code: 'UNSUPPORTED_CONTENT' | 'LOSSY_MARKDOWN'; message: string; blockIds: string[] }
type Chunk = { range: { fromBlockId: string; throughBlockId: string } | null; markdown: string | null; structured: IdentityNode[] | null }
type Position = { node: IdentityNode; siblings: IdentityNode[]; index: number; path: number[] }
type Cursor = { binding: string; snapshot: string; offset: number; expiresAt: number }

/** Internal read service only; transport registration/pairing remains NV-MCP-16. */
export class DocumentReader {
  private readonly source: DocumentReadSource
  private readonly grant: DocumentReadGrant
  private readonly runtime: DocumentReadRuntime
  private readonly context: DocumentAccessContext
  private readonly cursors = new Map<string, Cursor>()
  private readonly searchIndex: ManagedLexicalIndex
  constructor(source: DocumentReadSource, grant: DocumentReadGrant, runtime: DocumentReadRuntime) {
    this.source = source; this.grant = grant; this.runtime = runtime
    this.context = Object.freeze({ ...grant.context })
    this.searchIndex = new ManagedLexicalIndex(source.searchRuntime)
    this.authorize()
  }
  private authorize(documentId?: string) {
    if (this.context.vaultHandle !== this.source.vaultHandle || !this.grant.isActive()
      || canonical(this.context) !== canonical(this.grant.context)
      || (documentId !== undefined && !this.grant.canRead(documentId))) fail('ACCESS_DENIED')
  }
  private async revision(page: Page) {
    try { return await documentRevision(page, snapshot => this.runtime.digest(snapshot)) }
    catch { return fail('APP_UNAVAILABLE') }
  }
  private async load() {
    try { return await this.source.load() }
    catch { this.authorize(); return fail('APP_UNAVAILABLE') }
  }
  private binding(tool: string, request: object) {
    const { cursor: _cursor, ...args } = request as Record<string, unknown>
    return canonical({ tool, args, context: this.context })
  }
  private offset(token: string | undefined, binding: string, snapshot: string) {
    if (token === undefined) return 0
    const state = this.cursors.get(token)
    if (!state || state.expiresAt <= this.runtime.now() || state.binding !== binding || state.snapshot !== snapshot) fail('STALE_CURSOR')
    return state.offset
  }
  private continuation(binding: string, snapshot: string, offset: number) {
    for (const [key, state] of this.cursors) if (state.expiresAt <= this.runtime.now()) this.cursors.delete(key)
    while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!)
    for (let attempt = 0; attempt < 8; attempt++) {
      const token = this.runtime.cursorId()
      if (!/^[a-zA-Z0-9_-]{1,256}$/.test(token) || this.cursors.has(token)) continue
      this.cursors.set(token, { binding, snapshot, offset, expiresAt: this.runtime.now() + LIMITS.cursorLifetimeMs })
      return token
    }
    return fail('APP_UNAVAILABLE')
  }
  private fits(result: object) { return bytes(JSON.stringify({ ok: true, result })) <= LIMITS.responseBytes }
  private request(input: object) { if (bytes(JSON.stringify(input)) > LIMITS.requestBytes) fail('LIMIT_EXCEEDED') }

  async listDocuments(input: ListDocumentsInput = {}) {
    this.authorize()
    fields(input, ['parentId', 'recursive', 'kinds', 'tags', 'favorite', 'limit', 'cursor'])
    this.request(input)
    const limit = integer(input.limit ?? 20, LIMITS.pageSize)
    if (input.cursor !== undefined && !id(input.cursor)) fail('INVALID_ARGUMENT')
    if (input.parentId !== undefined && input.parentId !== null && !id(input.parentId)) fail('INVALID_ARGUMENT')
    if (input.parentId) this.authorize(input.parentId)
    if (input.recursive !== undefined && typeof input.recursive !== 'boolean') fail('INVALID_ARGUMENT')
    if (input.favorite !== undefined && typeof input.favorite !== 'boolean') fail('INVALID_ARGUMENT')
    if (input.kinds && (!Array.isArray(input.kinds) || !input.kinds.length || input.kinds.length > 4 || input.kinds.some(kind => !['page', 'folder', 'board', 'todo'].includes(kind)))) fail('INVALID_ARGUMENT')
    if (input.tags && (!Array.isArray(input.tags) || input.tags.length > 50 || input.tags.some(tag => !id(tag) || chars(tag) > 128))) fail('INVALID_ARGUMENT')
    const rows = (await this.load()).filter(page => page.deletedAt === null && this.grant.canRead(page.id))
    this.authorize()
    const visible = new Map(rows.map(page => [page.id, page]))
    if (input.parentId && !visible.has(input.parentId)) fail('NOT_FOUND')
    const parent = (page: Page) => page.parentId && visible.has(page.parentId) ? page.parentId : null
    const children = new Map<string | null, Page[]>()
    for (const page of rows) { const key = parent(page); const group = children.get(key) ?? []; group.push(page); children.set(key, group) }
    for (const group of children.values()) group.sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const ordered: Page[] = [], seen = new Set<string>()
    const visit = (page: Page, descend: boolean) => {
      if (seen.has(page.id)) return
      seen.add(page.id)
      if ((!input.kinds || input.kinds.includes(page.kind ?? 'page')) && (!input.tags || input.tags.every(tag => page.tags?.includes(tag)))
        && (input.favorite === undefined || page.favorite === input.favorite)) ordered.push(page)
      if (descend) for (const child of children.get(page.id) ?? []) visit(child, true)
    }
    if (input.parentId === undefined) {
      for (const page of children.get(null) ?? []) visit(page, true)
    } else for (const page of children.get(input.parentId) ?? []) visit(page, input.recursive ?? false)
    const summaries = await Promise.all(ordered.map(async page => ({
      documentId: page.id, revision: await this.revision(page), parentId: parent(page), kind: page.kind ?? 'page', updatedAt: page.updatedAt,
      metadata: { title: page.title, tags: page.tags ?? [], favorite: page.favorite,
        ...(page.icon !== undefined ? { icon: page.icon } : {}), ...(page.status !== undefined ? { status: page.status } : {}),
        ...(page.titleDir !== undefined ? { titleDir: page.titleDir } : {}),
        ...(page.cover !== undefined ? { cover: cloneDocumentValue(page.cover) } : {}),
      },
    })))
    this.authorize()
    // Recheck document policy after asynchronous revision work, before any disclosure.
    for (const page of ordered) this.authorize(page.id)
    const snapshot = await this.runtime.digest(canonical(summaries))
    const binding = this.binding('list_documents', input)
    const start = this.offset(input.cursor, binding, snapshot)
    const documents: typeof summaries = []
    let offset = start
    while (offset < summaries.length && documents.length < limit) {
      const next = [...documents, summaries[offset]]
      if (!this.fits({ documents: next, nextCursor: 'x'.repeat(256), truncated: true })) break
      documents.push(summaries[offset++])
    }
    if (offset < summaries.length && !documents.length) fail('LIMIT_EXCEEDED')
    this.authorize()
    for (const summary of documents) this.authorize(summary.documentId)
    const truncated = offset < summaries.length
    return cloneDocumentValue({ documents, nextCursor: truncated ? this.continuation(binding, snapshot, offset) : null, truncated })
  }

  async readDocument(input: ReadDocumentInput) {
    this.authorize()
    fields(input, ['documentId', 'expectedRevision', 'target', 'format', 'budget', 'cursor'])
    this.request(input)
    if (!id(input.documentId) || !['markdown', 'structured', 'both'].includes(input.format)) fail('INVALID_ARGUMENT')
    if (input.cursor !== undefined && !id(input.cursor)) fail('INVALID_ARGUMENT')
    this.authorize(input.documentId)
    const budget = input.budget ?? { maxChars: 8000, maxBlocks: 50 }
    fields(budget, ['maxChars', 'maxBlocks'])
    integer(budget.maxChars, LIMITS.textChars); integer(budget.maxBlocks, 100)
    if (input.expectedRevision !== undefined && !id(input.expectedRevision)) fail('INVALID_ARGUMENT')
    const page = (await this.load()).find(row => row.id === input.documentId && (this.source.includeDeleted || row.deletedAt === null))
    this.authorize(input.documentId)
    if (!page) fail('NOT_FOUND')
    const revision = await this.revision(page)
    this.authorize(input.documentId)
    // Cursor staleness wins over an optional old revision precondition.
    const binding = this.binding('read_document', input)
    const start = this.offset(input.cursor, binding, revision)
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) throw new DocumentReadError('REVISION_CONFLICT', { currentRevision: revision })
    if (identityVersion(page.content) !== BLOCK_IDENTITY_VERSION || page.content?.type !== 'doc') fail('CAPABILITY_UNAVAILABLE')
    const positions = new Map<string, Position>(), headings: IdentityNode[] = []
    const index = (siblings: IdentityNode[], path: number[] = []) => siblings.forEach((node, position) => {
      if (path.length > LIMITS.maxDepth) fail('LIMIT_EXCEEDED')
      if (blockTypes.has(node.type)) {
        if (!isBlockId(node.attrs?.blockId) || positions.has(node.attrs.blockId)) fail('CAPABILITY_UNAVAILABLE')
        positions.set(node.attrs.blockId, { node, siblings, index: position, path: [...path, position] })
      }
      if (node.type === 'heading') headings.push(node)
      if (node.content) index(node.content, [...path, position])
    })
    index(page.content.content ?? [])
    const target = input.target
    let selected: IdentityNode[]
    if (target?.kind === 'full' || target?.kind === 'outline') {
      fields(target, ['kind'])
      selected = target.kind === 'outline' ? headings : page.content.content ?? []
    } else if (target?.kind === 'section') {
      fields(target, ['kind', 'headingBlockId'])
      const from = positions.get(target.headingBlockId)
      if (!from || from.node.type !== 'heading') fail('INVALID_TARGET')
      let end = from.index + 1
      while (end < from.siblings.length && !(from.siblings[end].type === 'heading' && Number(from.siblings[end].attrs?.level ?? 1) <= Number(from.node.attrs?.level ?? 1))) end++
      selected = from.siblings.slice(from.index, end)
    } else if (target?.kind === 'blocks') {
      fields(target, ['kind', 'blockIds'])
      if (!Array.isArray(target.blockIds) || !target.blockIds.length || target.blockIds.length > 100 || target.blockIds.some(value => !id(value))) fail('INVALID_ARGUMENT')
      const picked = target.blockIds.map(value => positions.get(value) ?? fail('INVALID_TARGET'))
      if (picked.some((entry, i) => picked.some((other, j) => i !== j && other.path.length <= entry.path.length && other.path.every((value, k) => entry.path[k] === value)))) fail('INVALID_TARGET')
      selected = picked.map(entry => entry.node)
    } else return fail('INVALID_ARGUMENT')
    const chunks: Chunk[] = [], warnings: Warning[] = []
    let offset = start, usedChars = 0, usedBlocks = 0, usedNodes = 0
    const warn = (code: Warning['code'], blockId?: string) => {
      let warning = warnings.find(item => item.code === code)
      if (!warning) { warning = { code, message: code === 'UNSUPPORTED_CONTENT' ? 'Some content requires structured output for fidelity.' : 'Markdown omits rich attributes; use structured output for fidelity.', blockIds: [] }; warnings.push(warning) }
      if (blockId && !warning.blockIds.includes(blockId)) warning.blockIds.push(blockId)
    }
    while (offset < selected.length) {
      const node = selected[offset]
      let count = 0, nodes = 0, unsupported = false, rich = false
      const inspect = (part: IdentityNode) => {
        nodes++
        if (blockTypes.has(part.type) || !readable.includes(part.type as typeof readable[number])) count++
        if (!readable.includes(part.type as typeof readable[number])) unsupported = true
        if (Object.keys(part.attrs ?? {}).some(key => !['blockId', 'level', 'language', 'checked', 'start'].includes(key))) rich = true
        part.content?.forEach(inspect)
      }
      inspect(node)
      count = Math.max(1, count)
      const rendered = readMarkdown(node)
      const chunk: Chunk = {
        range: blockTypes.has(node.type) && isBlockId(node.attrs?.blockId) ? { fromBlockId: node.attrs.blockId, throughBlockId: node.attrs.blockId } : null,
        markdown: input.format === 'structured' ? null : rendered,
        structured: input.format === 'markdown' ? null : [cloneDocumentValue(node)],
      }
      const size = chars(chunk.markdown ?? '') + (chunk.structured ? chars(JSON.stringify(chunk.structured)) : 0)
      const previousWarnings = cloneDocumentValue(warnings)
      if (unsupported || (input.format !== 'structured' && rendered === null)) warn('UNSUPPORTED_CONTENT', chunk.range?.fromBlockId)
      if (rich && input.format !== 'structured') warn('LOSSY_MARKDOWN', chunk.range?.fromBlockId)
      if (usedBlocks + count > budget.maxBlocks || usedChars + size > budget.maxChars || usedNodes + nodes > LIMITS.maxNodes
        || !this.fits({ documentId: page.id, revision, capabilities, chunks: [...chunks, chunk], warnings, nextCursor: 'x'.repeat(256), truncated: true })) {
        warnings.splice(0, warnings.length, ...previousWarnings)
        break
      }
      chunks.push(chunk); usedChars += size; usedBlocks += count; usedNodes += nodes; offset++
    }
    if (offset < selected.length && !chunks.length) fail('LIMIT_EXCEEDED')
    this.authorize(input.documentId)
    const truncated = offset < selected.length
    return { documentId: page.id, revision, capabilities: cloneDocumentValue(capabilities), chunks, warnings,
      nextCursor: truncated ? this.continuation(binding, revision, offset) : null, truncated }
  }

  async searchDocuments(input: SearchDocumentsInput) {
    this.authorize()
    fields(input, ['query', 'mode', 'documentIds', 'tags', 'budget', 'limit', 'cursor'])
    this.request(input)
    if (typeof input.query !== 'string' || !input.query.trim() || chars(input.query) > 2048 || !['keywords', 'phrase', 'literal'].includes(input.mode)) fail('INVALID_ARGUMENT')
    if (input.cursor !== undefined && !id(input.cursor)) fail('INVALID_ARGUMENT')
    if (input.documentIds !== undefined && (!Array.isArray(input.documentIds) || !input.documentIds.length || input.documentIds.length > 100 || input.documentIds.some(value => !id(value)))) fail('INVALID_ARGUMENT')
    for (const documentId of input.documentIds ?? []) this.authorize(documentId)
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 50 || input.tags.some(tag => !id(tag) || chars(tag) > 128))) fail('INVALID_ARGUMENT')
    const limit = integer(input.limit ?? 20, LIMITS.pageSize)
    const budget = input.budget ?? { maxChars: 8000, maxBlocks: 50 }
    fields(budget, ['maxChars', 'maxBlocks'])
    integer(budget.maxChars, LIMITS.textChars); integer(budget.maxBlocks, 100)
    const pages = (await this.load()).filter(page => page.deletedAt === null && page.kind !== 'folder' && this.grant.canRead(page.id)
      && (!input.documentIds || input.documentIds.includes(page.id)) && (!input.tags || input.tags.every(tag => page.tags?.includes(tag))))
    this.authorize()
    const revisions = new Map(await Promise.all(pages.map(async page => [page.id, await this.revision(page)] as const)))
    for (const page of pages) this.authorize(page.id)
    const snapshot = await this.runtime.digest(canonical({ version: LEXICAL_PROJECTION_VERSION, revisions: [...revisions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) }))
    this.authorize()
    const binding = this.binding('search_documents', input)
    const start = this.offset(input.cursor, binding, snapshot)
    const prepared = await this.searchIndex.prepare(pages, snapshot)
    this.authorize()
    for (const page of pages) this.authorize(page.id)
    if (prepared.state !== 'fresh' || !prepared.index) {
      return { hits: [], search: { state: prepared.state, indexedRevision: null },
        warnings: [{ code: prepared.state === 'pending' ? 'INDEX_PENDING' as const : 'INDEX_FAILED' as const, message: 'Search index is ' + prepared.state + '; retry the query.', blockIds: [] as string[] }], nextCursor: null, truncated: false }
    }
    const index = prepared.index
    let matches: ReturnType<typeof index.search>
    try { matches = index.search(input.query, input.mode) }
    catch (error) { if (error instanceof LexicalSearchError) fail(error.code); return fail('APP_UNAVAILABLE') }
    const warnings = index.unsupportedDocumentIds.size ? [{ code: 'UNSUPPORTED_CONTENT' as const, message: 'Some authorized content has no supported searchable projection.', blockIds: [] as string[] }] : []
    const search = { state: 'fresh' as const, indexedRevision: pages.length === 1 ? revisions.get(pages[0].id)! : null }
    type Hit = { documentId: string; revision: string; range: { fromBlockId: string; throughBlockId: string } | null; source: 'title' | 'tag' | 'body'; passage: string; score: number }
    const hits: Hit[] = []
    let offset = start, usedChars = 0
    while (offset < matches.length && hits.length < Math.min(limit, budget.maxBlocks)) {
      const match = matches[offset]
      const passage = sourcePassage(match, budget.maxChars - usedChars)
      if (passage === null || !passage) break
      const hit: Hit = { documentId: match.documentId, revision: revisions.get(match.documentId)!, source: match.source,
        range: match.blockId ? { fromBlockId: match.blockId, throughBlockId: match.blockId } : null, passage, score: match.score }
      if (!this.fits({ hits: [...hits, hit], search, warnings, nextCursor: 'x'.repeat(256), truncated: true })) break
      hits.push(hit); offset++; usedChars += chars(passage)
    }
    if (offset < matches.length && !hits.length) fail('LIMIT_EXCEEDED')
    this.authorize()
    for (const hit of hits) this.authorize(hit.documentId)
    const truncated = offset < matches.length
    return { hits, search, warnings, nextCursor: truncated ? this.continuation(binding, snapshot, offset) : null, truncated }
  }
}
