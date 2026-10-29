import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptanceEndpoint, acceptanceToken } from '../acceptance-auth.mjs'
test('acceptance credentials cannot be sent to a remote host or URL userinfo trick', () => {
  assert.equal(acceptanceEndpoint('http://127.0.0.1:12345/mcp').hostname, '127.0.0.1')
  for (const value of ['http://127.0.0.1:12345@evil.example/mcp', 'https://example.com/mcp', 'http://localhost:12345/mcp', 'http://127.0.0.1:12345/mcp?token=x', 'http://127.0.0.1:12345/other']) assert.throws(() => acceptanceEndpoint(value))
  assert.throws(() => acceptanceToken('not-a-grant-id'), /grant ID/)
})

test('copied in-memory session credentials need no Keychain and cannot target another endpoint', () => {
  const originalToken = process.env.NEVIS_ACCEPTANCE_TOKEN, originalConnection = process.env.NEVIS_ACCEPTANCE_CONNECTION
  const grant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', endpoint = 'http://127.0.0.1:12345/mcp', token = 'a'.repeat(64)
  try {
    delete process.env.NEVIS_ACCEPTANCE_TOKEN; delete process.env.NEVIS_ACCEPTANCE_CONNECTION
    assert.throws(() => acceptanceToken(grant), /no Keychain access/)
    process.env.NEVIS_ACCEPTANCE_CONNECTION = JSON.stringify({ url: endpoint, headers: { Authorization: `Bearer ${token}` } })
    assert.equal(acceptanceToken(grant, endpoint), token)
    assert.throws(() => acceptanceToken(grant, 'http://127.0.0.1:23456/mcp'), /does not match/)
    process.env.NEVIS_ACCEPTANCE_CONNECTION = JSON.stringify({ url: 'https://example.org/mcp', headers: { Authorization: `Bearer ${token}` } })
    assert.throws(() => acceptanceToken(grant, endpoint), /loopback/)
  } finally {
    if (originalToken === undefined) delete process.env.NEVIS_ACCEPTANCE_TOKEN; else process.env.NEVIS_ACCEPTANCE_TOKEN = originalToken
    if (originalConnection === undefined) delete process.env.NEVIS_ACCEPTANCE_CONNECTION; else process.env.NEVIS_ACCEPTANCE_CONNECTION = originalConnection
  }
})
