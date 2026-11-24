import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Client, MemoryBlobStore, MemoryStore, createPage, sha256Hex } from '@nevis/core'
import { SV, uuidv7 } from '@nevis/protocol'
import { writeBody, type PMJson } from '@nevis/schema'
import { BundleError, comparable, exportBundle, importBundle } from '../src'
import { zipSync, strToU8 } from 'fflate'

const doc = (text: string, extra: PMJson[] = []): PMJson => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: uuidv7() }, content: [{ type: 'text', text }] }, ...extra] })

async function workspace() {
  const store = new MemoryStore(), blobs = new MemoryBlobStore()
  const client = new Client({ store, ws: uuidv7(), device: uuidv7(), sv: SV })
  return { store, blobs, client }
}
const source = (w: Awaited<ReturnType<typeof workspace>>) => ({ store: w.store, workspace: { id: 'w', name: 'n' }, sv: SV, blob: async (h: string) => { const d = await w.blobs.get(h); return d ? { data: d, mime: (await w.blobs.meta(h))!.mime } : undefined } })

async function seeded() {
  const w = await workspace()
  const a = { id: await createPage(w.client, { parent: '', title: 'صفحهٔ اول', before: null }) }
  const b = { id: await createPage(w.client, { parent: a.id, title: 'زیرصفحه', before: null }) }
  const bytes = new Uint8Array(5000).map((_, i) => (i * 7) & 255)
  const hash = await sha256Hex(bytes)
  await w.blobs.put(hash, new Blob([bytes]), 'image/png')
  for (const [id, text, extra] of [[a.id, 'سلام دنیا', [{ type: 'image', attrs: { blockId: uuidv7(), blob: hash, mime: 'image/png', size: 5000, alt: 'عکس' } } as PMJson]], [b.id, 'English text', []]] as const) {
    const y = new Y.Doc(); writeBody(y, doc(text, [...extra])); await w.client.writeYUpdate(id, Y.encodeStateAsUpdate(y))
  }
  await w.client.addEvent(a.id, 'review', { card: a.id, rating: 2, reviewedAt: 1000, durationMs: 5 })
  await w.client.addEvent(a.id, 'version', { at: 2000, manual: true, label: 'x', json: '{}' })
  return { w, a, b, hash }
}

describe('bundle round trip (ADR-0009)', () => {
  it('export -> import into a fresh workspace -> export gives the same files (except exportedAt, workspace, app)', async () => {
    const { w } = await seeded()
    const one = await exportBundle(source(w))
    const fresh = await workspace()
    const r = await importBundle(one, { client: fresh.client, store: fresh.store, blobs: fresh.blobs })
    expect(r).toMatchObject({ entities: 2, pages: 2, events: 2, attachments: 1 })
    const two = await exportBundle(source(fresh))
    const [x, y] = [comparable(one), comparable(two)]
    expect(Object.keys(y).sort()).toEqual(Object.keys(x).sort())
    for (const k of Object.keys(x)) expect(y[k], k).toBe(x[k])
    expect(x['attachments.ndjson']).toContain('image/png')
  })
  it('refuses a damaged bundle, a foreign zip, and a workspace that already has the entities', async () => {
    const { w } = await seeded()
    const zip = await exportBundle(source(w))
    const fresh = await workspace()
    await expect(importBundle(strToU8('nope'), { client: fresh.client, store: fresh.store })).rejects.toBeInstanceOf(BundleError)
    await expect(importBundle(zipSync({ 'a.txt': strToU8('x') }), { client: fresh.client, store: fresh.store })).rejects.toThrow(/manifest/)
    await importBundle(zip, { client: fresh.client, store: fresh.store, blobs: fresh.blobs })
    await expect(importBundle(zip, { client: fresh.client, store: fresh.store, blobs: fresh.blobs })).rejects.toThrow(/already has/)
    const { unzipSync, zipSync: z } = await import('fflate')
    const files = unzipSync(zip); files['pages/' + Object.keys(files).find(k => k.startsWith('pages/'))!.slice(6)] = strToU8('{"type":"doc"}')
    await expect(importBundle(z(files), { client: (await workspace()).client, store: (await workspace()).store })).rejects.toThrow(/damaged/)
  })
  it('rejects unverified pages and missing attachment bytes before importing', async () => {
    const { w, hash } = await seeded()
    const zip = await exportBundle(source(w))
    const { unzipSync } = await import('fflate')
    const extra = unzipSync(zip)
    extra['pages/extra.json'] = strToU8('{"type":"doc"}')
    const first = await workspace()
    await expect(importBundle(zipSync(extra), first)).rejects.toThrow(/unverified file/)
    const missing = unzipSync(zip)
    delete missing[`attachments/${hash}`]
    const second = await workspace()
    await expect(importBundle(zipSync(missing), second)).rejects.toThrow(/missing attachment/)
    expect(await second.store.run(tx => tx.entities())).toHaveLength(0)
  })
  it('lists an attachment it could not read instead of writing bytes under a wrong name', async () => {
    const { w, hash } = await seeded()
    const zip = await exportBundle({ ...source(w), blob: async () => undefined })
    const { unzipSync, strFromU8 } = await import('fflate')
    const m = JSON.parse(strFromU8(unzipSync(zip)['manifest.json']!))
    expect(m.missingAttachments).toEqual([hash])
    expect(m.counts.attachments).toBe(0)
  })
})
