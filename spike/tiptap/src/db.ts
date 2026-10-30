// Storage boundary. In the desktop app (Tauri), canonical pages/records/assets live in vault files (src-tauri/src/main.rs);
// in a plain browser it falls back to IndexedDB: one record per page (so saving a page rewrites that page only), a versions
// store for page history, and a small key-value store.
import { invoke } from '@tauri-apps/api/core'
import { DB_SCHEMA_VERSION, upgradeDatabaseStores } from './database/storage/idb'

export const isTauri = '__TAURI_INTERNALS__' in window

// While the app switches to another vault, the old workspace is still in memory. Nothing may be written then,
// or its pages would end up in the vault that was just opened.
let frozen = false
export const freezeStorage = () => void (frozen = true)
/** The switch did not happen after all: the workspace in memory may be saved again. */
export const thawStorage = () => void (frozen = false)
export const storageFrozen = () => frozen

const NAME = 'not.db'
let opening: Promise<IDBDatabase> | null = null

export function db(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, DB_SCHEMA_VERSION)
    req.onupgradeneeded = () => {
      const d = req.result
      // v1: pages / versions / kv. Existing data is never touched by an upgrade; the database stores (v2) are only added.
      if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('versions')) d.createObjectStore('versions', { keyPath: ['pageId', 'ts'] }).createIndex('byPage', 'pageId')
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv')
      upgradeDatabaseStores(d)
    }
    req.onblocked = () => reject(new Error('Another tab of this app uses an older version of the data. Close the other tabs and reload.'))
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close() // let a newer tab upgrade; this one reloads
      resolve(req.result)
    }
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
  if (frozen) return
  if (isTauri) {
    // ids of pages whose newer version on disk (changed by another program) was kept in the page history instead of being overwritten
    const kept = await invoke<string[]>('pages_save', { upserts, removed, clearFirst })
    if (kept.length) window.dispatchEvent(new CustomEvent('page-conflict', { detail: kept }))
    return
  }
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
  if (frozen) return
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
  if (frozen) return
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
  if (frozen) return
  if (isTauri) return invoke<void>('versions_delete', { pageId })
  const all = await listVersions(pageId)
  if (!all.length) return
  const tx = (await db()).transaction('versions', 'readwrite')
  all.forEach((v) => tx.objectStore('versions').delete([v.pageId, v.ts]))
  await done(tx)
}

// ───── vaults (desktop app only, ADR-0003) ─────

export interface VaultEntry {
  id: string
  name: string
  path: string
  exists: boolean
  /** ok: the vault is in its folder; missing: folder or marker gone (moved, deleted, disk unplugged); mismatch: another vault is in that folder */
  status: 'ok' | 'missing' | 'mismatch'
}

export const vaultStamp = () => invoke<string>('vault_stamp')
export const vaultList = () => invoke<{ vaults: VaultEntry[]; current: string | null }>('vault_list')
export const vaultInfo = () => invoke<{ id: string; name: string; path: string }>('vault_info')
export const vaultCreate = (parent: string, name: string) => invoke<string>('vault_create', { parent, name })
export const vaultAdd = (path: string) => invoke<string>('vault_add', { path })
export const vaultOpen = (id: string) => invoke<void>('vault_open', { id })
export const vaultClose = () => invoke<void>('vault_close')
export const vaultForget = (id: string) => invoke<void>('vault_forget', { id })
/** The vault was moved: point at its new folder (must hold the same vault). */
export const vaultLocate = (id: string, path: string) => invoke<void>('vault_locate', { id, path })
/** Moves the vault's folder to the Recycle Bin / Trash and forgets it here. */
export const vaultTrashLocal = (id: string) => invoke<void>('vault_trash_local', { id })
export const vaultRename = (id: string, name: string) => invoke<void>('vault_rename', { id, name })
