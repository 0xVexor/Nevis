import { addVersion, allPages, db, deleteVersions, isTauri, listVersions, savePages, storageFrozen, vaultInfo, vaultStamp, listDocumentOperations, findDocumentOperation, commitDocumentOperation, commitDocumentOperationResult } from '../db'
import { IndexedDbDocumentStorage } from './documents/indexedDb'
import { NativeDocumentStorage } from './documents/native'
import { publishDocumentChange } from './documents/changes'
import type { DocumentEnvironment } from '../documents/ports'
import type { Page } from '../documents/model'
import type { DocumentReadRuntime } from '../documents/reader'

export function createDocumentReadRuntime(): DocumentReadRuntime {
  return {
    async digestBytes(bytes) {
      const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
      return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    },
    now: () => Date.now(), cursorId: () => crypto.randomUUID(),
    async digest(snapshot) {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot))
      return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    },
  }
}

const LEGACY_KEY = 'not.pages.v1'
const WATCH_EVERY = 3000

export function createAppDocumentEnvironment(): DocumentEnvironment {
  const storage = isTauri ? new NativeDocumentStorage(`desktop:${crypto.randomUUID()}`, {
    currentVaultId: async () => (await vaultInfo()).id,
    active: () => !storageFrozen(),
    load: allPages, save: savePages, stamp: vaultStamp, listVersions, addVersion, deleteVersions,
    listOperations: listDocumentOperations, findOperation: findDocumentOperation, commitOperation: commitDocumentOperation,
    commitOperationResult: commitDocumentOperationResult,
  }) : new IndexedDbDocumentStorage('browser:not.db', db, () => !storageFrozen(), publishDocumentChange, {
    digest: createDocumentReadRuntime().digestBytes!,
    async write(assets, addedAt) {
      const { putRecord } = await import('../attachments')
      for (const asset of assets) {
        if (storageFrozen()) throw new Error('Document storage is unavailable')
        await putRecord({ id: asset.id, type: asset.mimeType, name: asset.name, size: asset.bytes.length, blob: new Blob([new Uint8Array(asset.bytes)], { type: asset.mimeType }), addedAt })
      }
    },
  })
  return {
    storage,
    search: { yield: () => new Promise(resolve => window.setTimeout(resolve, 0)) },
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
      async watchExternal(changed: () => void) {
        const timer = window.setInterval(() => !document.hidden && changed(), WATCH_EVERY)
        window.addEventListener('focus', changed)
        let closed = false
        let unlisten: (() => void) | undefined
        const channels: BroadcastChannel[] = []
        if (isTauri) void import('@tauri-apps/api/event').then(({ listen }) => listen('vault-changed', changed))
          .then(stop => { if (closed) stop(); else unlisten = stop }).catch(() => {})
        else if (typeof BroadcastChannel !== 'undefined') for (const name of ['nevis-documents', 'noviq-database']) {
          try { const channel = new BroadcastChannel(name); channel.onmessage = changed; channels.push(channel) } catch { /* focus/polling remain available */ }
        }
        return () => { closed = true; window.clearInterval(timer); window.removeEventListener('focus', changed); unlisten?.(); channels.forEach(channel => channel.close()) }
      },
    },
  }
}
