// Storage boundary. In the desktop app (Tauri) every call goes to the SQLite database of ADR-0002 (src-tauri/src/main.rs);
// in a plain browser it falls back to IndexedDB: one record per page (so saving a page rewrites that page only), a versions
// store for page history, and a small key-value store.
import { invoke } from '@tauri-apps/api/core'
import { DB_SCHEMA_VERSION, upgradeDatabaseStores } from './database/storage/idb'
import { IndexedDbDocumentStorage } from './platform/documents/indexedDb'
import { publishDocumentChange } from './platform/documents/changes'
import type { Page } from './documents/model'
import type { DocumentWrite } from './documents/ports'
import type { DocumentVersion } from './documents/ports'
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

export async function allPages(): Promise<any[]> {
  if (isTauri) return invoke('pages_all')
  return browserDocuments.load()
}

/** Browser batches are transactional; native page files are individually atomic. */
export async function savePages(upserts: any[], removed: string[], clearFirst: boolean, preconditions?: { expectedVaultId: string; expectedPages?: DocumentWrite['expectedPages']; expectedAll?: Page[] }) {
  if (frozen) throw new Error('Document storage is unavailable')
  if (!preconditions || (!preconditions.expectedPages && !preconditions.expectedAll)) throw new Error('Missing document precondition')
  if (isTauri) {
    // ids of pages whose newer version on disk (another device's edit) was kept in the page history instead of being overwritten
    const kept = await invoke<string[]>('pages_save', { upserts, removed, clearFirst, ...preconditions })
    if (kept.length) window.dispatchEvent(new CustomEvent('sync-conflict', { detail: kept }))
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

// ───── vaults and account (desktop app only, ADR-0003) ─────

export interface VaultEntry {
  id: string
  name: string
  path: string
  sync: boolean
  exists: boolean
  /** ok: the vault is in its folder; missing: folder or marker gone (moved, deleted, drive unplugged); mismatch: another vault is in that folder */
  status: 'ok' | 'missing' | 'mismatch'
}
/** Signed in or not, and what the sync of the open vault is doing. */
export interface AccountStatus {
  signedIn: boolean
  username: string | null
  /** the server of the account (or the default one when signed out) */
  server: string
  defaultServer: string
  syncOn: boolean // sync of the open vault
  /** offline: the server cannot be reached; changes stay on this device and go out when it is back */
  state: 'off' | 'idle' | 'syncing' | 'paused' | 'error' | 'offline'
  lastAt: number
  /** NEEDS_CONFIRM: `error` holds the number of deletions that wait for the user */
  error: string
  /** why sync is paused: VAULT_MISSING | VAULT_MISMATCH | CLOUD_GONE | SIGNED_OUT | NEEDS_CONFIRM */
  reason: string
}
export interface CloudVault {
  id: string
  name: string
  files?: number
  bytes?: number
}
export interface TrashedVault {
  id: string
  name: string
  deletedAt: number
}
/** What a server says about itself. */
export interface ServerHealth {
  ok: boolean
  /** open: anyone; invite: needs an invite code; closed: no new accounts */
  registration: 'open' | 'invite' | 'closed'
  pow_bits: number
  api: number
}
export interface AccountDevice {
  id: string
  name: string
  created_at: number
  last_seen: number
  current: boolean
}
export interface AccountInfo {
  user: { id: string; username: string; created_at: number }
  devices: AccountDevice[]
  quota: { used: number; limit: number }
  vaults: number
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
/** Moves the vault's folder to the Recycle Bin / Trash and forgets it here. The cloud copy stays. */
export const vaultTrashLocal = (id: string) => invoke<void>('vault_trash_local', { id })
export const vaultRename = (id: string, name: string) => invoke<void>('vault_rename', { id, name })
export const accountStatus = () => invoke<AccountStatus>('account_status')
export const serverHealth = (server: string) => invoke<ServerHealth>('server_health', { server })
/** Creates an account and signs in; resolves with the recovery key (shown once). */
export const accountRegister = (server: string, username: string, password: string, invite: string) => invoke<string>('account_register', { server, username, password, invite })
export const accountLogin = (server: string, username: string, password: string) => invoke<void>('account_login', { server, username, password })
/** A new password with the recovery key; signs in and resolves with the new recovery key. */
export const accountRecover = (server: string, username: string, recoveryKey: string, newPassword: string) => invoke<string>('account_recover', { server, username, recoveryKey, newPassword })
export const accountLogout = () => invoke<void>('account_logout')
/** Writes a small .txt file where the user chose in the save dialog (the webview cannot download files). */
export const saveTextFile = (path: string, text: string) => invoke<void>('save_text_file', { path, text })
export const accountInfo = () => invoke<AccountInfo>('account_info')
export const accountRevokeDevice = (id: string) => invoke<void>('account_revoke_device', { id })
export const accountChangePassword = (oldPassword: string, newPassword: string) => invoke<void>('account_change_password', { oldPassword, newPassword })
export const accountNewRecoveryKey = (password: string) => invoke<string>('account_new_recovery_key', { password })
/** Schedules the deletion of the account (30 days of grace) and signs out here. */
export const accountDelete = (password: string) => invoke<number>('account_delete', { password })
export const syncSet = (on: boolean) => invoke<void>('sync_set', { on })
export const syncNow = () => invoke<void>('sync_now')
/** Runs the deletions a sync held back (many files at once, or a side that looked empty). */
export const syncConfirm = () => invoke<void>('sync_confirm')
/** Moves the cloud copy of a vault to the server's trash (30 days); the vault on this device stays. */
export const cloudDelete = (id: string) => invoke<void>('cloud_delete', { id })
/** The cloud copy is gone: upload this vault again as a new cloud copy (nothing is deleted). */
export const cloudReupload = (id: string) => invoke<void>('cloud_reupload', { id })
export const cloudVaults = () => invoke<CloudVault[]>('cloud_vaults')
/** Cloud vaults deleted in the last 30 days, which can be brought back. */
export const cloudTrashed = () => invoke<TrashedVault[]>('cloud_trashed')
export const cloudRestore = (id: string) => invoke<void>('cloud_restore', { id })
/** Deletes a vault of the server's trash for good (not undoable). */
export const cloudPurge = (id: string) => invoke<void>('cloud_purge', { id })
export const cloudDownload = (id: string, name: string, parent: string) => invoke<void>('cloud_download', { id, name, parent })
