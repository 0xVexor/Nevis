import { describe, expect, it } from 'vitest'
import { readColumnWidths, normalize } from '../src'

describe('table widths from untrusted documents', () => {
  it('accepts bounded whole-pixel widths and automatic columns', () => {
    expect(readColumnWidths('[56,180,0,10000]')).toEqual([56,180,0,10000])
  })
  it.each(['', 'null', '{}', '[null]', '[-1]', '[1.5]', '[10001]', '["180"]', '{broken', JSON.stringify(Array(1001).fill(56))])('rejects invalid widths: %s', value => {
    expect(readColumnWidths(value)).toEqual([])
  })
  it('old cells gain an empty scalar default, preserving their spans', () => {
    const node = normalize({ type: 'tableCell', attrs: { colspan: 2, rowspan: 3 }, content: [{ type: 'paragraph' }] })
    expect(node.attrs).toMatchObject({ colspan: 2, rowspan: 3, colwidthJson: '' })
    expect(node.attrs).not.toHaveProperty('colwidth')
  })
})
