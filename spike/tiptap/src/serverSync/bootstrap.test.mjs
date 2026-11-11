import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootstrapDocument, BootstrapError } from './bootstrap.ts'

const request = () => ({ collaborationOrigin: 'https://sync.example.test', documentId: 'page_1', sessionToken: 'secret', initialUpdate: new Uint8Array([1, 2, 3]) })

test('sends identical initialization bytes on retries and omits browser credentials', async () => {
  const input = request(), attempts = []
  const send = async (url, options) => {
    attempts.push({ url: String(url), ...options, body: [...options.body] })
    return new Response(null, { status: 201 })
  }
  await bootstrapDocument(input, send)
  await bootstrapDocument(input, send)
  assert.deepEqual(attempts[0], attempts[1])
  assert.equal(attempts[0].url, 'https://sync.example.test/v1/documents/page_1/bootstrap')
  assert.deepEqual(attempts[0].body, [1, 2, 3])
  assert.equal(attempts[0].redirect, 'error')
  assert.equal(attempts[0].credentials, 'omit')
})

test('rejects unsafe endpoints and invalid payloads before sending', async () => {
  const send = () => { throw new Error('must not send') }
  for (const overrides of [
    { collaborationOrigin: 'http://remote.example' }, { collaborationOrigin: 'https://sync.example.test/path' },
    { collaborationOrigin: 'https://user:pass@sync.example.test' }, { documentId: '../other' },
    { sessionToken: 'a\nb' }, { initialUpdate: new Uint8Array() },
    { initialUpdate: new Uint8Array(2 * 1024 * 1024 + 1) },
  ]) await assert.rejects(bootstrapDocument({ ...request(), ...overrides }, send))
})

test('reports generic server failure without exposing token or treating it as a conflict', async () => {
  await assert.rejects(bootstrapDocument(request(), async () => new Response(null, { status: 409 })), error => {
    assert.ok(error instanceof BootstrapError)
    assert.equal(error.status, 409)
    assert.doesNotMatch(error.message, /secret|conflict/i)
    return true
  })
})
