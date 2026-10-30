// Content-addressed file store (the `attachments` table of ADR-0002): id = sha256 of the bytes, identical files are stored once.
// Desktop app: files live in <vault>/files/<sha[0:2]>/<sha> (src-tauri); browser: IndexedDB.
import { invoke } from '@tauri-apps/api/core'
import { isTauri, storageFrozen } from './db'
import { maybeCompress } from './compress'

interface FileRec {
  id: string
  type: string
  name: string
  size: number
  blob: Blob
  addedAt?: number // ms; lets GC skip files that may not be referenced by a saved page yet
}

const DB = 'not.files'
const STORE = 'blobs'
const urls = new Map<string, string>()

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function sha256(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function putFile(original: File | Blob, name = (original as File).name ?? ''): Promise<string> {
  const file = await maybeCompress(original)
  const id = await sha256(file)
  const rec: FileRec = { id, type: file.type, name, size: file.size, blob: file, addedAt: Date.now() }
  await putRecord(rec)
  return id
}

export async function putRecord(rec: FileRec) {
  if (storageFrozen()) return
  if (isTauri) {
    const headers = { 'x-file-id': rec.id, 'x-file-type': rec.type, 'x-file-name': encodeURIComponent(rec.name), 'x-added-at': String(rec.addedAt ?? Date.now()) }
    await invoke('file_put', new Uint8Array(await rec.blob.arrayBuffer()), { headers })
    return
  }
  await tx('readwrite', (s) => s.put(rec))
}

const types = new Map<string, string>() // desktop app: mime type per file id
async function refreshTypes() {
  for (const m of await invoke<{ id: string; type: string }[]>('files_list')) types.set(m.id, m.type)
  return types
}

async function readBlob(id: string, type: string): Promise<Blob> {
  return new Blob([await invoke<ArrayBuffer>('file_get', { id })], { type })
}

export async function allFiles(): Promise<FileRec[]> {
  if (!isTauri) return tx<FileRec[]>('readonly', (s) => s.getAll())
  const metas = await invoke<Omit<FileRec, 'blob'>[]>('files_list')
  return Promise.all(metas.map(async (m) => ({ ...m, name: decodeURIComponent(m.name), blob: await readBlob(m.id, m.type) })))
}

export async function urlFor(src: string): Promise<string | null> {
  if (!src.startsWith('att:')) return src
  const id = src.slice(4)
  const hit = urls.get(id)
  if (hit) return hit
  let blob: Blob | undefined
  if (isTauri) {
    const type = types.get(id) ?? (await refreshTypes()).get(id)
    blob = type === undefined ? undefined : await readBlob(id, type).catch(() => undefined)
  } else blob = (await tx<FileRec | undefined>('readonly', (s) => s.get(id)))?.blob
  if (!blob) return null
  const u = URL.createObjectURL(blob)
  urls.set(id, u)
  return u
}

/** Name, type and size of the given files, without their bytes (database file properties list names before anything is opened). */
export async function fileMeta(ids: string[]): Promise<Map<string, { name: string; type: string; size: number }>> {
  const out = new Map<string, { name: string; type: string; size: number }>()
  if (!ids.length) return out
  if (isTauri) {
    const want = new Set(ids)
    for (const m of await invoke<{ id: string; type: string; name: string; size: number }[]>('files_list')) if (want.has(m.id)) out.set(m.id, { name: decodeURIComponent(m.name), type: m.type, size: m.size })
  } else {
    for (const id of ids) {
      const r = await tx<FileRec | undefined>('readonly', (s) => s.get(id))
      if (r) out.set(id, { name: r.name, type: r.type, size: r.size })
    }
  }
  return out
}
