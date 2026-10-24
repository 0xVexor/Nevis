// Builds a zip with the app's writer and checks it with the system's own tool (Windows bsdtar).
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

// Node 22.18+/24 strips TypeScript types natively, so the app's module is tested as-is.
const { makeZipBytes } = await import('../spike/tiptap/src/zip.ts')

const TAR = 'C:/Windows/System32/tar.exe'
const enc = new TextEncoder()
const entries = [
  { path: 'درس جاوا.md', data: enc.encode('# درس جاوا\n\nسلام دنیا\n') },
  { path: 'درس جاوا/وراثت.md', data: enc.encode('# وراثت\n') },
  { path: 'assets/abc.png', data: Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 255) },
  { path: 'empty.md', data: new Uint8Array(0) },
]
const dir = new URL('./zip-test/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir + 'out', { recursive: true })
writeFileSync(dir + 'test.zip', makeZipBytes(entries))

const count = execFileSync(TAR, ['-tf', dir + 'test.zip'], { encoding: 'utf8' }).split('\n').filter((l) => l.trim()).length
assert.equal(count, 4, 'tar sees all four entries')
execFileSync(TAR, ['-xf', dir + 'test.zip', '-C', dir + 'out'])
assert.deepEqual(readdirSync(dir + 'out/درس جاوا'), ['وراثت.md'], 'UTF-8 (Persian) folder and file names survive')
assert.equal(readFileSync(dir + 'out/درس جاوا.md', 'utf8'), '# درس جاوا\n\nسلام دنیا\n')
assert.deepEqual(new Uint8Array(readFileSync(dir + 'out/assets/abc.png')), entries[2].data, 'binary content and CRC accepted on extract')
assert.equal(readFileSync(dir + 'out/empty.md').length, 0)
rmSync(dir, { recursive: true, force: true })
console.log('zip OK — extracted by system tar, UTF-8 names and binary data intact')
