import { cloneDocumentValue } from '../../documents/clone.ts'
import type { Page } from '../../documents/model.ts'
import type { DocumentStorage, DocumentVersion, DocumentWrite } from '../../documents/ports.ts'

/** The app injects its existing bridge; this adapter itself imports no Tauri API. */
export interface NativeDocumentBridge {
  currentVaultId(): Promise<string>
  active(): boolean
  load(): Promise<Page[]>
  save(upserts: (Page & { _base?: number | null })[], removed: string[], replaceAll: boolean, preconditions?: { expectedVaultId: string; expectedPages?: DocumentWrite['expectedPages']; expectedAll?: Page[] }): Promise<void>
  stamp(): Promise<string>
  listVersions(pageId: string): Promise<DocumentVersion[]>
  addVersion(version: DocumentVersion): Promise<void>
  deleteVersions(pageId: string): Promise<void>
}
export class NativeDocumentStorage implements DocumentStorage {
  readonly revisionPolicy = 'exact-page' as const
  private binding: string | null = null
  readonly vaultHandle: string
  private readonly bridge: NativeDocumentBridge
  constructor(vaultHandle: string, bridge: NativeDocumentBridge) {
    this.vaultHandle = vaultHandle
    this.bridge = bridge
    if (!vaultHandle) throw new Error('A fixed document vault handle is required')
  }
  private async assertBinding() {
    if (!this.bridge.active()) throw new Error('Document storage is unavailable')
    const id = await this.bridge.currentVaultId()
    if (!id || !this.bridge.active()) throw new Error('Document storage is unavailable')
    if (this.binding !== null && this.binding !== id) throw new Error('Document vault changed')
    this.binding = id
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertBinding()
    const value = await operation()
    await this.assertBinding()
    return value
  }
  load() { return this.run(() => this.bridge.load()) }
  save(input: DocumentWrite) {
    const write = cloneDocumentValue(input)
    return this.run(() => this.bridge.save(write.replaceAll ? write.upserts : write.upserts.map(page => ({
      ...page, _base: write.baseVersions[page.id]?.updatedAt ?? null,
    })), write.removed, write.replaceAll, {
      expectedVaultId: this.binding!, expectedPages: write.expectedPages, expectedAll: write.expectedAll,
    }))
  }
  stamp() { return this.run(() => this.bridge.stamp()) }
  listVersions(pageId: string) { return this.run(() => this.bridge.listVersions(pageId)) }
  addVersion(version: DocumentVersion) { return this.run(() => this.bridge.addVersion(version)) }
  deleteVersions(pageId: string) { return this.run(() => this.bridge.deleteVersions(pageId)) }
}
