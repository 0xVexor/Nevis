import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { slashPreview } from '../src/editor/slashPreview.ts'

// every command of the "/" menu, read from the source so a new command without a drawing is noticed here
const source = readFileSync(new URL('../src/editor/slash.ts', import.meta.url), 'utf8')
const titles = [...source.matchAll(/^\s{2}\{\s*title: '([^']+)'/gm)].map((m) => m[1])

test('every "/" command has a preview drawing', () => {
  assert.ok(titles.length > 20)
  const missing = titles.filter((title) => !slashPreview(title))
  assert.deepEqual(missing, [])
})

test('previews are plain SVG that use design tokens, no literal colors', () => {
  for (const title of titles) {
    const art = slashPreview(title)
    assert.match(art, /^<svg viewBox="0 0 200 120"/)
    assert.doesNotMatch(art, /#[0-9a-f]{3,8}\b/i, title)
    assert.doesNotMatch(art, /<script|onerror|onload/i, title)
  }
})

test('code commands show their language', () => {
  assert.match(slashPreview('Code {name}', 'Python'), />Python</)
})
