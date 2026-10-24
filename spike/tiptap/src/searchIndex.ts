// Search over the SQLite FTS index of the open vault (desktop app, src-tauri/src/index.rs).
// This file keeps that index current and asks it for results. In a plain browser there is no index and the
// in-memory search of the repository is used, so the UI does not need to know which one answers.
import { invoke } from '@tauri-apps/api/core'
import { isTauri, storageFrozen } from './db'
import { normalizeFa } from './normalize'
import { repo } from './store'
import type { Page } from './repo'

const QUIET = 800 // wait for editing to pause before updating the index
const CHUNK = 200 // pages per call, so a first build of a big vault does not freeze the app
const LIMIT = 50

const textOf = (n: any): string => (!n || typeof n === 'string' ? '' : (n.text ?? (n.content ?? []).map(textOf).join(' ')))

let indexed: Map<string, number> | null = null // id -> updatedAt as the index has it
let timer = 0
let running: Promise<void> | null = null
let dirty = true

async function build() {
  if (storageFrozen()) return
  indexed ??= new Map(Object.entries(await invoke<Record<string, number>>('index_state')))
  const live = repo.pagesOnly()
  const liveIds = new Set(live.map((p) => p.id))
  const stale = live.filter((p) => indexed!.get(p.id) !== p.updatedAt)
  const removed = [...indexed.keys()].filter((id) => !liveIds.has(id))
  for (let i = 0; i < Math.max(1, Math.ceil(stale.length / CHUNK)); i++) {
    const part = stale.slice(i * CHUNK, (i + 1) * CHUNK)
    const docs = part.map((p) => ({ id: p.id, updated: p.updatedAt, title: normalizeFa(p.title), tags: normalizeFa((p.tags ?? []).join(' ')), body: normalizeFa(textOf(p.content)) }))
    if (!docs.length && (i > 0 || !removed.length)) break
    await invoke('index_update', { docs, removed: i === 0 ? removed : [] })
    part.forEach((p) => indexed!.set(p.id, p.updatedAt))
    if (i === 0) removed.forEach((id) => indexed!.delete(id))
    await new Promise((r) => setTimeout(r)) // let the UI breathe
  }
}

/** Brings the index up to date; concurrent callers share one run. */
function refresh(): Promise<void> {
  if (!running) {
    dirty = false
    running = build()
      .catch((e) => {
        console.error("search index", e)
        indexed = null
        dirty = true
      })
      .finally(() => {
        running = null
        if (dirty) schedule()
      })
  }
  return running!
}

function schedule() {
  dirty = true
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void refresh(), QUIET)
}

export function initSearchIndex() {
  if (!isTauri) return
  window.addEventListener('data-changed', schedule)
  window.addEventListener('external-change', schedule)
  window.setTimeout(() => void refresh(), 500)
}

/** Ranked pages for a query: all words must match (word starts, Persian-normalized). */
export async function searchPages(query: string): Promise<Page[]> {
  const words = normalizeFa(query).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  if (!isTauri) return repo.search(query)
  try {
    if (dirty || running) {
      window.clearTimeout(timer)
      await refresh() // an edit made a moment ago must be findable
    }
    const ids = await invoke<string[]>('index_search', { words, limit: LIMIT })
    return ids.map((id) => repo.get(id)).filter((p): p is Page => !!p && p.kind !== 'folder')
  } catch (e) {
    console.error('search', e)
    return repo.search(query)
  }
}
