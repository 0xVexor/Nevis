import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptanceEndpoint, acceptanceToken } from '../acceptance-auth.mjs'
test('acceptance credentials cannot be sent to a remote host or URL userinfo trick', () => {
  assert.equal(acceptanceEndpoint('http://127.0.0.1:12345/mcp').hostname, '127.0.0.1')
  for (const value of ['http://127.0.0.1:12345@evil.example/mcp', 'https://example.com/mcp', 'http://localhost:12345/mcp', 'http://127.0.0.1:12345/mcp?token=x', 'http://127.0.0.1:12345/other']) assert.throws(() => acceptanceEndpoint(value))
  assert.throws(() => acceptanceToken('not-a-grant-id'), /grant ID/)
})
