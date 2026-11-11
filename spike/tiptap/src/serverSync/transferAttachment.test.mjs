import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { NevisServerApi, ServerApiError } from './api.ts'
import { ReservationExpiredError, transferBackupAttachment } from './transferAttachment.ts'
import { verifySavedMigrationBackup } from './verifiedBackup.ts'

const scope = { vaultId: 'vault', accountId: 'account', apiOrigin: 'https://api.example', collaborationOrigin: 'https://sync.example' }
async function fixture() {
  const asset = Buffer.from('attachment'), sha256 = createHash('sha256').update(asset).digest('hex')
  const entry = bytes => ({ data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })
  const json = value => entry(Buffer.from(JSON.stringify(value)))
  const path = `files/${sha256.slice(0, 2)}/${sha256}`
  const page = { id: 'page', parentId: null, title: 'Note', content: { type: 'doc' }, favorite: false, sort: 0, updatedAt: 1, deletedAt: null }
  const raw = new TextEncoder().encode(JSON.stringify({ format: 'nevis-vault-backup', version: 2, entries: {
    '.nevis/vault.json': json({ id: 'vault' }), 'pages/page.json': json(page),
    [path]: entry(asset), [`${path}.json`]: json({ id: sha256, size: asset.length }),
  } }))
  return { backup: await verifySavedMigrationBackup('vault', raw, raw), sha256, asset }
}

test('lost upload and completion responses retry the same reservation key', async () => {
  const { backup, sha256, asset } = await fixture()
  let ready = false, uploads = 0, completes = 0
  const keys = []
  const api = {
    async verifyIdentity(origin, id) { assert.equal(origin, scope.apiOrigin); assert.equal(id, scope.accountId) },
    async beginAttachment(doc, hash, size, key) {
      assert.equal(doc, 'page'); assert.equal(hash, sha256); assert.equal(size, asset.length); keys.push(key)
      return ready ? { id: 'asset1', ready: true } : { id: 'asset1', ready: false, uploadUrl: 'https://objects.example/put?signature=x', expiresIn: 60 }
    },
    async completeAttachment() { completes++; ready = true; throw new Error('completion response lost') },
  }
  const send = async (_url, options) => {
    uploads++; assert.deepEqual(Buffer.from(options.body), asset)
    if (uploads === 1) throw new Error('upload response lost')
    return new Response(null, { status: 200 })
  }
  const input = { scope, backup, documentId: 'page', sha256, attempt: 0, api, send }
  await assert.rejects(transferBackupAttachment(input), /upload response lost/)
  await assert.rejects(transferBackupAttachment(input), /completion response lost/)
  assert.deepEqual(await transferBackupAttachment(input), { id: 'asset1', sha256 })
  assert.equal(new Set(keys).size, 1)
  assert.equal(uploads, 2)
  assert.equal(completes, 1)
})

test('expired reservations are not silently replaced and proof is vault-bound', async () => {
  const { backup, sha256 } = await fixture()
  const api = { verifyIdentity: async () => {}, beginAttachment: async () => { throw new ServerApiError(410) }, completeAttachment: async () => {} }
  const input = { scope, backup, documentId: 'page', sha256, attempt: 0, api }
  await assert.rejects(transferBackupAttachment(input), ReservationExpiredError)
  await assert.rejects(transferBackupAttachment({ ...input, scope: { ...scope, vaultId: 'other' } }), /verified backup/)
  await assert.rejects(transferBackupAttachment({ ...input, documentId: 'missing' }), /verified backup/)
  await assert.rejects(transferBackupAttachment({ ...input, sha256: '0'.repeat(64) }), /missing/)
})

test('HTTP client sends a stable key and recognizes the server ready response', async () => {
  const { backup, sha256, asset } = await fixture(), keys = [], token = 'a'.repeat(43)
  let ready = false, uploads = 0
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
  const send = async (url, options) => {
    const parsed = new URL(url)
    if (parsed.hostname === 'objects.example') {
      assert.equal(options.headers, undefined)
      assert.deepEqual(Buffer.from(options.body), asset)
      uploads++
      return new Response(null, { status: 200 })
    }
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    if (parsed.pathname === '/v1/account') return json({ id: 'account' })
    if (parsed.pathname.endsWith('/complete')) { ready = true; return new Response(null, { status: 204 }) }
    if (parsed.pathname.endsWith('/attachments')) {
      keys.push(JSON.parse(options.body).key)
      return ready ? json({ id: 'asset1', ready: true }) : json({ id: 'asset1', upload_url: 'https://objects.example/put?signature=x', expires_in: 60 }, 201)
    }
    throw new Error('Unexpected request')
  }
  const api = new NevisServerApi(scope.apiOrigin, token, send)
  const input = { scope, backup, documentId: 'page', sha256, attempt: 0, api, send }
  await transferBackupAttachment(input)
  await transferBackupAttachment(input)
  assert.equal(keys.length, 2)
  assert.equal(keys[0], keys[1])
  assert.equal(uploads, 1)
})
