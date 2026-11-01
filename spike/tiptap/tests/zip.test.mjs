import test from 'node:test'
import assert from 'node:assert/strict'
import { makeZipBytes, readZip } from '../src/zip.ts'

test('readZip returns what makeZipBytes wrote, including UTF-8 names', async () => {
  const enc = new TextEncoder()
  const entries = [
    { path: 'پوشه/صفحه.md', data: enc.encode('# سلام') },
    { path: 'assets/a.png', data: new Uint8Array([0, 1, 2, 255]) },
  ]
  const bytes = makeZipBytes(entries)
  const back = await readZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  assert.deepEqual(back.map((e) => e.path), entries.map((e) => e.path))
  assert.deepEqual(back.map((e) => [...e.data]), entries.map((e) => [...e.data]))
})

test('readZip rejects a file that is not a zip', async () => {
  await assert.rejects(() => readZip(new TextEncoder().encode('{"format":"notes-backup"}').buffer))
})
