// Storage boundary. In the desktop app (Tauri) every call goes to the SQLite database of ADR-0002 (src-tauri/src/main.rs);
// in a plain browser it falls back to IndexedDB: one record per page (so saving a page rewrites that page only), a versions
// store for page history, and a small key-value store.
import { invoke } from '@tauri-apps/api/core'

export const isTauri = '__TAURI_INTERNALS__' in window

const NAME = 'not.db'
let opening: Promise<IDBDatabase> | null = null

export function db(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1)
    req.onupgradeneeded = () => {
      const d = req.result
      d.createObjectStore('pages', { keyPath: 'id' })
      d.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId')
      d.createObjectStore('kv')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })

const wrap = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

export async function allPages(): Promise<any[]> {
  if (isTauri) return invoke('pages_all')
  return wrap((await db()).transaction('pages').objectStore('pages').getAll())
}

/** One transaction: either everything is written or nothing (crash safety). */
export async function savePages(upserts: any[], removed: string[], clearFirst: boolean) {
  if (isTauri) return invoke<void>('pages_save', { upserts, removed, clearFirst })
  const tx = (await db()).transaction('pages', 'readwrite')
  const s = tx.objectStore('pages')
  if (clearFirst) s.clear()
  upserts.forEach((p) => s.put(p))
  removed.forEach((id) => s.delete(id))
  await done(tx)
}

// a folder handle (backupDir) cannot be serialized, so it always stays in IndexedDB
const inSqlite = (key: string) => isTauri && key !== 'backupDir'

export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (inSqlite(key)) return ((await invoke<T | null>('kv_get', { key })) ?? undefined) as T | undefined
  return wrap((await db()).transaction('kv').objectStore('kv').get(key))
}

export async function kvSet(key: string, value: unknown) {
  if (inSqlite(key)) return invoke<void>('kv_set', { key, value })
  const tx = (await db()).transaction('kv', 'readwrite')
  tx.objectStore('kv').put(value, key)
  await done(tx)
}

// ───── page history ─────

export interface Version {
  pageId: string
  ts: number
  title: string
  content: any
}

const KEEP_VERSIONS = 40

export async function listVersions(pageId: string): Promise<Version[]> {
  if (isTauri) return invoke('versions_list', { pageId })
  const rows: Version[] = await wrap((await db()).transaction('versions').objectStore('versions').index('byPage').getAll(pageId))
  return rows.sort((a, b) => b.ts - a.ts)
}

export async function addVersion(v: Version) {
  if (isTauri) return invoke<void>('version_add', { version: v })
  const tx = (await db()).transaction('versions', 'readwrite')
  tx.objectStore('versions').put(v)
  await done(tx)
  const all = await listVersions(v.pageId)
  if (all.length > KEEP_VERSIONS) {
    const t2 = (await db()).transaction('versions', 'readwrite')
    all.slice(KEEP_VERSIONS).forEach((old) => t2.objectStore('versions').delete([old.pageId, old.ts]))
    await done(t2)
  }
}

export async function deleteVersions(pageId: string) {
  if (isTauri) return invoke<void>('versions_delete', { pageId })
  const all = await listVersions(pageId)
  if (!all.length) return
  const tx = (await db()).transaction('versions', 'readwrite')
  all.forEach((v) => tx.objectStore('versions').delete([v.pageId, v.ts]))
  await done(tx)
}
