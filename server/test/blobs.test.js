import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { blobKey } from '../src/storage.js'
import { call, commit, md5, newVault, register, setup, sha } from './helpers.js'

describe('blobs', () => {
  let s, a, v
  beforeEach(async () => {
    s = await setup()
    a = await register(s)
    v = await newVault(s, a.token)
  })
  afterEach(() => s.close())

  const put = (content, headers = {}, token = a.token) => {
    const buf = Buffer.from(content)
    return call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha(content)}`, { token, body: buf, headers })
  }

  it('stores a blob under its hash, answers HEAD and GET with its md5, and accepts the same blob again', async () => {
    const r = await put('hello world')
    assert.equal(r.status, 201)
    assert.equal(r.body.md5, md5('hello world'))
    assert.equal(await s.storage.has(blobKey(v, sha('hello world'))), true)
    const head = await call(s, 'HEAD', `/v1/vaults/${v}/blobs/${sha('hello world')}`, { token: a.token })
    assert.equal(head.status, 200)
    assert.equal(head.headers['x-md5'], md5('hello world'))
    const get = await call(s, 'GET', `/v1/vaults/${v}/blobs/${sha('hello world')}`, { token: a.token })
    assert.equal(get.raw.toString(), 'hello world')
    assert.equal((await put('hello world')).status, 200)
    assert.equal((await call(s, 'HEAD', `/v1/vaults/${v}/blobs/${sha('nothing')}`, { token: a.token })).status, 404)
  })

  it('refuses bytes that do not match the name they are uploaded under, and stores nothing', async () => {
    const r = await call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha('real')}`, { token: a.token, body: Buffer.from('fake') })
    assert.equal(r.status, 422)
    assert.equal(r.body.error, 'hash_mismatch')
    assert.equal(await s.storage.has(blobKey(v, sha('real'))), false)
    assert.equal((await call(s, 'PUT', `/v1/vaults/${v}/blobs/not-a-hash`, { token: a.token, body: Buffer.from('x') })).status, 400)
  })

  it('takes a blob in pieces, tells how far it got, and survives a piece that is sent again', async () => {
    const content = 'abcdefghij'.repeat(10) // 100 bytes
    const piece = (from, to, c = content) => put(c.slice(from, to), { 'content-range': `bytes ${from}-${to - 1}/${c.length}` }, a.token).then((r) => r)
    const send = (from, to) => call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha(content)}`, { token: a.token, body: Buffer.from(content.slice(from, to)), headers: { 'content-range': `bytes ${from}-${to - 1}/${content.length}` } })
    void piece
    const one = await send(0, 40)
    assert.equal(one.status, 202)
    assert.equal(one.body.received, 40)
    const head = await call(s, 'HEAD', `/v1/vaults/${v}/blobs/${sha(content)}`, { token: a.token })
    assert.equal(head.status, 404)
    assert.equal(head.headers['x-received'], '40')
    const gap = await send(60, 100)
    assert.equal(gap.status, 409)
    assert.equal(gap.body.received, 40)
    assert.equal((await send(0, 40)).status, 202) // the first piece again: the file is cut back and starts over
    assert.equal((await send(40, 70)).status, 202)
    assert.equal((await send(40, 70)).status, 202) // a lost answer: the same piece once more
    const done = await send(70, 100)
    assert.equal(done.status, 201)
    assert.equal(done.body.size, 100)
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/blobs/${sha(content)}`, { token: a.token })).raw.toString(), content)
  })

  it('discards an upload whose pieces add up to the wrong content', async () => {
    const content = 'x'.repeat(50)
    const head = (from, to, body) => call(s, 'PUT', `/v1/vaults/${v}/blobs/${sha(content)}`, { token: a.token, body: Buffer.from(body), headers: { 'content-range': `bytes ${from}-${to - 1}/50` } })
    assert.equal((await head(0, 25, 'x'.repeat(25))).status, 202)
    const bad = await head(25, 50, 'y'.repeat(25))
    assert.equal(bad.status, 422)
    assert.equal((await call(s, 'HEAD', `/v1/vaults/${v}/blobs/${sha(content)}`, { token: a.token })).headers['x-received'], '0')
  })

  it('refuses a blob that is too large or would exceed the quota of the account', async () => {
    await s.close()
    s = await setup({ maxBlobBytes: 100, quotaBytes: 150 })
    a = await register(s)
    v = await newVault(s, a.token)
    assert.equal((await put('x'.repeat(101))).status, 413)
    assert.equal((await put('a'.repeat(80))).status, 201)
    const over = await put('b'.repeat(80))
    assert.equal(over.status, 507)
    assert.equal(over.body.error, 'quota_exceeded')
    const acc = await call(s, 'GET', '/v1/account', { token: a.token })
    assert.equal(acc.body.quota.used, 80)
    assert.equal(acc.body.quota.limit, 150)
  })

  it('does not hand out another vault\'s blobs', async () => {
    await put('secret')
    const b = await register(s, 'bob')
    const w = await newVault(s, b.token, 'bobs')
    assert.equal((await call(s, 'GET', `/v1/vaults/${w}/blobs/${sha('secret')}`, { token: b.token })).status, 404)
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/blobs/${sha('secret')}`, { token: b.token })).status, 404)
  })

  it('the content of a deleted revision is gone from the revision endpoint', async () => {
    const first = await commit(s, a.token, v, [{ put: ['pages/a.json', 'x'] }])
    await commit(s, a.token, v, [{ del: ['pages/a.json', first.body.results[0].rev] }])
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/rev/2`, { token: a.token })).status, 404)
    assert.equal((await call(s, 'GET', `/v1/vaults/${v}/rev/1`, { token: a.token })).raw.toString(), 'x')
  })
})
