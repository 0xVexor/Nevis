import { DocumentHistory } from './history.ts'
import type { DocumentHistoryInput, UndoDocumentInput } from './history.ts'
import { failEdit as fail, translateEdit as translate } from './editErrors.ts'
export { DocumentEditError } from './editErrors.ts'
import { cloneDocumentValue } from './clone.ts'
import { canonicalDocumentValue } from './revision.ts'
import { planDocumentEdit, validateEditRequest } from './editPlanner.ts'
import type { EditDocumentInput } from './editPlanner.ts'
import type { DocumentAccessContext } from './contracts.ts'
import type { Page } from './model.ts'
import type { DocumentOperationRequest, DocumentOperationReceipt, DocumentOperationCommitResult, DocumentOperationRecord, DocumentOperationSummary } from './operations.ts'
import { savedEditEvidence, savedEditResult } from './savedEdit.ts'
import type { SavedEditEvidence, SavedSearch, SyncState } from './savedEdit.ts'
import { applyMetadata, metadataEvidence, prepareCreatedPage, validateCreate, validateMetadataUpdate } from './mutations.ts'
import type { CreateDocumentInput, UpdateDocumentMetadataInput } from './mutations.ts'
import { creationPosition } from './hierarchy.ts'
import type { CreationPosition } from './hierarchy.ts'

export interface DocumentEditGrant {
  readonly context: DocumentAccessContext
  isActive(): boolean
  canRead(documentId: string): boolean
  canWrite(documentId: string): boolean
  /** Explicit host permission to create and disclose the result beneath this parent (null = root). */
  canCreate?(parentId: string | null): boolean
}
export interface DocumentEditSource {
  readonly vaultHandle: string
  load(): Promise<Page[]>
  lookup(request: DocumentOperationRequest): Promise<DocumentOperationReceipt | null>
  commit(request: DocumentOperationRequest, before: Page | null, after: Page, check: () => void,
    evidence: (page: Page, receipt: DocumentOperationReceipt) => SavedEditEvidence, creation?: CreationPosition, requireNoChildren?: boolean): Promise<DocumentOperationCommitResult>
  now(): number
  listOperations(scopeId: string, documentId: string): Promise<DocumentOperationSummary[]>
  operationRecord(scopeId: string, operationId: string): Promise<DocumentOperationRecord | null>
  createId(): string
  search(receipt: DocumentOperationReceipt): Promise<SavedSearch>
  sync(): Promise<SyncState>
}
/** Internal scoped application service; pairing and MCP registration remain task 16. */
export class DocumentEditor {
  private readonly history: DocumentHistory
  private readonly source: DocumentEditSource
  private readonly grant: DocumentEditGrant
  private readonly context: DocumentAccessContext
  private readonly digest: (value: string) => Promise<string>
  constructor(source: DocumentEditSource, grant: DocumentEditGrant, digest: (value: string) => Promise<string>) {
    this.source = source; this.grant = grant; this.context = Object.freeze({ ...grant.context }); this.digest = digest
    this.authorize()
    this.history = new DocumentHistory(source, grant, digest)
  }
  getDocumentHistory(input: DocumentHistoryInput) { return this.history.getDocumentHistory(input) }
  async undoDocumentEdit(input: UndoDocumentInput) {
    return this.history.undoDocumentEdit(input, async (receipt, replayed) => (await this.result(receipt, replayed)).saved)
  }
  private authorize(documentId?: string) {
    if (this.context.vaultHandle !== this.source.vaultHandle || !this.grant.isActive()
      || canonicalDocumentValue(this.context) !== canonicalDocumentValue(this.grant.context)
      || (documentId !== undefined && (!this.grant.canRead(documentId) || !this.grant.canWrite(documentId)))) fail('ACCESS_DENIED')
  }
  private async result(receipt: DocumentOperationReceipt, replayed: boolean, check = () => this.authorize(receipt.documentId)) {
    check()
    if (!receipt.evidence) fail('RECOVERY_REQUIRED')
    let search: SavedSearch, sync: SyncState
    try { search = await this.source.search(receipt) } catch { search = { state: 'failed', indexedRevision: null } }
    check()
    try { sync = await this.source.sync() } catch { sync = 'pending' }
    check()
    return { mode: 'apply' as const, saved: savedEditResult(receipt, receipt.evidence, search, sync, replayed) }
  }
  private async racedReplay(request: DocumentOperationRequest, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/revision conflict|editor (has unsaved|changed)|commit in progress/i.test(message)) return null
    this.authorize(request.documentId!)
    const receipt = await this.source.lookup(request)
    this.authorize(request.documentId!)
    return receipt
  }
  async editDocument(input: EditDocumentInput) {
    this.authorize()
    try { validateEditRequest(input) } catch (error) { translate(error, 'INVALID_ARGUMENT') }
    input = cloneDocumentValue(input)
    this.authorize(input.documentId)
    const request: DocumentOperationRequest = { scopeId: this.context.grantId, operationId: input.operationId, kind: 'edit',
      documentId: input.documentId, expectedRevision: input.expectedRevision,
      payload: { tool: 'edit_document', operations: input.operations, ...(input.budget ? { budget: input.budget } : {}) } }
    if (input.mode === 'apply') {
      let prior: DocumentOperationReceipt | null
      try { prior = await this.source.lookup(request) } catch (error) { translate(error, 'APP_UNAVAILABLE') }
      this.authorize(input.documentId)
      if (prior) return this.result(prior, true)
    }
    let rows: Page[]
    try { rows = await this.source.load() } catch (error) { translate(error, 'APP_UNAVAILABLE') }
    this.authorize(input.documentId)
    const before = rows.find(page => page.id === input.documentId && page.deletedAt === null)
    if (!before) fail('NOT_FOUND')
    const links = new Set<string>()
    const check = () => {
      this.authorize(input.documentId)
      for (const id of links) if (!this.grant.canRead(id)) fail('ACCESS_DENIED')
    }
    let plan
    try { plan = await planDocumentEdit(before, input, { digest: this.digest, canLink: id => { links.add(id); return this.grant.canRead(id) } }) }
    catch (error) {
      if (input.mode === 'apply') {
        let prior
        try { prior = await this.racedReplay(request, error) } catch (lookupError) { translate(lookupError, 'APP_UNAVAILABLE') }
        if (prior) return this.result(prior, true)
      }
      translate(error, 'INVALID_ARGUMENT')
    }
    check()
    if (input.mode === 'preview') return plan.preview
    let result: DocumentOperationCommitResult
    try { result = await this.source.commit(request, plan.before, plan.after, check,
      (page, receipt) => savedEditEvidence(page, receipt, plan.affectedBlockIds, input.budget)) }
    catch (error) {
      let prior
      try { prior = await this.racedReplay(request, error) } catch (lookupError) { translate(lookupError, 'APP_UNAVAILABLE') }
      if (prior) return this.result(prior, true)
      translate(error, 'PERSISTENCE_FAILED')
    }
    check()
    return this.result(result.receipt, result.replayed)
  }

  async createDocument(input: CreateDocumentInput) {
    this.authorize()
    try { validateCreate(input) } catch (error) { translate(error, 'INVALID_ARGUMENT') }
    input = cloneDocumentValue(input)
    const links = new Set<string>()
    const check = () => {
      this.authorize()
      if (!this.grant.canCreate?.(input.parentId) || (input.parentId !== null && (!this.grant.canRead(input.parentId) || !this.grant.canWrite(input.parentId)))) fail('ACCESS_DENIED')
      for (const id of links) if (!this.grant.canRead(id)) fail('ACCESS_DENIED')
    }
    check()
    const request: DocumentOperationRequest = { scopeId: this.context.grantId, operationId: input.operationId, kind: 'create', documentId: null, expectedRevision: null,
      payload: { tool: 'create_document', parentId: input.parentId, kind: input.kind, metadata: input.metadata, content: input.content } }
    let prior
    try { prior = await this.source.lookup(request) } catch (error) { translate(error, 'APP_UNAVAILABLE') }
    check()
    if (prior) return (await this.result(prior, true, check)).saved
    let rows: Page[]
    try { rows = await this.source.load() } catch (error) { translate(error, 'APP_UNAVAILABLE') }
    check()
    let id = ''
    for (let attempt = 0; attempt < 8; attempt++) { id = this.source.createId(); if (/^[A-Za-z0-9_-]{1,80}$/.test(id) && !rows.some(page => page.id === id)) break; id = '' }
    if (!id) fail('CAPABILITY_UNAVAILABLE')
    let position, planned
    try {
      position = creationPosition(rows, input.parentId)
      planned = await prepareCreatedPage(input, id, position.sort, { digest: this.digest, canLink: id => { links.add(id); return this.grant.canRead(id) } })
    } catch (error) { translate(error, 'INVALID_ARGUMENT') }
    check()
    let committed
    try { committed = await this.source.commit(request, null, planned.after, check,
      (page, receipt) => savedEditEvidence(page, receipt, planned.affected, undefined, metadataEvidence(page)), position.precondition) }
    catch (error) {
      // A concurrent identical create may already own a different generated identity.
      if (/revision conflict|commit in progress/i.test(error instanceof Error ? error.message : String(error))) {
        try { prior = await this.source.lookup(request) } catch (lookupError) { translate(lookupError, 'APP_UNAVAILABLE') }
        check()
        if (prior) return (await this.result(prior, true, check)).saved
      }
      translate(error, 'PERSISTENCE_FAILED')
    }
    check()
    return (await this.result(committed.receipt, committed.replayed, check)).saved
  }

  async updateDocumentMetadata(input: UpdateDocumentMetadataInput) {
    this.authorize()
    try { validateMetadataUpdate(input) } catch (error) { translate(error, 'INVALID_ARGUMENT') }
    input = cloneDocumentValue(input)
    const check = () => this.authorize(input.documentId)
    check()
    const request: DocumentOperationRequest = { scopeId: this.context.grantId, operationId: input.operationId, kind: 'edit', documentId: input.documentId,
      expectedRevision: input.expectedRevision, payload: { tool: 'update_document_metadata', patch: input.patch } }
    let prior, rows: Page[]
    try { prior = await this.source.lookup(request) } catch (error) { translate(error, 'APP_UNAVAILABLE') }
    check()
    if (prior) return (await this.result(prior, true)).saved
    try { rows = await this.source.load() } catch (error) { translate(error, 'APP_UNAVAILABLE') }
    check()
    const before = rows.find(page => page.id === input.documentId && page.deletedAt === null)
    if (!before) fail('NOT_FOUND')
    const after = applyMetadata(before, input.patch)
    let committed
    try { committed = await this.source.commit(request, before, after, check,
      (page, receipt) => savedEditEvidence(page, receipt, [], undefined, metadataEvidence(page))) }
    catch (error) {
      try { prior = await this.racedReplay(request, error) } catch (lookupError) { translate(lookupError, 'APP_UNAVAILABLE') }
      if (prior) return (await this.result(prior, true)).saved
      translate(error, 'PERSISTENCE_FAILED')
    }
    check()
    return (await this.result(committed.receipt, committed.replayed)).saved
  }
}
