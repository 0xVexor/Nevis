import { verifyDocumentAssets } from './assets.ts'
import type { AssetDigest } from './assets.ts'
import type { DocumentAdmission } from './admission.ts'
import type { Page } from './model.ts'
import { cloneDocumentValue } from './clone.ts'
import type { DocumentStorage, DocumentVersion, DocumentWrite } from './ports.ts'
import { canonicalDocumentValue } from './revision.ts'
import { matchOperation, operationKey, validateOperationRecord, operationSummary, retainOperationSummaries } from './operations.ts'
import type { DocumentOperationRecord } from './operations.ts'
import { assertCreationPosition } from './hierarchy.ts'

/** Reference adapter for shared-service conformance tests. */
export class MemoryDocumentStorage implements DocumentStorage {
  readonly revisionPolicy = 'exact-page' as const
  private assets = new Map<string, { bytes: Uint8Array; mimeType: string; name: string }>()
  private readonly digestBytes?: AssetDigest
  private pages = new Map<string, Page>()
  private versions = new Map<string, DocumentVersion[]>()
  private generation = 0
  private operations = new Map<string, DocumentOperationRecord>()
  readonly vaultHandle: string
  constructor(vaultHandle: string, pages: Page[] = [], digestBytes?: AssetDigest) {
    this.digestBytes = digestBytes
    this.vaultHandle = vaultHandle
    if (!vaultHandle) throw new Error('A fixed document vault handle is required')
    pages.forEach(page => this.pages.set(page.id, cloneDocumentValue(page)))
  }
  async readAsset(id: string) { const asset = this.assets.get(id); return asset ? { ...asset, bytes: new Uint8Array(asset.bytes) } : null }
  async load() { return cloneDocumentValue([...this.pages.values()]) }
  async save(write: DocumentWrite) {
    const copy = cloneDocumentValue(write)
    if (copy.expectedAll) {
      const ordered = (pages: Page[]) => [...pages].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      if (canonicalDocumentValue(ordered([...this.pages.values()])) !== canonicalDocumentValue(ordered(copy.expectedAll))) throw new Error('Document revision conflict')
    } else if (copy.expectedPages) {
      for (const id of new Set([...copy.upserts.map(page => page.id), ...copy.removed])) {
        if (!Object.hasOwn(copy.expectedPages, id)) throw new Error('Missing document precondition')
        if (canonicalDocumentValue(this.pages.get(id) ?? null) !== canonicalDocumentValue(copy.expectedPages[id])) throw new Error('Document revision conflict')
      }
    }
    const pages = new Map(copy.replaceAll ? [] : this.pages)
    copy.upserts.forEach(page => pages.set(page.id, page))
    copy.removed.forEach(id => pages.delete(id))
    this.pages = pages
    this.generation++
  }
  async stamp() { return String(this.generation) }
  async listOperations(scopeId: string, documentId: string) {
    operationKey(scopeId, 'history')
    return retainOperationSummaries([...this.operations.values()].filter(row => row.scopeId === scopeId && row.after.id === documentId).map(operationSummary))
  }
  async findOperation(scopeId: string, operationId: string) {
    return cloneDocumentValue(this.operations.get(operationKey(scopeId, operationId)) ?? null)
  }
  async commitOperation(input: DocumentOperationRecord) {
    return (await this.commitOperationResult(input)).receipt
  }
  async commitOperationResult(input: DocumentOperationRecord, admission?: DocumentAdmission) {
    const record = cloneDocumentValue(input), key = operationKey(record.scopeId, record.operationId)
    validateOperationRecord(record)
    const assets = record.assets ? await verifyDocumentAssets(record.assets, this.digestBytes) : []
    const prior = matchOperation(this.operations.get(key) ?? null, record.fingerprint)
    if (prior) return { receipt: cloneDocumentValue(prior.receipt), replayed: true }
    if (canonicalDocumentValue(this.pages.get(record.after.id) ?? null) !== canonicalDocumentValue(record.before)) throw new Error('Document revision conflict')
    if (record.requireNoChildren && [...this.pages.values()].some(page => page.parentId === record.after.id && page.deletedAt === null)) throw new Error('Document revision conflict')
    if (record.creation) assertCreationPosition([...this.pages.values()], record.after, record.creation)
    admission?.check([...this.pages.values()], record, record.undoOf ? this.operations.get(operationKey(record.scopeId, record.undoOf)) : null)
    for (const asset of assets) this.assets.set(asset.id, { bytes: new Uint8Array(asset.bytes), mimeType: asset.mimeType, name: asset.name })
    if (record.history) {
      const history = this.versions.get(record.history.pageId) ?? []
      record.history.ts = Math.max(record.history.ts, ...history.map(v => v.ts + 1))
      if (!Number.isSafeInteger(record.history.ts)) throw new Error('Invalid operation history clock')
      this.versions.set(record.history.pageId, [...history, cloneDocumentValue(record.history)].sort((a, b) => b.ts - a.ts).slice(0, 40))
    }
    this.pages.set(record.after.id, record.after)
    this.operations.set(key, record)
    this.generation++
    return { receipt: cloneDocumentValue(record.receipt), replayed: false }
  }
  async listVersions(pageId: string) { return cloneDocumentValue(this.versions.get(pageId) ?? []) }
  async addVersion(version: DocumentVersion) {
    version = cloneDocumentValue(version)
    const versions = [...(this.versions.get(version.pageId) ?? [])]
    while (versions.some(old => old.ts === version.ts)) {
      if (versions.some(old => canonicalDocumentValue(old) === canonicalDocumentValue(version))) return
      version.ts++
      if (!Number.isSafeInteger(version.ts)) throw new Error('Invalid operation history clock')
    }
    versions.push(version)
    this.versions.set(version.pageId, versions.sort((a, b) => b.ts - a.ts).slice(0, 40))
  }
  async deleteVersions(pageId: string) { this.versions.delete(pageId) }
}
