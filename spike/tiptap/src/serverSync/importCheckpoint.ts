import { canonicalDocumentValue } from '../documents/revision.ts'
import { initializationKey } from './initializationStore.ts'
import { validateManifest } from './api.ts'
import type { ImportManifest } from './api.ts'

export interface ImportScope {
  vaultId: string
  accountId: string
  apiOrigin: string
  collaborationOrigin: string
}
export interface ImportCheckpoint {
  format: 1
  scope: ImportScope
  backupSha256: string
  sourceSha256: string
  manifest: ImportManifest
  state: 'prepared' | 'started' | 'complete'
  importId: string | null
}

function scopeKey(scope: ImportScope): string {
  // Reuse the initialization scope's validation and canonical origin rules.
  const collaboration = initializationKey({ ...scope, documentId: 'checkpoint' })
  const api = new URL(scope.apiOrigin)
  const local = api.hostname === 'localhost' || api.hostname === '127.0.0.1' || api.hostname === '[::1]'
  if (api.username || api.password || api.pathname !== '/' || api.search || api.hash || !(api.protocol === 'https:' || (api.protocol === 'http:' && local)))
    throw new Error('Invalid server origin')
  return `server-sync/import/${JSON.stringify([collaboration, api.origin])}`
}
function normalizedScope(scope: ImportScope): ImportScope {
  scopeKey(scope)
  return { vaultId: scope.vaultId, accountId: scope.accountId, apiOrigin: new URL(scope.apiOrigin).origin, collaborationOrigin: new URL(scope.collaborationOrigin).origin }
}
function validId(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value) }
function validateRecord(value: unknown, expectedScope: ImportScope): ImportCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid import checkpoint')
  const record = value as ImportCheckpoint
  if (record.format !== 1 || !record.scope || scopeKey(record.scope) !== scopeKey(expectedScope) ||
      !/^[a-f0-9]{64}$/.test(record.backupSha256) || !/^[a-f0-9]{64}$/.test(record.sourceSha256) || !['prepared', 'started', 'complete'].includes(record.state) ||
      (record.state === 'prepared' ? record.importId !== null : typeof record.importId !== 'string' || !validId(record.importId)))
    throw new Error('Invalid import checkpoint')
  validateManifest(record.manifest)
  return structuredClone(record)
}
const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error ?? new Error('Import checkpoint transaction aborted'))
  tx.onerror = () => reject(tx.error ?? new Error('Import checkpoint transaction failed'))
})

/** Device-local journal. It stores no credential or expiring signed URL. */
export class IndexedDbImportCheckpointStore {
  private databaseName: string | null = null
  private readonly vaultId: string
  private readonly open: () => Promise<IDBDatabase>
  private readonly active: () => boolean
  constructor(vaultId: string, open: () => Promise<IDBDatabase>, active: () => boolean = () => true) {
    if (!vaultId) throw new Error('A fixed vault is required')
    this.vaultId = vaultId; this.open = open; this.active = active
  }
  private async database(scope: ImportScope): Promise<IDBDatabase> {
    if (scope.vaultId !== this.vaultId || !this.active()) throw new Error('Import vault unavailable')
    const db = await this.open()
    if (!this.active() || (this.databaseName !== null && this.databaseName !== db.name)) throw new Error('Import vault unavailable')
    this.databaseName = db.name
    return db
  }
  async load(input: ImportScope): Promise<ImportCheckpoint | null> {
    const scope = normalizedScope(input), key = scopeKey(scope), db = await this.database(scope)
    const tx = db.transaction('kv', 'readonly'), committed = complete(tx)
    const request = tx.objectStore('kv').get(key)
    const value = await new Promise<unknown>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      .catch(async error => { await committed.catch(() => {}); throw error })
    await committed
    if (!this.active()) throw new Error('Import vault unavailable')
    return value === undefined ? null : validateRecord(value, scope)
  }
  /** Repeated preparation must match the exact persisted manifest and backup. */
  async prepare(input: ImportScope, backupSha256: string, sourceSha256: string, inputManifest: ImportManifest): Promise<ImportCheckpoint> {
    const scope = normalizedScope(input), manifest = validateManifest(inputManifest), key = scopeKey(scope)
    if (!/^[a-f0-9]{64}$/.test(backupSha256) || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Invalid backup or source fingerprint')
    const candidate: ImportCheckpoint = { format: 1, scope, backupSha256, sourceSha256, manifest, state: 'prepared', importId: null }
    return this.change(scope, key, current => {
      if (!current) return candidate
      if (canonicalDocumentValue({ scope: current.scope, backupSha256: current.backupSha256, sourceSha256: current.sourceSha256, manifest: current.manifest }) !==
          canonicalDocumentValue({ scope, backupSha256, sourceSha256, manifest })) throw new Error('Import checkpoint mismatch')
      return current
    })
  }
  async started(input: ImportScope, importId: string): Promise<ImportCheckpoint> {
    const scope = normalizedScope(input), key = scopeKey(scope)
    if (!validId(importId)) throw new Error('Invalid import ID')
    return this.change(scope, key, current => {
      if (!current) throw new Error('Import checkpoint missing')
      if (current.importId && current.importId !== importId) throw new Error('Import ID mismatch')
      return current.state === 'prepared' ? { ...current, state: 'started', importId } : current
    })
  }
  async completed(input: ImportScope, importId: string): Promise<ImportCheckpoint> {
    const scope = normalizedScope(input), key = scopeKey(scope)
    if (!validId(importId)) throw new Error('Invalid import ID')
    return this.change(scope, key, current => {
      if (!current || current.state === 'prepared' || current.importId !== importId) throw new Error('Import ID mismatch')
      return { ...current, state: 'complete' }
    })
  }
  private async change(scope: ImportScope, key: string, update: (record: ImportCheckpoint | null) => ImportCheckpoint): Promise<ImportCheckpoint> {
    const db = await this.database(scope), tx = db.transaction('kv', 'readwrite', { durability: 'strict' }), committed = complete(tx)
    const store = tx.objectStore('kv'), request = store.get(key)
    let output: ImportCheckpoint | undefined, failure: unknown
    request.onsuccess = () => {
      try {
        if (!this.active()) throw new Error('Import vault unavailable')
        const current = request.result === undefined ? null : validateRecord(request.result, scope)
        output = validateRecord(update(current), scope)
        store.put(output, key)
      } catch (error) { failure = error; tx.abort() }
    }
    try { await committed } catch (error) { throw failure ?? error }
    if (!this.active() || !output) throw new Error('Import vault unavailable')
    return structuredClone(output)
  }
}
