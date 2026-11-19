import assert from 'node:assert/strict'
import test from 'node:test'
import { isBlockedHttpUrl } from './imageUrl.ts'

test('http addresses from the internet are blocked', () => {
  assert.equal(isBlockedHttpUrl('http://example.com/a.png'), true)
  assert.equal(isBlockedHttpUrl('HTTP://example.com/a.png'), true)
  assert.equal(isBlockedHttpUrl('http://localhost.evil.com/a.png'), true)
})
test('https, local http and other forms are left to the normal path', () => {
  assert.equal(isBlockedHttpUrl('https://example.com/a.png'), false)
  assert.equal(isBlockedHttpUrl('http://localhost:3000/a.png'), false)
  assert.equal(isBlockedHttpUrl('http://127.0.0.1/a.png'), false)
  assert.equal(isBlockedHttpUrl('data:image/png;base64,AAAA'), false)
  assert.equal(isBlockedHttpUrl('not a url'), false)
})
