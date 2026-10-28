import type { DocumentAdmission } from '../../documents/admission.ts'
import type { Page } from '../../documents/model.ts'
import type { DocumentStorage, DocumentVersion, DocumentWrite } from '../../documents/ports.ts'
import { cloneDocumentValue } from '../../documents/clone.ts'
import { canonicalDocumentValue } from '../../documents/revision.ts'
import { matchOperation, operationKey, validateOperationRecord, operationSummary, retainOperationSummaries } from '../../documents/operations.ts'
import type { DocumentOperationRecord, DocumentOperationSummary } from '../../documents/operations.ts'
import { assertCreationPosition } from '../../documents/hierarchy.ts'

const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error ?? new Error('Document transaction aborted'))
  tx.onerror = () => reject(tx.error ?? new Error('Document transaction failed'))
})
const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

/** Uses existing pages/versions stores. No Tauri, window, singleton or native imports. */
export class IndexedDbDocumentStorage implements DocumentStorage {
  readonly revisionPolicy = 'exact-page' as const
  private databaseName: string | null = null
  readonly vaultHandle: string
  private readonly open: () => Promise<IDBDatabase>
  private readonly active: () => boolean
  private readonly changed: () => void
  constructor(
    vaultHandle: string,
    open: () => Promise<IDBDatabase>,
    active: () => boolean = () => true,
    changed: () => void = () => {},
  ) {
    this.vaultHandle = vaultHandle
    this.open = open
    this.active = active
    this.changed = changed
    if (!vaultHandle) throw new Error('A fixed document vault handle is required')
  }
  private async database() {
    if (!this.active()) throw new Error('Document storage is unavailable')
    const db = await this.open()
    if (!this.active()) throw new Error('Document storage is unavailable')
    if (this.databaseName !== null && db.name !== this.databaseName) throw new Error('Document vault changed')
    this.databaseName = db.name
    return db
  }
  async load(): Promise<Page[]> {
    const tx = (await this.database()).transaction('pages')
    return result(tx.objectStore('pages').getAll())
  }
  async listOperations(scopeId: string, documentId: string): Promise<DocumentOperationSummary[]> {
    operationKey(scopeId, 'history')
    const prefix = `document-operation/${scopeId}/`
    const tx = (await this.database()).transaction('kv')
    const committed = complete(tx)
    let rows: DocumentOperationSummary[] = [], failure: unknown
    const request = tx.objectStore('kv').openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      try {
        const record = cursor.value as DocumentOperationRecord
        if (record.scopeId === scopeId && record.after.id === documentId) rows = retainOperationSummaries([...rows, operationSummary(record)])
        cursor.continue()
      } catch (error) { failure = error; tx.abort() }
    }
    try { await committed } catch (error) { throw failure ?? error }
    if (!this.active()) throw new Error('Document storage is unavailable')
    return rows
  }
  async findOperation(scopeId: string, operationId: string): Promise<DocumentOperationRecord | null> {
    const key = `document-operation/${operationKey(scopeId, operationId)}`
    const tx = (await this.database()).transaction('kv')
    const record = (await result(tx.objectStore('kv').get(key))) ?? null
    if (!this.active()) throw new Error('Document storage is unavailable')
    return record
  }
  async commitOperation(input: DocumentOperationRecord) {
    return (await this.commitOperationResult(input)).receipt
  }
  async commitOperationResult(input: DocumentOperationRecord, admission?: DocumentAdmission) {
    const record = cloneDocumentValue(input)
    validateOperationRecord(record)
    const key = `document-operation/${operationKey(record.scopeId, record.operationId)}`
    // The private kv entry is never included in page backups or database exports.
    const tx = (await this.database()).transaction(['pages', 'kv', ...(record.history ? ['versions'] : [])], 'readwrite', { durability: 'strict' })
    const committed = complete(tx)
    let receipt = record.receipt
    let replayed = false
    try {
      const kv = tx.objectStore('kv'), pages = tx.objectStore('pages')
      const prior = matchOperation((await result(kv.get(key))) ?? null, record.fingerprint)
      if (prior) { receipt = prior.receipt; replayed = true }
      else {
        const current = (await result(pages.get(record.after.id))) ?? null
        if (canonicalDocumentValue(current) !== canonicalDocumentValue(record.before)) throw new Error('Document revision conflict')
        if (record.requireNoChildren && (await result(pages.getAll()) as Page[]).some(page => page.parentId === record.after.id && page.deletedAt === null)) throw new Error('Document revision conflict')
        if (record.creation) assertCreationPosition(await result(pages.getAll()), record.after, record.creation)
        if (!this.active()) throw new Error('Document storage is unavailable')
        if (record.history) {
          const versions = tx.objectStore('versions')
          const previous: DocumentVersion[] = await result(versions.index('byPage').getAll(record.history.pageId))
          record.history.ts = Math.max(record.history.ts, ...previous.map(v => v.ts + 1))
          if (!Number.isSafeInteger(record.history.ts)) throw new Error('Invalid operation history clock')
          versions.put(record.history)
          previous.sort((a, b) => b.ts - a.ts).slice(39).forEach(v => versions.delete([v.pageId, v.ts]))
          if (!this.active()) throw new Error('Document storage is unavailable')
        }
        if (admission) {
          const snapshot = await result(pages.getAll()) as Page[]
          admission.check(snapshot, record)
          if (!this.active()) throw new Error('Document storage is unavailable')
        }
        pages.put(record.after)
        kv.put(record, key)
      }
    } catch (error) {
      tx.abort()
      await committed.catch(() => {})
      throw error
    }
    await committed
    if (!this.active()) throw new Error('Document storage is unavailable')
    try { this.changed() } catch { /* advisory notification */ }
    return { receipt: cloneDocumentValue(receipt), replayed }
  }
  async save(input: DocumentWrite): Promise<void> {
    const write = cloneDocumentValue(input)
    const tx = (await this.database()).transaction('pages', 'readwrite')
    const committed = complete(tx)
    try {
      const store = tx.objectStore('pages')
      if (write.expectedAll) {
        const actual = await result(store.getAll()) as Page[]
        const ordered = (pages: Page[]) => [...pages].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        if (canonicalDocumentValue(ordered(actual)) !== canonicalDocumentValue(ordered(write.expectedAll))) throw new Error('Document revision conflict')
      } else if (write.expectedPages) {
        for (const id of new Set([...write.upserts.map(page => page.id), ...write.removed])) {
          if (!Object.hasOwn(write.expectedPages, id)) throw new Error('Missing document precondition')
          const current = await result(store.get(id)) as Page | undefined
          const expected = write.expectedPages[id]
          if (canonicalDocumentValue(current ?? null) !== canonicalDocumentValue(expected)) throw new Error('Document revision conflict')
        }
      }
      if (!this.active()) throw new Error('Document storage is unavailable')
      if (write.replaceAll) store.clear()
      write.upserts.forEach(page => store.put(page))
      write.removed.forEach(id => store.delete(id))
    } catch (error) {
      tx.abort()
      await committed.catch(() => {})
      throw error
    }
    await committed
    try { this.changed() } catch { /* notification failure does not undo storage */ }
  }
  /** Compare and write in the same IndexedDB transaction shared with ordinary page saves. */
  async compareAndSave(expected: Page, next: Page): Promise<void> {
    if (expected.id !== next.id) throw new Error('Document identity changed')
    await this.save({ upserts: [next], removed: [], replaceAll: false, baseVersions: {}, expectedPages: { [expected.id]: expected } })
  }

  async listVersions(pageId: string): Promise<DocumentVersion[]> {
    const tx = (await this.database()).transaction('versions')
    const versions: DocumentVersion[] = await result(tx.objectStore('versions').index('byPage').getAll(pageId))
    return versions.sort((a, b) => b.ts - a.ts)
  }
  async addVersion(version: DocumentVersion): Promise<void> {
    version = cloneDocumentValue(version)
    const tx = (await this.database()).transaction('versions', 'readwrite')
    const committed = complete(tx)
    try {
      const store = tx.objectStore('versions')
      const versions: DocumentVersion[] = await result(store.index('byPage').getAll(version.pageId))
      while (versions.some(old => old.ts === version.ts)) {
        if (versions.some(old => canonicalDocumentValue(old) === canonicalDocumentValue(version))) { await committed; return }
        version.ts++
        if (!Number.isSafeInteger(version.ts)) throw new Error('Invalid operation history clock')
      }
      store.put(version)
      versions.push(version)
      versions.sort((a, b) => b.ts - a.ts).slice(40).forEach(old => store.delete([old.pageId, old.ts]))
      await committed
    } catch (error) {
      try { tx.abort() } catch { /* an IndexedDB request may already have aborted */ }
      await committed.catch(() => {})
      throw error
    }
  }
  async deleteVersions(pageId: string): Promise<void> {
    const tx = (await this.database()).transaction('versions', 'readwrite')
    const committed = complete(tx)
    try {
      const store = tx.objectStore('versions')
      const keys = await result(store.index('byPage').getAllKeys(pageId))
      keys.forEach(key => store.delete(key))
      await committed
    } catch (error) {
      try { tx.abort() } catch { /* already aborted */ }
      await committed.catch(() => {})
      throw error
    }
  }
}
