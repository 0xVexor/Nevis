// Ported from imageUrl.test.mjs, plus the rule for what may be STORED in an image node.
import { describe, expect, it } from 'vitest'
import { isBlockedHttpUrl, safeImageSrc } from '../src/imageUrl'

describe('image addresses', () => {
  it('http addresses from the internet are blocked', () => {
    expect(isBlockedHttpUrl('http://example.com/a.png')).toBe(true)
    expect(isBlockedHttpUrl('HTTP://example.com/a.png')).toBe(true)
    expect(isBlockedHttpUrl('http://localhost.evil.com/a.png')).toBe(true)
  })
  it('https, local http and other forms are left to the normal path', () => {
    for (const ok of ['https://example.com/a.png', 'http://localhost:3000/a.png', 'http://127.0.0.1/a.png', 'data:image/png;base64,AAAA', 'not a url']) expect(isBlockedHttpUrl(ok), ok).toBe(false)
  })
  it('only an https URL is ever stored; data:, http, javascript: and junk become a placeholder', () => {
    expect(safeImageSrc('https://example.com/a.png?x=1')).toBe('https://example.com/a.png?x=1')
    for (const bad of ['data:image/png;base64,AAAA', 'http://example.com/a.png', 'javascript:alert(1)', 'java\tscript:alert(1)', 'blob:https://a/b', '/relative.png', '', 'not a url']) expect(safeImageSrc(bad), bad).toBe('')
  })
})
