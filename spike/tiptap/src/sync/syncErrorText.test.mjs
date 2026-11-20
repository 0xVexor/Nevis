import assert from 'node:assert/strict'
import test from 'node:test'
import { codeMessage, describeSyncError, needsSignIn, shortenPath, isSticky } from './syncErrorText.ts'

const tr = (k, v = {}) => k.replace(/\{(\w+)\}/g, (_, n) => v[n] ?? '')
const d = (s) => describeSyncError(s, tr)
const RAW = 'Upload("pages/a.json"): HUB:rate_limited http=429 endpoint=https://sync.example.com/v1/x\nmore'

test('each known code maps to a clear message', () => {
  assert.match(d({ errorCode: 'HUB:quota_exceeded' }).text, /storage of this account/)
  assert.match(d({ errorCode: 'HUB:rate_limited' }).text, /slow down/)
  assert.match(d({ errorCode: 'HUB:too_many_uploads' }).text, /unfinished uploads/)
  assert.match(d({ errorCode: 'HUB:vault_taken' }).text, /already used by another account/)
  assert.match(d({ errorCode: 'NETWORK:timeout' }).text, /cannot be reached/)
})

test('too_large names the file, isolated left-to-right and shortened', () => {
  const r = d({ errorCode: 'HUB:too_large', errorPath: 'attachments/2024/big/video.mov' })
  assert.equal(r.path, '…/big/video.mov')
  assert.equal(r.text, 'A file is too large for this server: ⁦…/big/video.mov⁩')
  assert.equal(d({ errorCode: 'HUB:too_large' }).text, 'A file is too large for this server.')
})

test('unknown codes: generic text with the short code, never raw text or URLs', () => {
  assert.equal(d({ errorCode: 'HUB:odd_thing', error: RAW }).text, 'Sync failed (HUB:odd_thing)')
  const r = d({ errorCode: '', error: 'something\nhttps://x.example/y' })
  assert.equal(r.text, 'Sync failed')
  const w = d({ errorCode: 'weird text https://x.example', error: RAW })
  assert.equal(w.text, 'Sync failed')
})

test('older backend: the code is found inside the raw text, and no URL leaks', () => {
  const r = d({ error: RAW })
  assert.match(r.text, /slow down/)
  for (const s of [RAW, 'Upload("a"): HUB:zzz http=500 endpoint=https://h/x']) assert.doesNotMatch(d({ error: s }).text, /https?:|http=|endpoint|Upload/)
})

test('paths: shortened, URLs dropped', () => {
  assert.equal(shortenPath('a.md'), 'a.md')
  assert.equal(shortenPath('a/b/c.md'), '…/b/c.md')
  assert.ok(shortenPath('x/' + 'y'.repeat(100)).length <= 48)
  assert.equal(shortenPath('https://host/secret'), '')
  assert.equal(shortenPath(''), '')
})

test('http codes and unknown lookups', () => {
  assert.equal(codeMessage('HUB:http_502', tr), 'The server answered with an error (502).')
  assert.equal(codeMessage('HUB:nope', tr), null)
})

test('sign-in and sticky reasons', () => {
  assert.equal(needsSignIn({ signedIn: false }), true)
  assert.equal(needsSignIn({ signedIn: true, reason: 'SIGNED_OUT' }), true)
  assert.equal(needsSignIn({ signedIn: true, state: 'error', errorCode: 'AUTH:unauthorized' }), true)
  assert.equal(needsSignIn({ signedIn: true, state: 'idle', reason: '' }), false)
  for (const r of ['SIGNED_OUT', 'CLOUD_GONE', 'ACCOUNT_CHANGED', 'VAULT_TAKEN']) assert.ok(isSticky({ reason: r }))
  assert.ok(!isSticky({ reason: '' }))
})
