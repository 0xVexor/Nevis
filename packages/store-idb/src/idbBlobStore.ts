// The IndexedDB adapter of the core's `BlobStore` (ROADMAP M9: store `blob_bytes`). Its OWN database, `nevis-<workspace>-blobs`, so that
// large files never share a transaction (or a version upgrade) with the sync tables, and so that the outbox gate's bookkeeping in the
// main database needs no migration. The bytes are kept as a `Blob`, not as bytes in memory: the browser may keep them on disk and a
// 50 MB file is never held as an ArrayBuffer here (WebKit cannot take large ArrayBuffers in IndexedDB reliably).
//
// One `put` is one readwrite transaction over both stores, so the row can never exist without its bytes.
import type { BlobMeta, BlobStore } from '@nevis/core'

export const BLOB_DB_VERSION = 1

export interface IdbBlobStoreOptions {
  /** the database name, `nevis-<workspaceId>-blobs` */
  name: string
  indexedDB?: IDBFactory
}

interface Row extends BlobMeta {
  n: number
  /** 1 while the file waits to be uploaded (not on the server, not failed): the index that `pending` reads */
  pend: 0 | 1
}

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error) })
const done = (tx: IDBTransaction): Promise<void> => new Promise((ok, bad) => { tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error); tx.onabort = () => bad(tx.error ?? new Error('aborted')) })
const metaOf = ({ hash, size, mime, remote, failed }: Row): BlobMeta => ({ hash, size, mime, remote, failed })

export class IdbBlobStore implements BlobStore {
  private db: Promise<IDBDatabase> | null = null
  private seq = 0
  private readonly o: IdbBlobStoreOptions
  constructor(o: IdbBlobStoreOptions) { this.o = o }

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((ok, bad) => {
      const r = (this.o.indexedDB ?? indexedDB).open(this.o.name, BLOB_DB_VERSION)
      r.onupgradeneeded = () => {
        r.result.createObjectStore('bytes') // key: the hash, value: a Blob
        const meta = r.result.createObjectStore('meta', { keyPath: 'hash' })
        meta.createIndex('byPend', ['pend', 'n'])
      }
      r.onerror = () => { this.db = null; bad(r.error) }
      r.onblocked = () => bad(new Error('the local attachment database is blocked by another tab'))
      r.onsuccess = () => {
        const d = r.result
        d.onversionchange = () => { d.close(); this.db = null }
        d.onclose = () => { this.db = null }
        ok(d)
      }
    }))
  }

  private next(): number { return Date.now() * 1000 + (this.seq++ % 1000) }

  private async write(hash: string, data: Blob, mime: string, remote: boolean): Promise<BlobMeta> {
    const db = await this.open()
    const tx = db.transaction(['bytes', 'meta'], 'readwrite')
    const meta = tx.objectStore('meta')
    const have = (await req(meta.get(hash))) as Row | undefined
    if (have) {
      if (remote && !have.remote) await req(meta.put({ ...have, remote: true, pend: 0 } satisfies Row))
      await done(tx)
      return metaOf({ ...have, remote: have.remote || remote })
    }
    const row: Row = { hash, size: data.size, mime, remote, failed: '', n: this.next(), pend: remote ? 0 : 1 }
    tx.objectStore('bytes').put(data, hash)
    meta.put(row)
    await done(tx) // a quota error surfaces here: nothing was written
    return metaOf(row)
  }

  put(hash: string, data: Blob, mime: string) { return this.write(hash, data, mime, false) }
  putRemote(hash: string, data: Blob, mime: string) { return this.write(hash, data, mime, true) }

  async meta(hash: string): Promise<BlobMeta | undefined> {
    const db = await this.open()
    const r = (await req(db.transaction('meta').objectStore('meta').get(hash))) as Row | undefined
    return r && metaOf(r)
  }

  async get(hash: string): Promise<Blob | undefined> {
    const db = await this.open()
    const tx = db.transaction(['bytes', 'meta'])
    const [m, b] = await Promise.all([req(tx.objectStore('meta').get(hash)), req(tx.objectStore('bytes').get(hash))])
    return m && b ? (b as Blob) : undefined
  }

  async pending(): Promise<BlobMeta[]> {
    const db = await this.open()
    const rows = (await req(db.transaction('meta').objectStore('meta').index('byPend').getAll(IDBKeyRange.bound([1, 0], [1, Number.MAX_SAFE_INTEGER])))) as Row[]
    return rows.map(metaOf)
  }

  async all(): Promise<BlobMeta[]> {
    const db = await this.open()
    return ((await req(db.transaction('meta').objectStore('meta').getAll())) as Row[]).sort((a, b) => a.n - b.n).map(metaOf)
  }

  private async patch(hash: string, f: (r: Row) => Row): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('meta', 'readwrite')
    const store = tx.objectStore('meta')
    const r = (await req(store.get(hash))) as Row | undefined
    if (r) { const n = f(r); store.put({ ...n, pend: n.remote || n.failed ? 0 : 1 } satisfies Row) }
    await done(tx)
  }
  setRemote(hash: string, remote: boolean) { return this.patch(hash, r => ({ ...r, remote })) }
  setFailed(hash: string, reason: string) { return this.patch(hash, r => ({ ...r, failed: reason })) }

  async delete(hash: string): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(['bytes', 'meta'], 'readwrite')
    tx.objectStore('bytes').delete(hash)
    tx.objectStore('meta').delete(hash)
    await done(tx)
  }
}
