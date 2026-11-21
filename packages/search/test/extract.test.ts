import { describe, expect, it } from 'vitest'
import { extractPage, type PMNode } from '../src'

const p = (...c: PMNode[]): PMNode => ({ type: 'paragraph', attrs: { blockId: 'b1' }, content: c })
const t = (text: string): PMNode => ({ type: 'text', text })

describe('extractPage', () => {
  it('collects text, links and tasks', () => {
    const doc: PMNode = { type: 'doc', content: [
      p(t('سلام '), { type: 'pageLink', attrs: { dstId: 'X', label: 'صفحهٔ ایکس' } }),
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { blockId: 't1', checked: true, due: '2026-01-02' }, content: [p(t('کار یک'))] }, { type: 'taskItem', attrs: { blockId: 't2', checked: false, due: '' }, content: [p(t('کار دو'))] }] },
      { type: 'mathBlock', attrs: { latex: 'E=mc^2' } },
      { type: 'file', attrs: { name: 'گزارش.pdf' } },
    ] }
    const r = extractPage(doc)
    expect(r.text).toContain('سلام صفحهٔ ایکس')
    expect(r.text).toContain('کار یک'); expect(r.text).toContain('E=mc^2'); expect(r.text).toContain('گزارش.pdf')
    expect(r.links).toEqual([{ dst: 'X', blockId: 'b1' }])
    expect(r.tasks).toEqual([{ blockId: 't1', text: 'کار یک', checked: true, due: '2026-01-02' }, { blockId: 't2', text: 'کار دو', checked: false, due: '' }])
  })
  it('an empty page is empty', () => expect(extractPage({ type: 'doc' })).toEqual({ text: '', links: [], tasks: [] }))
})
