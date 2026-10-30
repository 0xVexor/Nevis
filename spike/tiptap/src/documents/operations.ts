import { decodeDocumentAsset } from './assets.ts'
import type { DocumentAsset } from './assets.ts'
import type { Page } from './model.ts'
import { canonicalDocumentValue } from './revision.ts'
import type { SavedEditEvidence } from './savedEdit.ts'
import type { DocumentVersion } from './ports.ts'
import type { CreationPosition } from './hierarchy.ts'

/** Host-owned scope (principal/grant), never an agent-supplied authorization. */
export interface DocumentOperationRequest {
  scopeId: string
  operationId: string
  kind: 'create' | 'edit'
  documentId: string | null
  expectedRevision: string | null
  payload: unknown
}
export interface DocumentOperationReceipt {
  operationId: string
  documentId: string
  beforeRevision: string | null
  revision: string
  committedAt: number
  /** Original bounded saved-content proof, coupled to the same durable operation. */
  evidence?: SavedEditEvidence
}
export interface DocumentOperationRecord {
  format: 1
  assets?: DocumentAsset[]
  scopeId: string
  operationId: string
  fingerprint: string
  before: Page | null
  after: Page
  receipt: DocumentOperationReceipt
  history?: DocumentVersion
  creation?: CreationPosition
  requireNoChildren?: true
  undoOf?: string
}
export interface DocumentOperationCommitResult { receipt: DocumentOperationReceipt; replayed: boolean }
export const operationKey = (scopeId: string, operationId: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scopeId) || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('Invalid document operation identity')
  return `${scopeId}/${operationId}`
}
export async function operationFingerprint(request: DocumentOperationRequest, digest: (value: string) => Promise<string>) {
  operationKey(request.scopeId, request.operationId)
  if (!['create', 'edit'].includes(request.kind) || (request.kind === 'create'
    ? request.documentId !== null || request.expectedRevision !== null
    : !request.documentId || !request.expectedRevision)) throw new Error('Invalid document operation request')
  const canonical = canonicalDocumentValue(request)
  if (canonical.length > 262144) throw new Error('Document operation request is too large')
  const hash = await digest(canonical)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid document operation digest')
  return `o1:${hash}`
}
export function matchOperation(record: DocumentOperationRecord | null, fingerprint: string) {
  if (record && record.fingerprint !== fingerprint) throw new Error('Document operation ID reused with different payload')
  return record
}
/** Defend adapters too: malformed internal inputs must never produce split identities. */
export function validateOperationRecord(record: DocumentOperationRecord) {
  operationKey(record.scopeId, record.operationId)
  if (record.assets !== undefined) {
    if (!Array.isArray(record.assets) || !record.assets.length || record.assets.length > 20 || new Set(record.assets.map(asset => asset.id)).size !== record.assets.length) throw new Error('Invalid document assets')
    let bytes = 0
    for (const asset of record.assets) {
      if (!asset || Object.keys(asset).sort().join(',') !== 'data,id,mimeType,name' || !/^[a-f0-9]{64}$/.test(asset.id) || (bytes += decodeDocumentAsset(asset).length) > 196608) throw new Error('Invalid document assets')
    }
  }
  if (record.format !== 1 || !/^[A-Za-z0-9_-]{1,80}$/.test(record.after?.id)
    || (record.before !== null && record.before?.id !== record.after.id)
    || record.receipt?.documentId !== record.after.id || record.receipt?.operationId !== record.operationId
    || !Number.isSafeInteger(record.receipt.committedAt) || record.receipt.committedAt < 0 || !/^o1:[a-f0-9]{64}$/.test(record.fingerprint)
    || !/^r1:[a-f0-9]{64,128}$/i.test(record.receipt.revision)
    || (record.before === null ? record.receipt.beforeRevision !== null : !/^r1:[a-f0-9]{64,128}$/i.test(record.receipt.beforeRevision ?? ''))) throw new Error('Invalid document operation record')
  if (record.history && (!record.before || record.history.pageId !== record.before.id || !Number.isSafeInteger(record.history.ts)
    || record.history.title !== record.before.title || canonicalDocumentValue(record.history.content) !== canonicalDocumentValue(record.before.content))) throw new Error('Invalid document operation history')
  if (record.undoOf !== undefined) { operationKey(record.scopeId, record.undoOf); if (!record.before) throw new Error('Invalid undo origin') }
  if (record.requireNoChildren !== undefined && (record.requireNoChildren !== true || !record.before || !Number.isSafeInteger(record.after.deletedAt))) throw new Error('Invalid undo precondition')
  if (record.creation && (record.before !== null || record.after.parentId !== record.creation.parentId)) throw new Error('Invalid document creation precondition')
}

/** Snapshot visibility is bounded; original retry receipts are retained independently. */
export const DOCUMENT_HISTORY_LIMIT = 40
export const DOCUMENT_HISTORY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
export const historyExpiresAt = (committedAt: number) => Math.min(Number.MAX_SAFE_INTEGER, committedAt + DOCUMENT_HISTORY_LIFETIME_MS)
export type DocumentOperationSummary = Pick<DocumentOperationReceipt, 'operationId' | 'documentId' | 'beforeRevision' | 'revision' | 'committedAt'>
export const operationSummary = (record: DocumentOperationRecord): DocumentOperationSummary => {
  validateOperationRecord(record)
  const { operationId, documentId, beforeRevision, revision, committedAt } = record.receipt
  return { operationId, documentId, beforeRevision, revision, committedAt }
}
export const retainOperationSummaries = (rows: DocumentOperationSummary[]) => rows.sort((a, b) =>
  b.committedAt - a.committedAt || (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0)).slice(0, DOCUMENT_HISTORY_LIMIT)
