import { addVersion, allPages, db, deleteVersions, isTauri, listVersions, savePages, storageFrozen, vaultInfo, vaultStamp } from '../db'
import { IndexedDbDocumentStorage } from './documents/indexedDb'
import { NativeDocumentStorage } from './documents/native'
import type { DocumentEnvironment } from '../documents/ports'
import type { Page } from '../documents/model'

const LEGACY_KEY = 'not.pages.v1'
const WATCH_EVERY = 3000

export function createAppDocumentEnvironment(): DocumentEnvironment {
  const storage = isTauri ? new NativeDocumentStorage(`desktop:${crypto.randomUUID()}`, {
    currentVaultId: async () => (await vaultInfo()).id,
    active: () => !storageFrozen(),
    load: allPages, save: savePages, stamp: vaultStamp, listVersions, addVersion, deleteVersions,
  }) : new IndexedDbDocumentStorage('browser:not.db', db, () => !storageFrozen())
  return {
    storage,
    host: {
      now: () => Date.now(), createId: () => crypto.randomUUID(),
      defer(task) { const timer = window.setTimeout(task, 0); return () => window.clearTimeout(timer) },
      emit(event, detail) { window.dispatchEvent(detail === undefined ? new Event(event) : new CustomEvent(event, { detail })) },
      report(context, error) { console.error(context, error) },
      readLegacy(): Page[] | null {
        try {
          const raw = localStorage.getItem(LEGACY_KEY)
          const pages = raw ? JSON.parse(raw) : null
          return Array.isArray(pages) && pages.length ? pages : null
        } catch { return null }
      },
      clearLegacy() { localStorage.removeItem(LEGACY_KEY) },
      requestPersistence() { navigator.storage?.persist?.().catch(() => {}) },
      ...(isTauri ? { async watchExternal(changed: () => void) {
        const timer = window.setInterval(() => !document.hidden && changed(), WATCH_EVERY)
        window.addEventListener('focus', changed)
        let closed = false
        let unlisten: (() => void) | undefined
        void import('@tauri-apps/api/event').then(({ listen }) => listen('vault-changed', changed))
          .then(stop => { if (closed) stop(); else unlisten = stop }).catch(() => {})
        return () => { closed = true; window.clearInterval(timer); window.removeEventListener('focus', changed); unlisten?.() }
      } } : {}),
    },
  }
}
