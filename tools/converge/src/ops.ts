// Random operations on a replica: registers (including set elements), Yjs paragraphs edited through Yjs' own API, events.
import { DocHandle } from '@nevis/core'
import * as Y from 'yjs'
import { int, pick, type Rng } from './rng'
import type { Replica } from './replica'

const FA = ['سلام', 'دنیا', 'می‌خواهم', 'نوشتن', 'کتاب', 'گربه', '۱۲۳', 'برنامه', 'یادداشت']
const EN = ['hello', 'world', 'sync', 'merge', 'Nevis', '42']
const word = (rng: Rng) => (rng() < 0.6 ? pick(rng, FA) : pick(rng, EN))

export interface World { entities: string[]; docs: string[] }

export async function randomOp(rep: Replica, rng: Rng, w: World): Promise<void> {
  const r = rng()
  if (r < 0.5) return setFields(rep, rng, w)
  if (r < 0.88) return yEdit(rep, rng, w)
  return event(rep, rng, w)
}

async function setFields(rep: Replica, rng: Rng, w: World) {
  const ent = pick(rng, w.entities)
  const set: Record<string, any> = {}
  for (let i = 0, n = 1 + int(rng, 3); i < n; i++) {
    const k = rng()
    if (k < 0.3) set.title = `${word(rng)} ${word(rng)}`
    else if (k < 0.5) set.count = int(rng, 1000)
    else if (k < 0.8) set[`tag:${int(rng, 6)}`] = rng() < 0.5 // a set element: one register per element
    else if (k < 0.9) set.cfg = { filter: word(rng), n: int(rng, 9) } // an atomic value
    else set.note = rng() < 0.3 ? null : word(rng) // null = cleared
  }
  const hasKind = await rep.store.run(tx => tx.getField(ent, '$kind'))
  rep.record(await rep.client.setFields(ent, set, hasKind ? undefined : 'page'))
}

async function yEdit(rep: Replica, rng: Rng, w: World) {
  const doc = pick(rng, w.docs)
  // Through the real DocHandle (the one the app uses): open from the store, edit, flush, close. The timer never fires (the
  // test flushes by hand), so a run is reproducible from its seed.
  const h = await DocHandle.open({ client: rep.client, doc, schedule: () => () => {} })
  const y = h.ydoc
  y.clientID = 1 + int(rng, 2 ** 30)
  const frag = y.getXmlFragment('body')
  y.transact(() => {
    const n = frag.length
    const r = rng()
    if (n === 0 || r < 0.2) {
      const p = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, `${word(rng)} ${word(rng)}`)
      p.insert(0, [t])
      frag.insert(int(rng, n + 1), [p])
      return
    }
    const i = int(rng, n)
    if (r < 0.28) { frag.delete(i, 1); return }
    const p = frag.get(i) as Y.XmlElement
    let t = p.get(0) as Y.XmlText | undefined
    if (!(t instanceof Y.XmlText)) { t = new Y.XmlText(); p.insert(0, [t]) }
    if (r < 0.75 || t.length === 0) t.insert(int(rng, t.length + 1), `${word(rng)} `)
    else { const from = int(rng, t.length); t.delete(from, 1 + int(rng, Math.min(5, t.length - from))) }
  })
  const before = h.unsaved
  await h.close() // flush: one transaction with the outbox row, as on pagehide
  if (before) { // the flush wrote ONE op (merged updates): it is the newest outbox row
    const rows = await rep.store.run(tx => tx.listOutbox(1e9))
    rep.record(rows[rows.length - 1]!.op)
  }
}

async function event(rep: Replica, rng: Rng, w: World) {
  rep.record(await rep.client.addEvent(pick(rng, w.entities), 'review', { rating: 1 + int(rng, 4), ms: int(rng, 5000) }))
}
