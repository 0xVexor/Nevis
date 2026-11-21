import { describe, expect, it } from 'vitest'
import { isSafeHref } from '../src'

describe('links from other devices are untrusted', () => {
  it('only http, https, mailto and tel are allowed', () => {
    for (const ok of ['https://example.com/a?b=1#c', 'http://localhost:3000', 'mailto:a@b.co', 'tel:+98123']) expect(isSafeHref(ok), ok).toBe(true)
  })
  it('javascript:, data:, vbscript:, file:, blob:, relative paths and tab/newline obfuscation are refused', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', '\u0000javascript:x', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://a/b', '/relative', '#hash', '', '   ', '//evil.com'])
      expect(isSafeHref(bad), JSON.stringify(bad)).toBe(false)
  })
})
