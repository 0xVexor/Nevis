import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { b64urlEncode, encodeEnvelope, encodeYUpdate, formatHlc, uuidv7, type Envelope, SV } from '@nevis/protocol'
import { COMPACT_AFTER, Client, DocHandle, MemoryStore, REMOTE, applyEnvelope, loadDoc } from '../src'

/** A manual clock: timers fire only when the test says time has passed. */
function clock() {
  let now = 0
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  return {
    schedule: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false } },
    async advance(ms: number) { const to = now + ms; for (;;) { const t = timers.filter(x => x.live && x.at <= to).sort((a, b) => a.at - b.at)[0]; if (!t) break; now = t.at; t.live = false; t.fn(); await new Promise(r => setTimeout(r, 0)) } now = to },
  }
}
const type = (y: Y.Doc, text: string) => y.transact(() => {
  const frag = y.getXmlFragment('body')
  const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText(); p.insert(0, [t]); frag.insert(frag.length, [p]); t.insert(0, text)
})
const body = (y: Y.Doc) => y.getXmlFragment('body').toString()
const setup = () => { const store = new MemoryStore(); const ws = uuidv7(); const client = new Client({ store, ws, device: uuidv7(), sv: SV }); return { store, ws, client, doc: uuidv7() } }

describe('DocHandle', () => {
  it('writes local edits as ONE merged update per throttle window, even when typing never pauses', async () => {
    const { client, doc, store } = setup(); const c = clock(); const wrote: string[] = []
    const h = await DocHandle.open({ client, doc, schedule: c.schedule, onLocalWrite: d => wrote.push(d) })
    for (let i = 0; i < 20; i++) { type(h.ydoc, 'x' + i); await c.advance(100) } // 2 s of continuous typing
    expect(wrote.length).toBeGreaterThanOrEqual(5) // a debounce would have written nothing until the typing stopped
    await h.flush()
    expect((await store.run(tx => tx.listOutbox(1000))).length).toBe(wrote.length) // one outbox row per write, written with it
    expect(body(await store.run(tx => loadDoc(tx, doc)))).toBe(body(h.ydoc))
  })

  it('flush() writes at once, and closing writes what is left', async () => {
    const { client, doc, store } = setup(); const c = clock()
    const h = await DocHandle.open({ client, doc, schedule: c.schedule })
    type(h.ydoc, 'سلام')
    expect(h.unsaved).toBe(1)
    await h.close()
    expect(body(await store.run(tx => loadDoc(tx, doc)))).toContain('سلام')
    expect((await store.run(tx => tx.listOutbox(10))).length).toBe(1)
  })

  it('what comes from the store reaches the editor but never the outbox, and undo ignores it', async () => {
    const a = setup(); const c = clock()
    const h = await DocHandle.open({ client: a.client, doc: a.doc, schedule: c.schedule })
    const undo = new Y.UndoManager(h.ydoc.getXmlFragment('body'), { trackedOrigins: new Set([null]) })
    type(h.ydoc, 'mine')
    // another device's update arrives through the store
    const other = new Y.Doc(); Y.applyUpdate(other, Y.encodeStateAsUpdate(h.ydoc)); type(other, 'theirs')
    const remote = Y.encodeStateAsUpdate(other, Y.encodeStateVector(h.ydoc))
    await a.store.run(async tx => { await tx.appendDocUpdate(a.doc, remote) })
    expect(await h.refresh()).toBe(true)
    expect(body(h.ydoc)).toContain('theirs')
    await h.flush()
    expect((await a.store.run(tx => tx.listOutbox(10))).length).toBe(1) // only "mine" was sent
    undo.undo()
    expect(body(h.ydoc)).toContain('theirs') // undo took back my edit only
    expect(body(h.ydoc)).not.toContain('mine')
    expect(await h.refresh()).toBe(false) // nothing new
  })

  it('a second handle (another tab) sees the first one\'s flushed edit after refresh()', async () => {
    const a = setup()
    const h1 = await DocHandle.open({ client: a.client, doc: a.doc }), h2 = await DocHandle.open({ client: a.client, doc: a.doc })
    type(h1.ydoc, 'از تب اول'); await h1.flush()
    expect(body(h2.ydoc)).toBe('')
    await h2.refresh()
    expect(body(h2.ydoc)).toBe(body(h1.ydoc))
    await h1.close(); await h2.close()
  })

  it('a document with changes from a newer schema (SV + 1) is not opened for editing', async () => {
    const a = setup()
    const peer = new Y.Doc(); type(peer, 'from the future')
    const e: Envelope = { v: 1, op: uuidv7(), ws: a.ws, doc: a.doc, dev: uuidv7(), t: formatHlc({ ms: 5, counter: 0 }, uuidv7()), sv: SV + 1, kid: 0, p: b64urlEncode(encodeYUpdate(Y.encodeStateAsUpdate(peer))) }
    expect(await a.store.run(tx => applyEnvelope(tx, JSON.parse(encodeEnvelope(e)) as Envelope, { device: a.client.device, sv: SV, now: 10 }))).toBe('held')
    const h = await DocHandle.open({ client: a.client, doc: a.doc })
    expect(h.needsUpdate).toBe(true)
    type(h.ydoc, 'must not be written')
    await h.flush()
    expect((await a.store.run(tx => tx.listOutbox(10))).length).toBe(0)
  })

  it('after 500 edits the local tail stays short and the text is unchanged (compaction)', async () => {
    const a = setup()
    const h = await DocHandle.open({ client: a.client, doc: a.doc })
    for (let i = 0; i < 500; i++) { type(h.ydoc, 'k' + i); await h.flush() }
    const rows = await a.store.run(tx => tx.listDocUpdates(a.doc))
    expect(rows.length).toBeLessThanOrEqual(COMPACT_AFTER)
    expect(rows.length).toBeLessThanOrEqual(200)
    const rebuilt = await a.store.run(tx => loadDoc(tx, a.doc))
    expect(body(rebuilt)).toBe(body(h.ydoc))
    expect((await a.store.run(tx => tx.listOutbox(1000))).length).toBe(500) // compaction never touches what still has to be sent
    const fresh = await DocHandle.open({ client: a.client, doc: a.doc })
    expect(body(fresh.ydoc)).toBe(body(h.ydoc))
  })

  it('REMOTE is the origin the handle skips', () => { expect(typeof REMOTE).toBe('symbol') })
})
