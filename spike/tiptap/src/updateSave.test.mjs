import assert from 'node:assert/strict'
import test from 'node:test'
import { registerUpdateSave, saveBeforeUpdate } from './updateSave.ts'

test('a detached editor is still drained before a workspace switch or install', async () => {
  let release, saved = false
  const blocked = new Promise(resolve => { release = resolve })
  const unregister = registerUpdateSave(async () => { await blocked; saved = true })
  unregister()
  const drain = saveBeforeUpdate()
  await Promise.resolve()
  assert.equal(saved, false)
  release()
  await drain
  assert.equal(saved, true)
})

test('a detached failed save blocks installation and is retryable', async () => {
  let failed = true, saved = false
  const unregister = registerUpdateSave(async () => { if (failed) throw new Error('disk unavailable'); saved = true })
  unregister()
  await assert.rejects(saveBeforeUpdate(), /disk unavailable/)
  assert.equal(saved, false)
  failed = false
  await saveBeforeUpdate()
  assert.equal(saved, true)
})
