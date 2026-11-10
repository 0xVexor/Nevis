// Shared by every backup module: the file format name, the error type and the byte helpers. No app state in here.

export const FORMAT = 'notes-backup'
export const TAURI_FORMAT = 'nevis-vault-backup'
/** The IndexedDB stores a full backup carries (the first one is what a v1 backup held). */
export const STORES = ['pages', 'versions', 'kv', 'db_records', 'db_history', 'db_meta', 'db_ops']

/** A problem with the backup file itself. The message is already translated and meant to be shown. */
export class BackupError extends Error {}

/**
 * Saves a file the person asked for. The desktop app asks where to put it (a Save As dialog) and writes it there; the browser
 * uses its own download. Resolves false when the person cancels the dialog, true otherwise.
 */
export async function download(name: string, blob: Blob): Promise<boolean> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const [{ save }, { invoke }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/api/core')])
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
      const path = await save({ defaultPath: name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined })
      if (!path) return false // cancelled
      await invoke('file_save_as', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-path': encodeURIComponent(path) } })
      return true
    } catch (error) {
      console.error(error) // fall back to the browser download below, so the file is not lost
    }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  return true
}

export const toBase64 = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).split(',')[1] ?? '')
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })

export const fromBase64 = (b64: string, type: string) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

export async function digest(bytes: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/** 2026-11-01_10-55: sortable, and safe in a file name. */
export const fileStamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`
}
