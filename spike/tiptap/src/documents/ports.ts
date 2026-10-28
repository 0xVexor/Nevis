import type { Page } from './model.ts'
import type { SearchIndexRuntime } from './searchLifecycle.ts'
import type { DocumentOperationRecord, DocumentOperationReceipt, DocumentOperationCommitResult } from './operations.ts'
import type { SyncState } from './savedEdit.ts'

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
  /** Full persisted pre-images checked in the same storage transaction or native commit lock. */
  expectedPages?: Record<string, Page | null>
  expectedAll?: Page[]
}

/** One adapter instance is permanently bound to one host-owned vault handle.
 * Saves resolve after durable completion or reject; a frozen/skipped write must
 * never acknowledge success. Supplied full-page preconditions must be checked in the same transaction or lock as writes. */
export interface DocumentStorage {
  readonly vaultHandle: string
  readonly revisionPolicy: 'exact-page'
  load(): Promise<Page[]>
  save(write: DocumentWrite): Promise<void>
  listVersions(pageId: string): Promise<DocumentVersion[]>
  addVersion(version: DocumentVersion): Promise<void>
  deleteVersions(pageId: string): Promise<void>
  stamp?(): Promise<string>
  /** Local-only snapshots. Commit atomically with the page, or recover before any later writer. */
  findOperation?(scopeId: string, operationId: string): Promise<DocumentOperationRecord | null>
  commitOperation?(record: DocumentOperationRecord): Promise<DocumentOperationReceipt>
  commitOperationResult?(record: DocumentOperationRecord): Promise<DocumentOperationCommitResult>
}

export interface DocumentHost {
  now(): number
  createId(): string
  /** Defer asynchronously until after the current call stack; return cancellation. */
  defer(task: () => void): () => void
  emit(event: 'data-changed' | 'external-change' | 'storage-error' | 'search-state' | 'commit-state', detail?: string[] | string): void
  report(context: 'storage' | 'history' | 'watch' | 'search', error: unknown): void
  readLegacy?(): Page[] | null
  clearLegacy?(): void
  requestPersistence?(): void
  watchExternal?(changed: () => void): Promise<() => void>
  /** Local sync observation only; never infer per-operation remote durability from global idle. */
  syncState?(): Promise<SyncState> | SyncState
}
export interface DocumentEnvironment {
  storage: DocumentStorage
  host: DocumentHost
  search?: SearchIndexRuntime
}
