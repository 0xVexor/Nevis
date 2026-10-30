import { isBlockId } from './blockIdentity.ts'
import { cloneDocumentValue } from './clone.ts'
import { LIMITS } from './contracts.ts'
import type { DocumentAccessContext } from './contracts.ts'
import { failEdit as fail, translateEdit as translate } from './editErrors.ts'
import type { DocumentEditGrant, DocumentEditSource } from './editor.ts'
import { DocumentReader } from './reader.ts'
import { canonicalDocumentValue, documentRevision } from './revision.ts'
import { historyExpiresAt, validateOperationRecord } from './operations.ts'
import type { DocumentOperationRecord, DocumentOperationSummary } from './operations.ts'
import { metadataEvidence } from './mutations.ts'
import { savedEditEvidence } from './savedEdit.ts'
import type { savedEditResult } from './savedEdit.ts'
import type { Page } from './model.ts'

export interface DocumentHistoryInput {
  documentId: string; versionId?: string; format?: 'markdown' | 'structured' | 'both'
  budget?: { maxChars: number; maxBlocks: number }; limit?: number; cursor?: string
}
export interface UndoDocumentInput {
  documentId: string; operationId: string; undoOperationId: string; expectedRevision: string; mode?: 'preview' | 'apply'
}
type Cursor = { binding: string; snapshot: string; offset: number; expiresAt: number }
const id = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= max
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
function fields(value: unknown, allowed: string[], required: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_ARGUMENT')
}
const byteLength = (value: unknown) => [...JSON.stringify(value)].reduce((sum, char) => sum + (char.codePointAt(0)! < 128 ? 1 : char.codePointAt(0)! < 2048 ? 2 : char.codePointAt(0)! < 65536 ? 3 : 4), 0)

/** History is local to this grant and device. Retry receipts outlive the snapshot visibility window. */
export class DocumentHistory {
  private readonly context: DocumentAccessContext
  private readonly cursors = new Map<string, Cursor>()
  private readonly readers = new Map<string, DocumentReader>()
  private readonly source: DocumentEditSource
  private readonly grant: DocumentEditGrant
  private readonly digest: (value: string) => Promise<string>
  constructor(source: DocumentEditSource, grant: DocumentEditGrant, digest: (value: string) => Promise<string>) {
    this.source = source; this.grant = grant; this.digest = digest
    this.context = Object.freeze({ ...grant.context })
  }
  private authorize(documentId: string, write = false) {
    if (this.context.vaultHandle !== this.source.vaultHandle || !this.grant.isActive()
      || canonicalDocumentValue(this.context) !== canonicalDocumentValue(this.grant.context)
      || !this.grant.canRead(documentId) || (write && !this.grant.canWrite(documentId))) fail('ACCESS_DENIED')
  }
  private async summaries(documentId: string) {
    this.authorize(documentId)
    let rows: DocumentOperationSummary[]
    try { rows = await this.source.listOperations(this.context.grantId, documentId) } catch (error) { this.authorize(documentId); translate(error, 'APP_UNAVAILABLE') }
    this.authorize(documentId)
    return rows.filter(row => row.documentId === documentId && historyExpiresAt(row.committedAt) > this.source.now())
  }
  private async record(documentId: string, operationId: string) {
    this.authorize(documentId)
    let record: DocumentOperationRecord | null
    try { record = await this.source.operationRecord(this.context.grantId, operationId) } catch (error) { this.authorize(documentId); translate(error, 'APP_UNAVAILABLE') }
    this.authorize(documentId)
    if (!record) fail('VERSION_EXPIRED')
    try { validateOperationRecord(record) } catch { fail('RECOVERY_REQUIRED') }
    if (record.scopeId !== this.context.grantId || record.operationId !== operationId || record.after.id !== documentId) fail('VERSION_EXPIRED')
    try {
      if (await documentRevision(record.after, this.digest) !== record.receipt.revision
        || (record.before && await documentRevision(record.before, this.digest) !== record.receipt.beforeRevision)) fail('RECOVERY_REQUIRED')
    } catch (error) { translate(error, 'APP_UNAVAILABLE') }
    this.authorize(documentId)
    return record
  }
  private continuation(binding: string, snapshot: string, offset: number) {
    for (const [key, value] of this.cursors) if (value.expiresAt <= this.source.now()) this.cursors.delete(key)
    while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!)
    for (let i = 0; i < 8; i++) {
      const key = this.source.createId()
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(key) || this.cursors.has(key)) continue
      this.cursors.set(key, { binding, snapshot, offset, expiresAt: this.source.now() + LIMITS.cursorLifetimeMs })
      return key
    }
    return fail('APP_UNAVAILABLE')
  }
  async getDocumentHistory(input: DocumentHistoryInput) {
    fields(input, ['documentId', 'versionId', 'format', 'budget', 'limit', 'cursor'], ['documentId'])
    if (!id(input.documentId) || (input.versionId !== undefined && !id(input.versionId)) || (input.cursor !== undefined && !id(input.cursor, 4096))
      || (input.format !== undefined && !['markdown', 'structured', 'both'].includes(input.format))) fail('INVALID_ARGUMENT')
    if (input.budget !== undefined) {
      fields(input.budget, ['maxChars', 'maxBlocks'], ['maxChars', 'maxBlocks'])
      if (!Number.isInteger(input.budget.maxChars) || input.budget.maxChars < 1 || input.budget.maxChars > LIMITS.textChars
        || !Number.isInteger(input.budget.maxBlocks) || input.budget.maxBlocks < 1 || input.budget.maxBlocks > 100) fail('INVALID_ARGUMENT')
    }
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) fail('INVALID_ARGUMENT')
    input = cloneDocumentValue(input)
    const rows = await this.summaries(input.documentId)
    const versions = rows.flatMap(row => [
      { versionId: `after:${row.operationId}`, operationId: row.operationId, revision: row.revision, committedAt: row.committedAt, expiresAt: historyExpiresAt(row.committedAt) },
      ...(row.beforeRevision ? [{ versionId: `before:${row.operationId}`, operationId: row.operationId, revision: row.beforeRevision, committedAt: row.committedAt, expiresAt: historyExpiresAt(row.committedAt) }] : []),
    ])
    const retention = { earliestAvailableAt: rows.length ? Math.min(...rows.map(row => row.committedAt)) : null, complete: false }
    if (input.versionId !== undefined) {
      const version = versions.find(row => row.versionId === input.versionId)
      if (!version) fail('VERSION_EXPIRED')
      const record = await this.record(input.documentId, version.operationId)
      const page = input.versionId.startsWith('before:') ? record.before! : record.after
      const key = `${input.versionId}/${version.revision}`
      let reader = this.readers.get(key)
      if (!reader) {
        while (this.readers.size >= 80) this.readers.delete(this.readers.keys().next().value!)
        reader = new DocumentReader({ vaultHandle: this.source.vaultHandle, includeDeleted: true, load: async () => [cloneDocumentValue(page)] }, this.grant,
          { now: () => this.source.now(), cursorId: () => this.source.createId(), digest: this.digest })
        this.readers.set(key, reader)
      }
      let retainedContent
      try { retainedContent = await reader.readDocument({ documentId: input.documentId, expectedRevision: version.revision, target: { kind: 'full' }, format: input.format ?? 'both',
        ...(input.budget ? { budget: input.budget } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }) }
      catch (error) { if (error && typeof error === 'object' && 'code' in error) throw error; translate(error, 'APP_UNAVAILABLE') }
      this.authorize(input.documentId)
      if (historyExpiresAt(record.receipt.committedAt) <= this.source.now()) fail('VERSION_EXPIRED')
      const result = { documentId: input.documentId, versions: [version], retainedContent, retainedMetadata: metadataEvidence(page), retention, nextCursor: retainedContent.nextCursor, truncated: retainedContent.truncated }
      if (byteLength({ ok: true, result }) > LIMITS.responseBytes) fail('LIMIT_EXCEEDED')
      return result
    }
    const { cursor: _cursor, ...args } = input
    const binding = canonicalDocumentValue({ context: this.context, args }), snapshot = canonicalDocumentValue(versions)
    let offset = 0
    if (input.cursor) {
      const cursor = this.cursors.get(input.cursor)
      if (!cursor || cursor.binding !== binding || cursor.snapshot !== snapshot || cursor.expiresAt <= this.source.now()) fail('STALE_CURSOR')
      offset = cursor.offset
    }
    const selected = versions.slice(offset, offset + limit), truncated = offset + selected.length < versions.length
    this.authorize(input.documentId)
    return { documentId: input.documentId, versions: selected, retainedContent: null, retainedMetadata: null, retention,
      nextCursor: truncated ? this.continuation(binding, snapshot, offset + selected.length) : null, truncated }
  }

  async undoDocumentEdit(input: UndoDocumentInput, result: (receipt: DocumentOperationRecord['receipt'], replayed: boolean) => Promise<ReturnType<typeof savedEditResult>>) {
    fields(input, ['documentId', 'operationId', 'undoOperationId', 'expectedRevision', 'mode'], ['documentId', 'operationId', 'undoOperationId', 'expectedRevision'])
    if (!id(input.documentId) || !token(input.operationId) || !token(input.undoOperationId) || !/^r1:[a-f0-9]{64,128}$/i.test(input.expectedRevision)
      || (input.mode !== undefined && !['preview', 'apply'].includes(input.mode))) fail('INVALID_ARGUMENT')
    input = cloneDocumentValue(input)
    const checkAccess = () => this.authorize(input.documentId, true)
    checkAccess()
    const request = { scopeId: this.context.grantId, operationId: input.operationId, kind: 'edit' as const, documentId: input.documentId,
      expectedRevision: input.expectedRevision, payload: { tool: 'undo_document_edit', undoOperationId: input.undoOperationId } }
    let prior
    if (input.mode !== 'preview') {
      try { prior = await this.source.lookup(request) } catch (error) { translate(error, 'APP_UNAVAILABLE') }
      checkAccess()
      if (prior) return result(prior, true)
    }
    if (!(await this.summaries(input.documentId)).some(row => row.operationId === input.undoOperationId)) fail('VERSION_EXPIRED')
    const record = await this.record(input.documentId, input.undoOperationId)
    let pages: Page[]
    try { pages = await this.source.load() } catch (error) { translate(error, 'APP_UNAVAILABLE') }
    checkAccess()
    const before = pages.find(page => page.id === input.documentId)
    if (!before) fail('NOT_FOUND')
    if (input.expectedRevision !== record.receipt.revision || await documentRevision(before, this.digest) !== input.expectedRevision) fail('REVISION_CONFLICT')
    // Undo creation as a tombstone. New children must never be orphaned, including races at storage admission.
    const after = record.before ? cloneDocumentValue(record.before) : { ...cloneDocumentValue(before), deletedAt: Math.max(1, this.source.now()) }
    const destinations = new Set<string>(), restoredBlocks: string[] = []
    const changedBody = canonicalDocumentValue(before.content) !== canonicalDocumentValue(after.content)
    const pending = [after.content]
    let visited = 0
    while (pending.length) {
      const node = pending.pop()
      if (!node || typeof node !== 'object') continue
      if (++visited > LIMITS.maxNodes * 64) fail('LIMIT_EXCEEDED')
      if (changedBody && isBlockId(node.attrs?.blockId)) restoredBlocks.push(node.attrs.blockId)
      if (node.type === 'pageLink' && typeof node.attrs?.id === 'string') destinations.add(node.attrs.id)
      if (Array.isArray(node.content)) {
        if (pending.length + node.content.length > LIMITS.maxNodes * 64) fail('LIMIT_EXCEEDED')
        for (const child of node.content) pending.push(child)
      }
    }
    if (restoredBlocks.length > LIMITS.maxNodes) fail('LIMIT_EXCEEDED')
    const check = () => {
      checkAccess()
      if (historyExpiresAt(record.receipt.committedAt) <= this.source.now()) fail('VERSION_EXPIRED')
      if ([...destinations].some(id => !this.grant.canRead(id)) || (after.parentId !== null && !this.grant.canRead(after.parentId))) fail('ACCESS_DENIED')
    }
    check()
    if (!record.before && pages.some(page => page.parentId === before.id && page.deletedAt === null)) fail('REVISION_CONFLICT')
    if (input.mode === 'preview') return { mode: 'preview' as const, documentId: before.id, baseRevision: input.expectedRevision,
      undoOperationId: input.undoOperationId, restoresRevision: record.receipt.beforeRevision, deletesCreatedDocument: record.before === null, persisted: false as const }
    let committed
    try { committed = await this.source.commit(request, before, after, check,
      (page, receipt) => savedEditEvidence(page, receipt, restoredBlocks, undefined, metadataEvidence(page)), undefined, !record.before) }
    catch (error) {
      if (/revision conflict|commit in progress/i.test(error instanceof Error ? error.message : String(error))) {
        try { prior = await this.source.lookup(request) } catch (lookupError) { translate(lookupError, 'APP_UNAVAILABLE') }
        checkAccess()
        if (prior) return result(prior, true)
      }
      translate(error, 'PERSISTENCE_FAILED')
    }
    checkAccess()
    return result(committed.receipt, committed.replayed)
  }
}
