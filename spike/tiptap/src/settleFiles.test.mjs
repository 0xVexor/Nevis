import assert from 'node:assert/strict'
import test from 'node:test'
import { settleFiles } from './settleFiles.ts'

test('a file that cannot be read is counted and skipped; the others are kept in order', async () => {
  const r = await settleFiles(['a', 'b', 'c'], async (id) => {
    if (id === 'b') throw new Error('no such file')
    return { id }
  })
  assert.deepEqual(r, { files: [{ id: 'a' }, { id: 'c' }], missing: 1 })
})

test('nothing missing reports zero', async () => {
  assert.deepEqual(await settleFiles([1], async (n) => n), { files: [1], missing: 0 })
})
