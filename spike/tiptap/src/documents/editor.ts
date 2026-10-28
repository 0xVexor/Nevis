import { cloneDocumentValue } from './clone.ts'
import { canonicalDocumentValue } from './revision.ts'
import { DocumentPlanError, planDocumentEdit, validateEditRequest } from './editPlanner.ts'
import type { EditDocumentInput } from './editPlanner.ts'
import type { DocumentAccessContext, ERROR_CODES } from './contracts.ts'
import type { Page } from './model.ts'
import type { DocumentOperationRequest, DocumentOperationReceipt, DocumentOperationCommitResult } from './operations.ts'
import { savedEditEvidence, savedEditResult } from './savedEdit.ts'
import type { SavedEditEvidence, SavedSearch, SyncState } from './savedEdit.ts'

export interface DocumentEditGrant {
  readonly context: DocumentAccessContext
  isActive(): boolean
  canRead(documentId: string): boolean
  canWrite(documentId: string): boolean
}
export interface DocumentEditSource {
  readonly vaultHandle: string
  load(): Promise<Page[]>
  lookup(request: DocumentOperationRequest): Promise<DocumentOperationReceipt | null>
  commit(request: DocumentOperationRequest, before: Page, after: Page, check: () => void,
    evidence: (page: Page, receipt: DocumentOperationReceipt) => SavedEditEvidence): Promise<DocumentOperationCommitResult>
  search(receipt: DocumentOperationReceipt): Promise<SavedSearch>
  sync(): Promise<SyncState>
}
type EditCode = typeof ERROR_CODES[number]
export class DocumentEditError extends Error {
  readonly code: EditCode
  readonly retryable: boolean
  constructor(code: EditCode) { super(code.replaceAll('_', ' ').toLowerCase()); this.code = code; this.retryable = ['EDITOR_BUSY', 'APP_UNAVAILABLE'].includes(code) }
}
function fail(code: EditCode): never { throw new DocumentEditError(code) }
function translate(error: unknown, fallback: EditCode): never {
  if (error instanceof DocumentEditError) throw error
  if (error instanceof DocumentPlanError) return fail(error.code)
  const message = error instanceof Error ? error.message : String(error)
  if (/ID reused/.test(message)) fail('OPERATION_ID_MISMATCH')
  if (/revision conflict/i.test(message)) fail('REVISION_CONFLICT')
  if (/editor (has unsaved|changed)|commit in progress/i.test(message)) fail('EDITOR_BUSY')
  if (/recovery|prepared operation|Conflicting document operation/i.test(message)) fail('RECOVERY_REQUIRED')
  if (/vault changed/i.test(message)) fail('ACCESS_DENIED')
  if (/storage is unavailable/.test(message)) fail('APP_UNAVAILABLE')
  if (/evidence limit/.test(message)) fail('LIMIT_EXCEEDED')
  fail(fallback)
}

/** Internal scoped application service; pairing and MCP registration remain task 16. */
export class DocumentEditor {
  private readonly source: DocumentEditSource
  private readonly grant: DocumentEditGrant
  private readonly context: DocumentAccessContext
  private readonly digest: (value: string) => Promise<string>
  constructor(source: DocumentEditSource, grant: DocumentEditGrant, digest: (value: string) => Promise<string>) {
    this.source = source; this.grant = grant; this.context = Object.freeze({ ...grant.context }); this.digest = digest
    this.authorize()
  }
  private authorize(documentId?: string) {
    if (this.context.vaultHandle !== this.source.vaultHandle || !this.grant.isActive()
      || canonicalDocumentValue(this.context) !== canonicalDocumentValue(this.grant.context)
      || (documentId !== undefined && (!this.grant.canRead(documentId) || !this.grant.canWrite(documentId)))) fail('ACCESS_DENIED')
  }
  private async result(receipt: DocumentOperationReceipt, replayed: boolean) {
    this.authorize(receipt.documentId)
    if (!receipt.evidence) fail('RECOVERY_REQUIRED')
    let search: SavedSearch, sync: SyncState
    try { search = await this.source.search(receipt) } catch { search = { state: 'failed', indexedRevision: null } }
    this.authorize(receipt.documentId)
    try { sync = await this.source.sync() } catch { sync = 'pending' }
    this.authorize(receipt.documentId)
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
}
