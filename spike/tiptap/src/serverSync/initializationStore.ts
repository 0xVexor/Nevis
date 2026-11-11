import { canonicalDocumentValue } from '../documents/revision.ts'
import type { Page } from '../documents/model.ts'

/** Immutable initialization bytes. Do not store credentials in this record. */
export interface InitializationScope {
  vaultId: string
  accountId: string
  collaborationOrigin: string
  documentId: string
}

export const initializationKey = (scope: InitializationScope): string => {
  if (!scope.vaultId || scope.vaultId.length > 256 || !scope.accountId || scope.accountId.length > 256) throw new Error('Invalid initialization scope')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope.documentId)) throw new Error('Invalid document ID')
  const origin = new URL(scope.collaborationOrigin)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid collaboration origin')
  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]'
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) throw new Error('Invalid collaboration origin')
  return `server-sync/initialization/${JSON.stringify([scope.vaultId, scope.accountId, origin.origin, scope.documentId])}`
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error ?? new Error('Initialization transaction aborted'))
  tx.onerror = () => reject(tx.error ?? new Error('Initialization transaction failed'))
})

/** Browser journal. The existing kv store is private to the local browser database.
 * A transaction serializes competing preparations for the same scope. */
export class IndexedDbInitializationStore {
  private databaseName: string | null = null
  private readonly vaultId: string
  private readonly open: () => Promise<IDBDatabase>
  private readonly active: () => boolean
  constructor(vaultId: string, open: () => Promise<IDBDatabase>, active: () => boolean = () => true) {
    if (!vaultId) throw new Error('A fixed vault is required')
    this.vaultId = vaultId
    this.open = open
    this.active = active
  }

  private async database(scope: InitializationScope): Promise<IDBDatabase> {
    if (scope.vaultId !== this.vaultId || !this.active()) throw new Error('Initialization vault unavailable')
    const db = await this.open()
    if (!this.active() || (this.databaseName !== null && db.name !== this.databaseName)) throw new Error('Initialization vault unavailable')
    this.databaseName = db.name
    return db
  }

  async load(scope: InitializationScope): Promise<Uint8Array | null> {
    const key = initializationKey(scope)
    const db = await this.database(scope)
    const tx = db.transaction('kv', 'readonly')
    const committed = done(tx)
    const request = tx.objectStore('kv').get(key)
    const record = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch(async error => { await committed.catch(() => {}); throw error })
    await committed
    if (!this.active()) throw new Error('Initialization vault unavailable')
    if (record === undefined) return null
    if (!(record instanceof Uint8Array) || !record.byteLength || record.byteLength > 2 * 1024 * 1024) throw new Error('Invalid saved initialization')
    return new Uint8Array(record)
  }

  async prepare(scope: InitializationScope, update: Uint8Array, expectedPage: Page): Promise<Uint8Array> {
    const key = initializationKey(scope)
    if (!expectedPage || expectedPage.id !== scope.documentId) throw new Error('Invalid initialization page')
    const expected = canonicalDocumentValue(expectedPage)
    const documentId = scope.documentId
    const bytes = new Uint8Array(update)
    if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) throw new Error('Invalid initialization size')
    const db = await this.database(scope)
    const tx = db.transaction(['kv', 'pages'], 'readwrite', { durability: 'strict' })
    const committed = done(tx)
    let failure: unknown
    const store = tx.objectStore('kv')
    const request = store.get(key)
    request.onsuccess = () => {
      const prior: unknown = request.result
      if (!this.active()) failure = new Error('Initialization vault unavailable')
      else if (prior !== undefined && (!(prior instanceof Uint8Array) || prior.byteLength !== bytes.byteLength || prior.some((value, index) => value !== bytes[index])))
        failure = new Error('Initialization already prepared with different bytes')
      else {
        const pageRequest = tx.objectStore('pages').get(documentId)
        pageRequest.onsuccess = () => {
          if (!this.active()) failure = new Error('Initialization vault unavailable')
          else if (!pageRequest.result || canonicalDocumentValue(pageRequest.result) !== expected) failure = new Error('Initialization page changed')
          else if (prior === undefined) store.put(bytes, key)
          if (failure) tx.abort()
        }
      }
      if (failure) tx.abort()
    }
    try { await committed } catch (error) { throw failure ?? error }
    if (!this.active()) throw new Error('Initialization vault unavailable')
    return new Uint8Array(bytes)
  }
}
