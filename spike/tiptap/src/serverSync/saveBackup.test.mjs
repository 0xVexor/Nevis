import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createMigrationBackup, reopenMigrationBackup } from './saveBackup.ts'

const entry = value => {
  const bytes = Buffer.from(JSON.stringify(value))
  return { data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
}
const page = { id: 'page', title: 'Note', parentId: null, content: { type: 'doc' }, favorite: false, sort: 0, updatedAt: 1, deletedAt: null }
const bytes = new TextEncoder().encode(JSON.stringify({ format: 'nevis-vault-backup', version: 2, entries: { '.nevis/vault.json': entry({ id: 'vault' }), 'pages/page.json': entry(page) } }))
function platform() {
  const calls = []
  return { calls, active: () => true, vaultId: async () => 'vault', chooseSavePath: async () => 'saved.json', chooseExistingPath: async () => 'saved.json',
    flush: async () => { calls.push('flush') }, saveAndRead: async (path, id) => { calls.push(`save:${path}:${id}`); return bytes }, read: async path => { calls.push(`read:${path}`); return bytes } }
}

test('save flushes first, verifies returned file, and can reopen it', async () => {
  const host = platform(), saved = await createMigrationBackup(host, 'vault')
  assert.deepEqual(host.calls, ['flush', 'save:saved.json:vault'])
  assert.equal(saved.backup.vaultId, 'vault')
  assert.deepEqual(saved.backup.pages, [page])
  const reopened = await reopenMigrationBackup(host, 'vault')
  assert.equal(reopened.backup.sha256, saved.backup.sha256)
  assert.equal(host.calls.at(-1), 'read:saved.json')
})

test('cancel or vault switch never produces a backup proof', async () => {
  const host = platform()
  host.chooseSavePath = async () => null
  assert.equal(await createMigrationBackup(host, 'vault'), null)
  assert.deepEqual(host.calls, [])
  host.chooseSavePath = async () => 'saved.json'
  host.flush = async () => { host.active = () => false }
  await assert.rejects(createMigrationBackup(host, 'vault'), /vault unavailable/)
  assert.deepEqual(host.calls, [])
})

test('a failed write, corrupt readback or wrong vault does not produce a proof', async () => {
  const host = platform()
  host.saveAndRead = async () => { throw new Error('disk full') }
  await assert.rejects(createMigrationBackup(host, 'vault'), /disk full/)
  host.read = async () => new TextEncoder().encode('bad')
  await assert.rejects(reopenMigrationBackup(host, 'vault'), /backup JSON/)
  host.vaultId = async () => 'other'
  await assert.rejects(reopenMigrationBackup(host, 'vault'), /vault unavailable/)
})
