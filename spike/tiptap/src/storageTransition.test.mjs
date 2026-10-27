import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareStorageTransition } from './storageTransition.ts'
import { harness } from './repoHarness.mjs'

test('installation stops new edits before draining an already pending repository write', async () => {
  let release, paused, frozen = false
  const blocked = new Promise(resolve => { release = resolve })
  const stopped = new Promise(resolve => { paused = resolve })
  const h = harness({ savePages: async rows => { await blocked; return { pages: rows } } })
  await h.repo.init()
  h.repo.update('p', { title: 'accepted before install' })
  const preparing = prepareStorageTransition({
    saveEditors: async () => {},
    repository: { pauseWrites: () => { const resume = h.repo.pauseWrites(); paused(); return resume }, flushed: () => h.repo.flushed() },
    freeze: () => { frozen = true }, thaw: () => { frozen = false },
  })
  await stopped
  assert.equal(frozen, false, 'must await the accepted write before freezing storage')
  assert.throws(() => h.repo.update('p', { title: 'late edit' }), /paused/)
  release()
  const resume = await preparing
  assert.equal(frozen, true)
  assert.equal(h.repo.get('p').title, 'accepted before install')
  resume()
  h.repo.update('p', { title: 'install failed; editing resumed' })
  await h.repo.flushed()
})

test('failed final storage drain cancels the transition and reopens editing', async () => {
  let fail = true, frozen = false
  const h = harness({ savePages: async rows => { if (fail) throw new Error('disk full'); return { pages: rows } } })
  await h.repo.init()
  h.repo.update('p', { title: 'pending' })
  await assert.rejects(prepareStorageTransition({ saveEditors: async () => {}, repository: h.repo,
    freeze: () => { frozen = true }, thaw: () => { frozen = false },
  }), /disk full/)
  assert.equal(frozen, false)
  fail = false
  h.repo.update('p', { title: 'retry' })
  await h.repo.flushed()
})
