import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { Client, MemoryStore } from '@nevis/core'
import { SV, uuidv7 } from '@nevis/protocol'
import { importBundle, legacyToBundle, type LegacyPage } from '../src'

const text = (t: string) => ({ type: 'text', text: t })
const old: LegacyPage[] = [
  { id: 'f1', parentId: null, kind: 'folder', title: 'پوشه', content: null },
  { id: 'p1', parentId: 'f1', title: 'صفحهٔ قدیمی', content: { type: 'doc', content: [
    { type: 'paragraph', content: [text('سلام '), { type: 'pageLink', attrs: { id: 'p2', label: null } }] },
    { type: 'callout', attrs: { emoji: 'warning' }, content: [{ type: 'paragraph', content: [text('هشدار')] }] },
    { type: 'layoutGroup', attrs: { widths: [30, 70], direction: 'rtl' }, content: [{ type: 'layoutColumn', content: [{ type: 'paragraph' }] }, { type: 'layoutColumn', content: [{ type: 'paragraph' }] }] },
    { type: 'image', attrs: { src: 'data:image/png;base64,AAAA', alt: 'x' } },
    { type: 'drawing', attrs: { scene: '{"elements":[]}', preview: 'data:image/png;base64,AAAA' } },
  ] } },
  { id: 'p2', parentId: null, title: 'دوم', content: { type: 'doc', content: [{ type: 'paragraph', content: [text('English')] }] } },
  { id: 'b1', parentId: null, kind: 'board', title: 'بوم', content: {} },
  { id: 'gone', parentId: null, title: 'حذف‌شده', content: {}, deletedAt: 5 },
]

describe('legacy import', () => {
  it('maps the old nodes, reports what was lost and skipped, and the result imports as a bundle', async () => {
    const { zip, report } = await legacyToBundle(old)
    expect(report.pages).toBe(2); expect(report.folders).toBe(1)
    expect(report.skipped.map(s => s.id)).toEqual(['b1'])
    expect(report.lost['image stored inside the page (data: URL)']).toBe(1)
    const files = unzipSync(zip)
    const page = Object.keys(files).filter(k => k.startsWith('pages/')).map(k => strFromU8(files[k]!)).find(s => s.includes('هشدار'))!
    expect(page).toContain('"icon":"warning"') // callout emoji -> icon
    expect(page).toContain('"width":30'); expect(page).toContain('"dir":"rtl"') // layout widths and direction
    expect(page).not.toContain('"preview"'); expect(page).not.toContain('data:image')
    expect(page).not.toContain('null')
    const store = new MemoryStore()
    const r = await importBundle(zip, { client: new Client({ store, ws: uuidv7(), device: uuidv7(), sv: SV }), store })
    expect(r.pages).toBe(2); expect(r.entities).toBe(3) // the folder and two pages; the deleted page and the board are not in
  })
})
