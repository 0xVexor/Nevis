import type { Page } from './model.ts'

export interface DocumentVersion {
  pageId: string
  ts: number
  title: string
  content: any
}

/** Compatibility versions for today's persistence, NOT the strong MCP revision. */
export interface StoredDocumentVersion {
  updatedAt: number
  recordRevision: number | null
}
export const storedVersion = (page: Page): StoredDocumentVersion => ({
  updatedAt: page.updatedAt, recordRevision: page.recordMeta?.revision ?? null,
})
export interface DocumentWrite {
  upserts: Page[]
  removed: string[]
  replaceAll: boolean
  baseVersions: Record<string, StoredDocumentVersion | null>
}

/** One adapter instance is permanently bound to one host-owned vault handle.
 * Saves resolve after durable completion or reject; a frozen/skipped write must
 * never acknowledge success. Strong compare-and-commit is a later capability. */
export interface DocumentStorage {
  readonly vaultHandle: string
  readonly revisionPolicy: 'timestamp-history' | 'unconditional'
  load(): Promise<Page[]>
  save(write: DocumentWrite): Promise<void>
  listVersions(pageId: string): Promise<DocumentVersion[]>
  addVersion(version: DocumentVersion): Promise<void>
  deleteVersions(pageId: string): Promise<void>
  stamp?(): Promise<string>
}

export interface DocumentHost {
  now(): number
  createId(): string
  /** Defer asynchronously until after the current call stack; return cancellation. */
  defer(task: () => void): () => void
  emit(event: 'data-changed' | 'external-change' | 'storage-error', detail?: string[] | string): void
  report(context: 'storage' | 'history' | 'watch', error: unknown): void
  readLegacy?(): Page[] | null
  clearLegacy?(): void
  requestPersistence?(): void
  watchExternal?(changed: () => void): Promise<() => void>
}
export interface DocumentEnvironment {
  storage: DocumentStorage
  host: DocumentHost
}
