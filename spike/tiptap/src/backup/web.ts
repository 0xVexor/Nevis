// The browser build keeps everything in IndexedDB: a backup is a copy of its stores, a restore replaces them in one transaction.
import { allFiles, putRecord } from '../attachments'
import { db, kvGet } from '../db'
import type { PageRepo } from '../repo'
import { FORMAT, STORES, digest, request, toBase64 } from './format'
import type { BackupPlan } from './inspect'

export async function buildWeb(repo: PageRepo): Promise<Blob> {
  const d = await db()
  const tx = d.transaction(STORES, 'readonly')
  const records: Record<string, { key: IDBValidKey; value: unknown }[]> = {}
  await Promise.all(
    STORES.map(async (name) => {
      const store = tx.objectStore(name)
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
      records[name] = keys.map((key, i) => ({ key, value: values[i] })).filter((r) => name !== 'kv' || r.key !== 'backupDir')
    }),
  )
  const files = await Promise.all((await allFiles()).map(async (f) => ({ id: f.id, type: f.type, name: f.name, size: f.size, data: await toBase64(f.blob) })))
  const data = { format: FORMAT, version: 2, createdAt: new Date().toISOString(), pages: repo.dump(), files, records, recordsHash: await digest(new TextEncoder().encode(JSON.stringify(records))) }
  return new Blob([JSON.stringify(data)], { type: 'application/json' })
}

/** Replaces every store. Files are added first and never removed, so a failure leaves the old pages with their images. */
export async function applyWeb(repo: PageRepo, plan: BackupPlan) {
  const { data, prepared } = plan
  for (const f of prepared) await putRecord(f)
  const directoryHandle = await kvGet('backupDir')
  const database = await db()
  const tx = database.transaction(data.version === 2 ? STORES : ['pages'], 'readwrite')
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
  try {
    if (data.version === 2)
      for (const name of STORES) {
        const store = tx.objectStore(name)
        store.clear()
        if (name === 'kv' && directoryHandle !== undefined) store.put(directoryHandle, 'backupDir')
        for (const row of data.records[name]) {
          if (store.keyPath) store.put(row.value)
          else store.put(row.value, row.key)
        }
      }
    else {
      const store = tx.objectStore('pages')
      store.clear()
      for (const p of data.pages) store.put(p)
    }
  } catch (e) {
    tx.abort()
    await completed.catch(() => {})
    throw e
  }
  await completed
  await repo.refreshFromStore()
}
