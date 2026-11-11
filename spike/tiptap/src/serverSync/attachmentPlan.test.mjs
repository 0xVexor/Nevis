import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { planBackupAttachments } from './attachmentPlan.ts'
import { verifySavedMigrationBackup } from './verifiedBackup.ts'

async function fixture(pages, assets) {
  const entry = bytes => ({ data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })
  const json = value => entry(Buffer.from(JSON.stringify(value)))
  const entries = { '.nevis/vault.json': json({ id: 'vault' }) }
  for (const page of pages) entries[`pages/${page.id}.json`] = json(page)
  for (const asset of assets) {
    const hash = createHash('sha256').update(asset).digest('hex'), path = `files/${hash.slice(0, 2)}/${hash}`
    entries[path] = entry(asset); entries[`${path}.json`] = json({ id: hash, size: asset.length })
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 'nevis-vault-backup', version: 2, entries }))
  return verifySavedMigrationBackup('vault', bytes, bytes)
}
const makePage = (id, content) => ({ id, parentId: null, title: id, content, favorite: false, sort: 0, updatedAt: 1, deletedAt: null })

test('shared image and drawing references are mapped to every relevant document', async () => {
  const shared = Buffer.from('shared'), orphan = Buffer.from('orphan')
  const hash = createHash('sha256').update(shared).digest('hex'), orphanHash = createHash('sha256').update(orphan).digest('hex')
  const pages = [
    makePage('a', { type: 'doc', content: [{ type: 'image', attrs: { src: `att:${hash}` } }] }),
    { ...makePage('b', { type: 'doc', content: [{ type: 'drawing', attrs: { scene: hash, preview: hash } }] }), cover: { kind: 'image', file: hash } },
  ]
  const backup = await fixture(pages, [shared, orphan])
  assert.deepEqual(planBackupAttachments(backup, 'vault', pages), {
    references: [{ documentId: 'a', sha256: hash }, { documentId: 'b', sha256: hash }], unreferenced: [orphanHash], unsupportedDocuments: [],
  })
})

test('missing files fail and database-backed documents are surfaced', async () => {
  const hash = 'a'.repeat(64), page = makePage('a', { type: 'doc', content: [{ type: 'image', attrs: { src: `att:${hash}` } }] })
  const backup = await fixture([page], [])
  assert.throws(() => planBackupAttachments(backup, 'vault', [page]), /missing attachment/)
  const database = { ...makePage('db', { type: 'doc', content: [] }), dbHost: 'container' }
  const dbBackup = await fixture([database], [])
  assert.deepEqual(planBackupAttachments(dbBackup, 'vault', [database]).unsupportedDocuments, ['db'])
})
