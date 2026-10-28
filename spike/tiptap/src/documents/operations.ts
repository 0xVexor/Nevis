import type { Page } from './model.ts'
import { canonicalDocumentValue } from './revision.ts'

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
}
export interface DocumentOperationRecord {
  format: 1
  scopeId: string
  operationId: string
  fingerprint: string
  before: Page | null
  after: Page
  receipt: DocumentOperationReceipt
}
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
  if (record.format !== 1 || !/^[A-Za-z0-9_-]{1,80}$/.test(record.after?.id)
    || (record.before !== null && record.before?.id !== record.after.id)
    || record.receipt?.documentId !== record.after.id || record.receipt?.operationId !== record.operationId
    || !Number.isFinite(record.receipt.committedAt) || !/^o1:[a-f0-9]{64}$/.test(record.fingerprint)
    || !/^r1:[a-f0-9]{64,128}$/i.test(record.receipt.revision)
    || (record.before === null ? record.receipt.beforeRevision !== null : !/^r1:[a-f0-9]{64,128}$/i.test(record.receipt.beforeRevision ?? ''))) throw new Error('Invalid document operation record')
}
