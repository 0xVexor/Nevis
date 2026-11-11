import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { assertVerifiedMigrationBackup, verifySavedMigrationBackup } from './verifiedBackup.ts'

const page = { id: 'page', parentId: null, title: 'سلام', content: { type: 'doc', content: [{ type: 'paragraph' }] }, favorite: false, sort: 0, updatedAt: 1, deletedAt: null }
const entry = bytes => ({ data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })
const jsonEntry = value => entry(Buffer.from(JSON.stringify(value)))
function fixture() {
  const attachment = Buffer.from('attachment'), id = createHash('sha256').update(attachment).digest('hex'), path = `files/${id.slice(0, 2)}/${id}`
  const backup = { format: 'nevis-vault-backup', version: 2, entries: {
    '.nevis/vault.json': jsonEntry({ id: 'vault', format: 1 }),
    'pages/page.json': jsonEntry(page),
    [path]: entry(attachment),
    [`${path}.json`]: jsonEntry({ id, size: attachment.length, type: 'text/plain', name: 'a.txt' }),
  } }
  return { backup, id, path }
}
const bytesOf = value => new TextEncoder().encode(JSON.stringify(value))

test('verified readback binds exact pages and attachments to vault identity', async () => {
  const { backup, id } = fixture(), bytes = bytesOf(backup)
  const verified = await verifySavedMigrationBackup('vault', bytes, new Uint8Array(bytes))
  assert.equal(verified.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(verified.attachmentIds, [id])
  assert.doesNotThrow(() => assertVerifiedMigrationBackup(verified, 'vault', [page], [id]))
  assert.throws(() => assertVerifiedMigrationBackup(verified, 'vault', [], [id]), /does not match/)
  assert.throws(() => assertVerifiedMigrationBackup(verified, 'vault', [page], []), /attachments/)
  assert.throws(() => assertVerifiedMigrationBackup({ ...verified }, 'vault', [page], [id]), /verified backup/)
  verified.pages[0].title = 'changed'
  assert.doesNotThrow(() => assertVerifiedMigrationBackup(verified, 'vault', [page], [id]))
})

test('different readback, wrong vault, corrupted entries and unsafe paths fail', async () => {
  const { backup } = fixture(), bytes = bytesOf(backup), changed = new Uint8Array(bytes)
  changed[changed.length - 1] ^= 1
  await assert.rejects(verifySavedMigrationBackup('vault', bytes, changed), /verification failed/)
  await assert.rejects(verifySavedMigrationBackup('other', bytes, bytes), /vault mismatch/)
  const badHash = structuredClone(backup); badHash.entries['pages/page.json'].sha256 = '0'.repeat(64)
  const badBytes = bytesOf(badHash)
  await assert.rejects(verifySavedMigrationBackup('vault', badBytes, badBytes), /entry verification/)
  const traversal = structuredClone(backup); traversal.entries['pages/../secret.json'] = jsonEntry({})
  const unsafe = bytesOf(traversal)
  await assert.rejects(verifySavedMigrationBackup('vault', unsafe, unsafe), /Unsafe backup path/)
})

test('missing attachments and page identity mismatches fail before import', async () => {
  const { backup, path } = fixture()
  delete backup.entries[path]
  const missing = bytesOf(backup)
  await assert.rejects(verifySavedMigrationBackup('vault', missing, missing), /attachment is missing/)
  const other = fixture().backup
  other.entries['pages/page.json'] = jsonEntry({ ...page, id: 'different' })
  const mismatch = bytesOf(other)
  await assert.rejects(verifySavedMigrationBackup('vault', mismatch, mismatch), /page identity/)
})
