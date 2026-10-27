import { allFiles, putRecord } from './attachments'
import { toMarkdown } from './markdown'
import { frontMatter } from './meta'
import type { Page, PageRepo } from './repo'
import { t } from './i18n'
import { invoke } from '@tauri-apps/api/core'
import { db, isTauri, freezeStorage, thawStorage, kvGet } from './db'
import { saveBeforeUpdate } from './updateSave'
import { flushPreferences } from './sharedPreferences'

const FORMAT = 'notes-backup'

export function download(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const toBase64 = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).split(',')[1] ?? '')
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })

const fromBase64 = (b64: string, type: string) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

const dataUri = async (src: string) => {
  if (!src.startsWith('att:')) return src
  const f = (await allFiles()).find((x) => x.id === src.slice(4))
  return f ? `data:${f.type};base64,${await toBase64(f.blob)}` : ''
}

export const pageToMarkdown = async (p: Page) => frontMatter(p) + (await toMarkdown(p.title, p.content, dataUri))

/** Full backup as one JSON file (pages incl. trash + every attachment). */
export async function buildBackup(repo: PageRepo): Promise<Blob> {
  await saveBeforeUpdate()
  await repo.flushBeforeUpdate()
  await flushPreferences()
  if (isTauri) return new Blob([JSON.stringify(await invoke('vault_backup_export'))], { type: 'application/json' })
  const d = await db()
  const stores = ['pages', 'versions', 'kv', 'db_records', 'db_history', 'db_meta', 'db_ops']
  const tx = d.transaction(stores, 'readonly')
  const records: Record<string, { key: IDBValidKey; value: unknown }[]> = {}
  await Promise.all(stores.map(async (name) => {
    const store = tx.objectStore(name)
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    records[name] = keys.map((key, i) => ({ key, value: values[i] })).filter((r) => name !== 'kv' || r.key !== 'backupDir')
  }))
  const files = await Promise.all(
    (await allFiles()).map(async (f) => ({ id: f.id, type: f.type, name: f.name, size: f.size, data: await toBase64(f.blob) })),
  )
  const data = { format: FORMAT, version: 2, createdAt: new Date().toISOString(), pages: repo.dump(), files, records, recordsHash: await digest(new TextEncoder().encode(JSON.stringify(records))) }
  return new Blob([JSON.stringify(data)], { type: 'application/json' })
}

export class BackupError extends Error {}

/** Validates first, then replaces everything. Nothing is touched if validation fails. */
export async function restoreBackup(repo: PageRepo, text: string): Promise<{ pages: number; files: number }> {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new BackupError(t('Not a valid JSON file.'))
  }
  if (isTauri && data?.format === 'noviq-vault-backup' && data.version === 2) {
    await saveBeforeUpdate(); await repo.flushBeforeUpdate(); await flushPreferences()
    freezeStorage()
    try {
      const result = await invoke<{ pages: number; files: number }>('vault_backup_restore', { data })
      window.location.reload()
      return result
    } catch (e) { thawStorage(); throw e }
  }
  if (data?.format !== FORMAT || ![1, 2].includes(data.version) || !Array.isArray(data.pages) || !Array.isArray(data.files))
    throw new BackupError(t('This is not a backup of this app, or its version is not supported.'))
  const ids = new Set<string>()
  for (const p of data.pages) {
    if (typeof p?.id !== 'string' || typeof p.title !== 'string' || !p.content || ids.has(p.id))
      throw new BackupError(t('The page structure is corrupted.'))
    ids.add(p.id)
  }
  for (const p of data.pages) if (p.parentId && !ids.has(p.parentId)) throw new BackupError(t('A page has no parent.'))

  // Validate every byte before any write. Stage assets additively so a later failure cannot remove old references.
  const prepared = []
  const fileIds = new Set<string>()
  for (const f of data.files) {
    if (typeof f.id !== 'string' || !/^[a-f0-9]{64}$/.test(f.id) || fileIds.has(f.id) || typeof f.data !== 'string' || typeof f.type !== 'string' || typeof f.name !== 'string') throw new BackupError(t('The attachment structure is corrupted.'))
    const blob = fromBase64(f.data, f.type)
    if (blob.size !== f.size || await digest(await blob.arrayBuffer()) !== f.id) throw new BackupError(t('An attachment failed verification.'))
    fileIds.add(f.id)
    prepared.push({ ...f, blob })
  }
  if (isTauri) {
    // Legacy page-only backups also restore into a fresh vault, without touching existing databases.
    const entries: Record<string, { data: string; sha256: string }> = {}
    const add = async (path: string, bytes: Uint8Array) => { entries[path] = { data: await toBase64(new Blob([bytes as BlobPart])), sha256: await digest(bytes as BufferSource) } }
    for (const p of data.pages) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)) throw new BackupError(t('The page structure is corrupted.'))
      await add('pages/' + p.id + '.json', new TextEncoder().encode(JSON.stringify(p)))
    }
    for (const f of prepared) {
      const path = 'files/' + f.id.slice(0, 2) + '/' + f.id
      await add(path, new Uint8Array(await f.blob.arrayBuffer()))
      await add(path + '.json', new TextEncoder().encode(JSON.stringify({ id: f.id, type: f.type, name: f.name, size: f.size, addedAt: Date.now() })))
    }
    await add('.noviq/vault.json', new TextEncoder().encode(JSON.stringify({ format: 1, id: crypto.randomUUID(), name: 'Imported backup' })))
    return restoreBackup(repo, JSON.stringify({ format: 'noviq-vault-backup', version: 2, name: 'Imported backup', created_at: Date.now(), entries }))
  }
  const allowed = ['pages', 'versions', 'kv', 'db_records', 'db_history', 'db_meta', 'db_ops']
  if (data.version === 2) {
    if (typeof data.recordsHash !== 'string' || await digest(new TextEncoder().encode(JSON.stringify(data.records))) !== data.recordsHash) throw new BackupError(t('The backup records are corrupted.'))
    if (!data.records || Object.keys(data.records).some((k) => !allowed.includes(k)) || allowed.some((k) => !Array.isArray(data.records[k]))) throw new BackupError(t('The backup records are corrupted.'))
    for (const rows of Object.values(data.records) as { key: IDBValidKey; value: unknown }[][]) {
      const keys = new Set<string>()
      for (const row of rows) {
        const key = JSON.stringify(row.key)
        if (row.value === undefined || row.key === undefined || keys.has(key)) throw new BackupError(t('The backup records are corrupted.'))
        keys.add(key)
      }
    }
    if (JSON.stringify(data.records.pages.map((r: { value: unknown }) => r.value)) !== JSON.stringify(data.pages)) {
      // The canonical store controls page identity; redundant display pages must describe the same set.
      const ids = new Set(data.records.pages.map((r: { value: { id: string } }) => r.value?.id))
      if (ids.size !== data.pages.length || data.pages.some((p: { id: string }) => !ids.has(p.id))) throw new BackupError(t('The backup records are corrupted.'))
    }
  }
  await saveBeforeUpdate(); await repo.flushBeforeUpdate()
  for (const f of prepared) await putRecord(f)
  const directoryHandle = await kvGet('backupDir')
  const database = await db()
  const tx = database.transaction(data.version === 2 ? allowed : ['pages'], 'readwrite')
  const completed = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error) })
  try {
    if (data.version === 2) for (const name of allowed) {
      const store = tx.objectStore(name); store.clear()
      if (name === 'kv' && directoryHandle !== undefined) store.put(directoryHandle, 'backupDir')
      for (const row of data.records[name]) {
        if (store.keyPath) store.put(row.value)
        else store.put(row.value, row.key)
      }
    }
    else { const store = tx.objectStore('pages'); store.clear(); for (const p of data.pages) store.put(p) }
  } catch (e) { tx.abort(); await completed.catch(() => {}); throw e }
  await completed
  await repo.refreshFromStore()
  window.location.reload()
  return { pages: data.pages.length, files: data.files.length }
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
async function digest(bytes: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}
