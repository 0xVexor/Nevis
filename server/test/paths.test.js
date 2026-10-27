import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkPath } from '../src/paths.js'

// The Rust client reads this same fixture to prevent protocol drift.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/sync-paths.json', import.meta.url)))
test('desktop and server path contract', () => {
  for (const [path, reason] of fixtures) assert.equal(checkPath(path), reason, path)
  assert.equal(checkPath(`files/${'a'.repeat(240)}`), 'too_long')
})
