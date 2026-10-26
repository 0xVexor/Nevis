// Fractional sort keys: appending must stay short and ordered (a 100k-row import used to build keys thousands of characters long).
import test from 'node:test'
import assert from 'node:assert/strict'

const { keyBetween, keysBetween } = await import('../../../spike/tiptap/src/database/model/ids.ts')

test('appending 200k keys stays ordered and short', () => {
  let k = null
  let max = 0
  for (let i = 0; i < 200000; i++) {
    const next = keyBetween(k, null)
    if (k !== null) assert.ok(k < next, `${k} < ${next} at ${i}`)
    k = next
    max = Math.max(max, k.length)
  }
  assert.ok(max <= 6, `longest key ${max}`)
})

test('keys can still be inserted between appended keys', () => {
  const ks = keysBetween(null, null, 80)
  for (let i = 0; i < ks.length - 1; i++) {
    const mid = keyBetween(ks[i], ks[i + 1])
    assert.ok(ks[i] < mid && mid < ks[i + 1])
  }
})
