import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { assertSameImport, buildImportManifest } from './importManifest.ts'

test('manifest is stable across input ordering and fingerprints the retained bytes', async () => {
  const first = new Uint8Array([1, 2, 3]), second = new Uint8Array([4, 5])
  const documents = [{ id: 'z', initialUpdate: first }, { id: 'A', initialUpdate: second }]
  const attachments = [{ id: 'z_asset', sha256: 'a'.repeat(64) }, { id: 'A_asset', sha256: 'b'.repeat(64) }]
  const plan = await buildImportManifest(documents, attachments)
  assert.deepEqual(plan, await buildImportManifest([...documents].reverse(), [...attachments].reverse()))
  assert.deepEqual(plan.documents, ['A', 'z'])
  assert.deepEqual(plan.attachments, ['A_asset', 'z_asset'])
  assert.equal(plan.fingerprints.z, createHash('sha256').update(first).digest('hex'))
  assert.doesNotThrow(() => assertSameImport(plan, { ...plan, archive_id: '' }))
  assert.throws(() => assertSameImport(plan, { ...plan, documents: [...plan.documents].reverse() }), /mismatch/)
})

test('duplicate identities or invalid hashes cannot enter a manifest', async () => {
  const doc = { id: 'page', initialUpdate: new Uint8Array([1]) }
  await assert.rejects(buildImportManifest([doc, doc], []), /Duplicate/)
  await assert.rejects(buildImportManifest([doc], [{ id: 'asset', sha256: 'invalid' }]), /fingerprint/)
  await assert.rejects(buildImportManifest([doc], [{ id: 'asset', sha256: 'a'.repeat(64) }], { id: 'asset', sha256: 'a'.repeat(64) }), /Duplicate/)
})
