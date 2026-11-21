import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Client, MemoryBlobStore, MemoryStore, createPage } from '@nevis/core'
import { SV, uuidv7 } from '@nevis/protocol'
import { writeBody, type PMJson } from '@nevis/schema'
import { exportBundle, importBundle } from '../src'

// ROADMAP M12: ingest of 10 000 pages in under 60 s. (MemoryStore: the CPU cost of unzip, validate, build 10 000 Y.Docs and write 20 000 ops;
// the browser's IndexedDB adds its own write time, measured by the owner's checklist.)
describe('ingest', () => {
  it('10 000 pages: export and import', { timeout: 300_000 }, async () => {
    const a = new MemoryStore()
    const ca = new Client({ store: a, ws: uuidv7(), device: uuidv7(), sv: SV })
    const para = (t: string): PMJson => ({ type: 'paragraph', attrs: { blockId: uuidv7() }, content: [{ type: 'text', text: t }] })
    for (let i = 0; i < 10_000; i++) {
      const id = await createPage(ca, { title: `صفحه ${i}`, parent: '' })
      const y = new Y.Doc(); writeBody(y, { type: 'doc', content: [para(`متن شمارهٔ ${i} با چند کلمهٔ فارسی و some English words`), para('پاراگراف دوم')] })
      await ca.writeYUpdate(id, Y.encodeStateAsUpdate(y))
    }
    let t = performance.now()
    const zip = await exportBundle({ store: a, workspace: { id: 'w', name: 'n' }, sv: SV, blob: async () => undefined })
    const exportS = (performance.now() - t) / 1000
    const b = new MemoryStore()
    t = performance.now()
    const r = await importBundle(zip, { client: new Client({ store: b, ws: uuidv7(), device: uuidv7(), sv: SV }), store: b, blobs: new MemoryBlobStore() })
    const importS = (performance.now() - t) / 1000
    console.log(`10 000 pages: export ${exportS.toFixed(1)} s, import ${importS.toFixed(1)} s, zip ${(zip.length / 1048576).toFixed(1)} MB`)
    expect(r.pages).toBe(10_000)
    expect(importS).toBeLessThan(60)
  })
})
