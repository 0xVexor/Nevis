import type { Page } from './model.ts'
import { cloneDocumentValue } from './clone.ts'
import type { DocumentStorage, DocumentVersion, DocumentWrite } from './ports.ts'
import { canonicalDocumentValue } from './revision.ts'
import { matchOperation, operationKey, validateOperationRecord } from './operations.ts'
import type { DocumentOperationRecord } from './operations.ts'

/** Reference adapter for shared-service conformance tests. */
export class MemoryDocumentStorage implements DocumentStorage {
  readonly revisionPolicy = 'exact-page' as const
  private pages = new Map<string, Page>()
  private versions = new Map<string, DocumentVersion[]>()
  private generation = 0
  private operations = new Map<string, DocumentOperationRecord>()
  readonly vaultHandle: string
  constructor(vaultHandle: string, pages: Page[] = []) {
    this.vaultHandle = vaultHandle
    if (!vaultHandle) throw new Error('A fixed document vault handle is required')
    pages.forEach(page => this.pages.set(page.id, cloneDocumentValue(page)))
  }
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
  async findOperation(scopeId: string, operationId: string) {
    return cloneDocumentValue(this.operations.get(operationKey(scopeId, operationId)) ?? null)
  }
  async commitOperation(input: DocumentOperationRecord) {
    const record = cloneDocumentValue(input), key = operationKey(record.scopeId, record.operationId)
    validateOperationRecord(record)
    const prior = matchOperation(this.operations.get(key) ?? null, record.fingerprint)
    if (prior) return cloneDocumentValue(prior.receipt)
    if (canonicalDocumentValue(this.pages.get(record.after.id) ?? null) !== canonicalDocumentValue(record.before)) throw new Error('Document revision conflict')
    this.pages.set(record.after.id, record.after)
    this.operations.set(key, record)
    this.generation++
    return cloneDocumentValue(record.receipt)
  }
  async listVersions(pageId: string) { return cloneDocumentValue(this.versions.get(pageId) ?? []) }
  async addVersion(version: DocumentVersion) {
    const versions = (this.versions.get(version.pageId) ?? []).filter(old => old.ts !== version.ts)
    versions.push(cloneDocumentValue(version))
    this.versions.set(version.pageId, versions.sort((a, b) => b.ts - a.ts).slice(0, 40))
  }
  async deleteVersions(pageId: string) { this.versions.delete(pageId) }
}
