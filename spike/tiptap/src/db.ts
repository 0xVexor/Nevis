import type { DocumentAdmission } from './documents/admission'
// Storage boundary. In the desktop app (Tauri), canonical pages/records/assets live in vault files (src-tauri/src/main.rs);
// in a plain browser it falls back to IndexedDB: one record per page (so saving a page rewrites that page only), a versions
// store for page history, and a small key-value store.
import { invoke } from '@tauri-apps/api/core'
import { DB_SCHEMA_VERSION, upgradeDatabaseStores } from './database/storage/idb'
import { IndexedDbDocumentStorage } from './platform/documents/indexedDb'
import { publishDocumentChange } from './platform/documents/changes'
import type { Page } from './documents/model'
import type { ConflictMarker } from './conflict/types'
import type { DocumentWrite } from './documents/ports'
import type { DocumentVersion } from './documents/ports'
import type { DocumentOperationRecord, DocumentOperationReceipt, DocumentOperationCommitResult, DocumentOperationSummary } from './documents/operations'
export type { DocumentVersion as Version } from './documents/ports'

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

const browserDocuments = new IndexedDbDocumentStorage('browser:not.db', db, () => !frozen, publishDocumentChange)

export async function listDocumentOperations(scopeId: string, documentId: string, expectedVaultId: string) {
  if (frozen) throw new Error('Document storage is unavailable')
  return invoke<DocumentOperationSummary[]>('document_operation_list', { scopeId, documentId, expectedVaultId })
}
export async function findDocumentOperation(scopeId: string, operationId: string, expectedVaultId: string) {
  if (frozen) throw new Error('Document storage is unavailable')
  return invoke<DocumentOperationRecord | null>('document_operation_find', { scopeId, operationId, expectedVaultId })
}
export async function commitDocumentOperation(record: DocumentOperationRecord, expectedVaultId: string) {
  if (frozen) throw new Error('Document storage is unavailable')
  return invoke<DocumentOperationReceipt>('document_operation_commit', { record, expectedVaultId })
}
export async function commitDocumentOperationResult(record: DocumentOperationRecord, expectedVaultId: string, admission?: DocumentAdmission['native']) {
  if (frozen) throw new Error('Document storage is unavailable')
  return invoke<DocumentOperationCommitResult>('document_operation_commit', { record, expectedVaultId, includeStatus: true, admission })
}

export async function allPages(): Promise<Page[]> {
  if (isTauri) return invoke('pages_all')
  return browserDocuments.load()
}

/** Browser batches are transactional; native page files are individually atomic. */
export async function savePages(
  upserts: Page[],
  removed: string[],
  clearFirst: boolean,
  preconditions?: { expectedVaultId: string; expectedPages?: DocumentWrite['expectedPages']; expectedAll?: Page[] },
) {
  if (frozen) throw new Error('Document storage is unavailable')
  if (!preconditions || (!preconditions.expectedPages && !preconditions.expectedAll)) throw new Error('Missing document precondition')
  if (isTauri) {
    // ids of pages whose newer version on disk (changed by another program) was kept in the page history instead of being overwritten
    const kept = await invoke<string[]>('pages_save', { upserts, removed, clearFirst, ...preconditions })
    if (kept.length) window.dispatchEvent(new CustomEvent('page-conflict', { detail: kept }))
    return
  }
  await browserDocuments.save({ upserts, removed, replaceAll: clearFirst, baseVersions: {}, ...preconditions })
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

/**
 * Saves a user setting merged with what is stored now (another device may have changed it since `base` was read) and returns
 * the value the screen must adopt. `base` is what the edit started from (null when nothing was stored).
 * Throws STORAGE:unreadable_setting when the stored file cannot be read; nothing is written then.
 * A frozen workspace or a browser has no one to merge with: the edit is returned as it is (and not stored while frozen).
 */
export async function kvSave<T>(key: string, base: T | null | undefined, next: T): Promise<T> {
  if (frozen) return next
  if (inSqlite(key)) return invoke<T>('kv_save', { key, base: base ?? null, next })
  await kvSet(key, next)
  return next
}

/** Same for the preferences cache; the backend wants an object as `base` ({} when nothing was stored). */
export const prefsSave = (base: Record<string, string | null>, next: Record<string, string | null>) => invoke<Record<string, string | null>>('prefs_save', { base, next })

// ───── page history ─────

export async function listVersions(pageId: string): Promise<DocumentVersion[]> {
  if (isTauri) return invoke('versions_list', { pageId })
  return browserDocuments.listVersions(pageId)
}

export async function addVersion(version: DocumentVersion) {
  if (frozen) return
  if (isTauri) return invoke<void>('version_add', { version })
  await browserDocuments.addVersion(version)
}

export async function deleteVersions(pageId: string) {
  if (frozen) return
  if (isTauri) return invoke<void>('versions_delete', { pageId })
  await browserDocuments.deleteVersions(pageId)
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
export const pagesSearchStamp = () => invoke<string | null>('pages_search_stamp')
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

/** The file on disk that holds a page (desktop app only). */
export const pageFilePath = (id: string) => invoke<string>('page_path', { id })
/** Shows that file in Explorer, Finder or the file manager (desktop app only). */
export const revealPageFile = (id: string) => invoke<void>('page_reveal', { id })

// ───── page conflicts (desktop app with sync; the browser build has no sync, so there is nothing to list or close) ─────

export const pageConflictsList = async (pageId?: string): Promise<ConflictMarker[]> => (isTauri ? invoke<ConflictMarker[]>('page_conflicts_list', { pageId }) : [])
export const pageConflictGet = async (cid: string): Promise<ConflictMarker | null> => (isTauri ? invoke<ConflictMarker | null>('page_conflict_get', { cid }) : null)
/** resolved: the merged page was applied; dismissed: the current version was kept. The marker leaves the list either way. */
export async function pageConflictClose(cid: string, outcome: 'resolved' | 'dismissed') {
  if (isTauri) await invoke<void>('page_conflict_close', { cid, outcome })
}
export async function pageConflictRecord(pageId: string, base: Page | null, local: Page, remote: Page, kind: 'editor-race'): Promise<ConflictMarker | null> {
  if (frozen || !isTauri) return null
  return invoke<ConflictMarker>('page_conflict_record', { pageId, base, local, remote, kind })
}
/** Calls `changed` with the ids of pages whose markers were recorded, closed or arrived. Returns the unsubscribe function; does nothing in the browser. */
export function onPageConflictsChanged(changed: (pageIds: string[]) => void): () => void {
  if (!isTauri) return () => {}
  let closed = false
  let stop: (() => void) | undefined
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<{ pageIds: string[] }>('page-conflicts-changed', (e) => changed(e.payload.pageIds ?? [])))
    .then((off) => (closed ? off() : (stop = off)))
    .catch(() => {})
  return () => {
    closed = true
    stop?.()
  }
}
