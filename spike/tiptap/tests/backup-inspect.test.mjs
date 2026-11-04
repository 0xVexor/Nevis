import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inspectBackup } from '../src/backup/inspect.ts'
import { BackupError } from '../src/backup/format.ts'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const page = (id, extra = {}) => ({ id, title: id, parentId: null, content: { type: 'doc', content: [] }, ...extra })
const image = (bytes) => ({ id: sha(Buffer.from(bytes)), type: 'image/png', name: 'a.png', size: bytes.length, data: Buffer.from(bytes).toString('base64') })

const v1 = (over = {}) => ({ format: 'notes-backup', version: 1, createdAt: '2026-11-01T10:00:00.000Z', pages: [page('a'), page('f', { kind: 'folder' }), page('b', { parentId: 'f', deletedAt: 5 })], files: [image([1, 2, 3])], ...over })

const v2 = (over = {}) => {
  const base = v1()
  const stores = ['pages', 'versions', 'kv', 'db_records', 'db_history', 'db_meta', 'db_ops']
  const records = Object.fromEntries(stores.map((s) => [s, []]))
  records.pages = base.pages.map((p) => ({ key: p.id, value: p }))
  const recordsHash = sha(Buffer.from(JSON.stringify(records)))
  return { ...base, version: 2, records, recordsHash, ...over }
}

const reject = (data, text) => assert.rejects(() => inspectBackup(typeof data === 'string' ? data : JSON.stringify(data)), (e) => e instanceof BackupError && (!text || e.message.length > 0))

test('a v1 backup is summarised without being applied', async () => {
  const plan = await inspectBackup(JSON.stringify(v1()))
  assert.deepEqual({ ...plan.summary, bytes: 0 }, { kind: 'web', version: 1, createdAt: Date.parse('2026-11-01T10:00:00.000Z'), pages: 2, folders: 1, trashed: 1, files: 1, bytes: 0 })
  assert.equal(plan.prepared.length, 1)
  assert.equal(plan.prepared[0].blob.size, 3)
})

test('a v2 backup passes when its records match their hash', async () => {
  const plan = await inspectBackup(JSON.stringify(v2()))
  assert.equal(plan.summary.version, 2)
  assert.equal(plan.summary.pages, 2)
})

test('files that are not backups are refused with a message', async () => {
  await reject('{ not json')
  await reject({ format: 'something-else', version: 1, pages: [], files: [] })
  await reject({ ...v1(), version: 9 })
})

test('a damaged backup is refused before anything could be written', async () => {
  await reject(v1({ pages: [page('a'), page('a')] })) // duplicate id
  await reject(v1({ pages: [page('b', { parentId: 'gone' })] })) // missing parent
  await reject(v1({ files: [{ ...image([1, 2, 3]), size: 9 }] })) // wrong size
  await reject(v1({ files: [{ ...image([1, 2, 3]), data: Buffer.from([9, 9, 9]).toString('base64') }] })) // bytes do not match the id
  const bad = v2()
  bad.records.pages[0].value = { ...bad.records.pages[0].value, title: 'changed' }
  await reject(bad) // records no longer match their hash
})

test('a desktop vault backup is summarised from its entries', async () => {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64')
  const data = { format: 'nevis-vault-backup', version: 2, name: 'My notes', created_at: 1793512537801, entries: {
    'pages/a.json': { data: enc(page('a')), sha256: 'x' },
    'pages/f.json': { data: enc(page('f', { kind: 'folder' })), sha256: 'x' },
    'pages/t.json': { data: enc(page('t', { deletedAt: 1 })), sha256: 'x' },
    'files/ab/abcdef': { data: 'AAAA', sha256: 'x' },
    'files/ab/abcdef.json': { data: enc({}), sha256: 'x' },
  } }
  const plan = await inspectBackup(JSON.stringify(data))
  assert.deepEqual({ ...plan.summary, bytes: 0 }, { kind: 'vault', version: 2, createdAt: 1793512537801, name: 'My notes', pages: 2, folders: 1, trashed: 1, files: 1, bytes: 0 })
  const legacy = await inspectBackup(JSON.stringify({ ...data, format: 'noviq-vault-backup' }))
  assert.deepEqual({ ...legacy.summary, bytes: 0 }, { ...plan.summary, bytes: 0 })
})
