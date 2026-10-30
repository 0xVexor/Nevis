import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { identifyBlocks, BLOCK_TYPES } from '../spike/tiptap/src/documents/blockIdentity.ts'

const types = new Set(BLOCK_TYPES)
const ids = doc => {
  const out = []
  const walk = n => { if (types.has(n.type)) out.push(n.attrs.blockId); n.content?.forEach(walk) }
  walk(doc)
  return out
}
const strip = value => {
  if (Array.isArray(value)) return value.map(strip)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => !['blockId', 'blockIdentityVersion'].includes(k))
    .map(([k, v]) => [k, strip(v)]).filter(([k, v]) => k !== 'attrs' || Object.keys(v).length))
  return value
}

test('legacy corpus migrates deterministically once and round-trips rich attributes', () => {
  const pages = JSON.parse(readFileSync(new URL('./fixtures/agent-documents/pages.json', import.meta.url), 'utf8'))
  for (const page of pages) {
    const before = JSON.stringify(page.content)
    const a = identifyBlocks(page.content)
    assert.deepEqual(a, identifyBlocks(JSON.parse(before)))
    assert.equal(JSON.stringify(page.content), before)
    assert.deepEqual(strip(a.content), strip(page.content))
    assert.equal(new Set(ids(a.content)).size, ids(a.content).length)
    const restart = JSON.parse(JSON.stringify(a.content))
    const next = identifyBlocks(restart)
    assert.equal(next.changed, false)
    assert.equal(next.content, restart)
  }
})

test('moves and text/attribute edits preserve persisted identity independent of paths', () => {
  const original = identifyBlocks({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'heading', attrs: { level: 2 } }] }).content
  const moved = structuredClone(original)
  moved.content.reverse()
  moved.content[0].attrs.dir = 'rtl'
  moved.content[1].content = [{ type: 'text', text: 'سلام' }]
  assert.equal(identifyBlocks(moved).changed, false)
  assert.deepEqual(ids(moved), ids(original).reverse())
})

test('repairs duplicate/invalid IDs without stealing any reserved later identity', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', attrs: { blockId: 'same' } },
    { type: 'paragraph', attrs: { blockId: 'same' } },
    { type: 'paragraph', attrs: { blockId: 'b1_1' } },
    { type: 'paragraph', attrs: { blockId: 12 } },
  ] }
  const result = identifyBlocks(doc).content
  assert.equal(ids(result)[0], 'same')
  assert.equal(ids(result)[2], 'b1_1')
  assert.equal(new Set(ids(result)).size, 4)
  assert.equal(identifyBlocks(result).changed, false)
})

test('copies regenerate every nested block ID and preserve original/link identities', () => {
  let n = 0
  const original = identifyBlocks({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableCell', attrs: { colspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'pageLink', attrs: { id: 'destination' } }] }] },
  ] }] }] }).content
  const copy = identifyBlocks(original, () => `copy_${++n}`).content
  assert.equal(ids(copy).some(id => ids(original).includes(id)), false)
  assert.deepEqual(strip(copy), strip(original))
  assert.throws(() => identifyBlocks(original, () => ids(original)[0]), /allocator/)
})

test('future versions fail without mutation; HTML awaits editor parsing', () => {
  const future = { type: 'doc', attrs: { blockIdentityVersion: 2 }, content: [] }
  assert.throws(() => identifyBlocks(future), /Unsupported/)
  assert.equal(future.attrs.blockIdentityVersion, 2)
  assert.deepEqual(identifyBlocks('<p>legacy</p>'), { content: '<p>legacy</p>', changed: false })
})
