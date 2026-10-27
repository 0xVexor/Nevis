import type { Page } from './model.ts'
import { cloneDocumentValue } from './clone.ts'
import type { DocumentStorage, DocumentVersion, DocumentWrite } from './ports.ts'

/** Reference adapter for shared-service conformance tests. */
export class MemoryDocumentStorage implements DocumentStorage {
  readonly revisionPolicy = 'unconditional' as const
  private pages = new Map<string, Page>()
  private versions = new Map<string, DocumentVersion[]>()
  private generation = 0
  readonly vaultHandle: string
  constructor(vaultHandle: string, pages: Page[] = []) {
    this.vaultHandle = vaultHandle
    if (!vaultHandle) throw new Error('A fixed document vault handle is required')
    pages.forEach(page => this.pages.set(page.id, cloneDocumentValue(page)))
  }
  async load() { return cloneDocumentValue([...this.pages.values()]) }
  async save(write: DocumentWrite) {
    const copy = cloneDocumentValue(write)
    const pages = new Map(copy.replaceAll ? [] : this.pages)
    copy.upserts.forEach(page => pages.set(page.id, page))
    copy.removed.forEach(id => pages.delete(id))
    this.pages = pages
    this.generation++
  }
  async stamp() { return String(this.generation) }
  async listVersions(pageId: string) { return cloneDocumentValue(this.versions.get(pageId) ?? []) }
  async addVersion(version: DocumentVersion) {
    const versions = (this.versions.get(version.pageId) ?? []).filter(old => old.ts !== version.ts)
    versions.push(cloneDocumentValue(version))
    this.versions.set(version.pageId, versions.sort((a, b) => b.ts - a.ts).slice(0, 40))
  }
  async deleteVersions(pageId: string) { this.versions.delete(pageId) }
}
