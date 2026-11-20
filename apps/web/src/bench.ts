// M5 bench (go/no-go for ADR-0001: 10 000 pages). Driven by tools/bench/run.mjs; also usable by hand: window.__bench.
//   seed(n)   writes n pages (a 3-level tree) and ~300 bodies of ~100 paragraphs, in a few large transactions
//   cold()    what the app does at startup: open IDB, ONE bulk read, build the tree, render the root pages
//   open(id)  open a page body: DocHandle.open + the editor on it, until it has painted
import { Client, DocHandle, buildTree, readPages } from '@nevis/core'
import { createEditor } from '@nevis/editor'
import { IdbStore } from '@nevis/store-idb'
import { formatHlc, uuidv7 } from '@nevis/protocol'
import * as Y from 'yjs'

const DB = 'nevis-bench'
const WORDS = ['سلام', 'دنیا', 'یادداشت', 'برنامه', 'نوشتن', 'همگام', 'سازی', 'hello', 'sync', 'ویرایش', 'صفحه', 'متن', 'کتاب', 'پروژه', 'فردا', 'امروز']
const rnd = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const sentence = (r: () => number, n: number) => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ')

function bodyState(r: () => number, paragraphs: number): Uint8Array {
  const y = new Y.Doc()
  y.transact(() => {
    const frag = y.getXmlFragment('body')
    for (let i = 0; i < paragraphs; i++) {
      const p = new Y.XmlElement('paragraph'); p.setAttribute('dir', 'auto'); p.setAttribute('blockId', uuidv7())
      const t = new Y.XmlText(); p.insert(0, [t]); frag.insert(i, [p]); t.insert(0, sentence(r, 12))
    }
  })
  return Y.encodeStateAsUpdate(y)
}

async function seed(n: number) {
  await new Promise<void>(res => { const q = indexedDB.deleteDatabase(DB); q.onsuccess = q.onerror = q.onblocked = () => res() })
  const store = new IdbStore({ name: DB })
  const r = rnd(1)
  const dev = uuidv7()
  const t0 = performance.now()
  const ids: string[] = []
  let ctr = 0
  const hlc = () => formatHlc({ ms: 1_700_000_000_000 + ctr++, counter: 0 }, dev)
  const roots = Math.max(1, Math.round(n / 200))
  for (let from = 0; from < n; from += 500) {
    await store.run(async tx => {
      for (let i = from; i < Math.min(n, from + 500); i++) {
        const id = uuidv7(); ids.push(id)
        // tree: 1 root per 200 pages; then 20 children each; then ~9 grandchildren each
        const parent = i < roots ? '' : i < roots * 20 ? ids[i % roots]! : ids[roots + ((i - roots * 20) % (roots * 19))]!
        const h = hlc()
        for (const [f, v] of [['$kind', 'page'], ['title', sentence(r, 3)], ['parent', parent], ['sortKey', 'a' + String(i).padStart(6, '0') + 'Ab1x'], ['trashed', false], ['kind', 'doc'], ['createdAt', 1_700_000_000_000 + i]] as const) await tx.putFieldIfNewer(id, f, JSON.stringify(v), h)
      }
    })
  }
  const withBody = ids.filter((_, i) => i % Math.max(1, Math.floor(n / 300)) === 0)
  for (let from = 0; from < withBody.length; from += 50) {
    await store.run(async tx => { for (const id of withBody.slice(from, from + 50)) await tx.putDocState(id, bodyState(r, 100), 1) })
  }
  const bytes = (await navigator.storage?.estimate?.())?.usage ?? null
  return { pages: n, bodies: withBody.length, ms: Math.round(performance.now() - t0), usageMB: bytes ? Math.round(bytes / 1048576) : null, withBody }
}

async function cold() {
  const marks: Record<string, number> = { start: performance.now() }
  const store = new IdbStore({ name: DB })
  await store.run(async tx => { await tx.getMeta('deviceId') }) // opens the database
  marks.open = performance.now()
  const rows = await readPages(store)
  marks.read = performance.now()
  const tree = buildTree(rows)
  marks.tree = performance.now()
  const list = document.getElementById('list')!
  list.replaceChildren(...tree.roots.map(n => { const li = document.createElement('div'); li.textContent = n.page.title; return li }))
  await new Promise(r => requestAnimationFrame(() => r(null)))
  marks.render = performance.now()
  const sinceNav = Math.round(performance.now())
  return { pages: rows.length, roots: tree.roots.length, openDbMs: Math.round(marks.open! - marks.start!), bulkReadAndProjectMs: Math.round(marks.read! - marks.open!), treeMs: Math.round(marks.tree! - marks.read!), renderMs: Math.round(marks.render! - marks.tree!), usableSinceNavigationMs: sinceNav }
}

async function open(ids: string[], times: number) {
  const store = new IdbStore({ name: DB })
  const client = new Client({ store, ws: uuidv7(), device: uuidv7(), sv: 1 })
  const el = document.getElementById('editor')!
  const out: number[] = []
  for (let i = 0; i < times; i++) {
    const id = ids[(i * 7) % ids.length]!
    const t0 = performance.now()
    const h = await DocHandle.open({ client, doc: id })
    const ed = createEditor(h.ydoc, el)
    await new Promise(r => requestAnimationFrame(() => r(null)))
    out.push(performance.now() - t0)
    if (ed.getText().length < 100) throw new Error('the page did not render')
    ed.destroy(); await h.close()
  }
  out.sort((a, b) => a - b)
  return { runs: times, medianMs: Math.round(out[Math.floor(out.length / 2)]!), p95Ms: Math.round(out[Math.floor(out.length * 0.95)]!), maxMs: Math.round(out[out.length - 1]!), firstMs: Math.round(out[0]!) }
}

;(window as unknown as { __bench: unknown }).__bench = { seed, cold, open }
