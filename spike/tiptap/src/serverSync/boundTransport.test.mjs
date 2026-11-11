import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindTransportToVault } from './boundTransport.ts'

test('a switched vault prevents sending or accepting a transport response', async () => {
  let active = false, sends = 0
  const assertVault = async () => { if (!active) throw new Error('vault changed') }
  const send = bindTransportToVault(async () => { sends++; active = false; return new Response(null, { status: 200 }) }, assertVault)
  await assert.rejects(send('https://example.test'), /vault changed/)
  assert.equal(sends, 0)
  active = true
  await assert.rejects(send('https://example.test'), /vault changed/)
  assert.equal(sends, 1) // response may have reached the server, so retries must be idempotent
})
