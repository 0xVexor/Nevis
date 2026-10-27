import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { harness, page } from './repoHarness.mjs'

test('a failed initial read never writes a replacement workspace', async () => {
  const h = harness({ allPages: async () => { throw new Error('read failed') } })
  await assert.rejects(h.repo.init(), /read failed/)
  assert.equal(h.writes.length, 0)
})

test('refresh notices equal-timestamp remote content changes', async () => {
  const h = harness()
  await h.repo.init()
  h.setRows([page('remote', 100)])
  await h.repo.poll()
  assert.equal(h.repo.get('p').title, 'remote')
  assert.ok(h.events.some(e => e.type === 'external-change'))
})

test('a write records the persisted version returned by storage, including a retained newer page', async () => {
  const writes = []
  const h = harness({ savePages: async upserts => { writes.push(structuredClone(upserts)); return { pages: [page('newer on disk', 500)] } } })
  await h.repo.init()
  h.repo.update('p', { title: 'first' })
  await h.repo.flushed()
  h.repo.update('p', { title: 'next' })
  await h.repo.flushed()
  assert.equal(writes[1][0]._base, 500)
})

test('restoring a complete version retains metadata and repairs a cyclic parent', async () => {
  const h = harness()
  await h.repo.init()
  h.repo.update('p', { icon: 'i:star' }, { history: false })
  h.repo.restoreVersion('p', { title: 'restored', content: { type: 'doc', content: [] }, page: { parentId: 'p', tags: ['kept'], cover: { kind: 'image', file: 'abc' }, favorite: true } })
  assert.equal(h.repo.get('p').parentId, null)
  assert.deepEqual(h.repo.get('p').tags, ['kept'])
  assert.equal(h.repo.get('p').cover.file, 'abc')
  assert.equal(h.repo.get('p').favorite, true)
  assert.equal(h.repo.get('p').icon, undefined)
})

test('an in-flight refresh cannot replace an edit queued after it began', async () => {
  let reads = 0, release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const h = harness({
    vaultStamp: async () => 'fixed-stamp',
    allPages: async () => { if (++reads === 1) return [page()]; entered(); return blocked },
  })
  await h.repo.init()
  const refreshing = h.repo.poll()
  await ready
  h.repo.update('p', { title: 'typed while refreshing' })
  await h.repo.flushed()
  release([page('stale read')])
  await refreshing
  assert.equal(h.repo.get('p').title, 'typed while refreshing')
})

test('failed storage never acknowledges a successful flush and can be retried', async () => {
  let fail = true
  const h = harness({ savePages: async rows => { if (fail) throw new Error('disk unavailable'); return { pages: rows } } })
  await h.repo.init()
  h.repo.update('p', { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep this draft' }] }] } })
  await assert.rejects(h.repo.flushed(), /disk unavailable/)
  assert.ok(JSON.stringify(h.repo.get('p').content).includes('keep this draft'))
  fail = false
  await h.repo.flushed()
})

test('concurrent parent moves remain visible and deletions cannot recurse forever', async () => {
  const h = harness({ allPages: async () => [{ ...page('A'), id: 'a', parentId: 'b' }, { ...page('B'), id: 'b', parentId: 'a' }] })
  await h.repo.init()
  const rows = h.repo.list()
  assert.equal(rows.find(p => p.id === 'a').parentId, null)
  assert.equal(rows.find(p => p.id === 'b').parentId, 'a')
  assert.equal(h.repo.get('a').parentId, 'b', 'presentation must not silently rewrite saved metadata')
  h.repo.remove('a')
  assert.equal(h.repo.list().length, 0)
})

test('a drawing buffer holds refresh until its save is acknowledged', async () => {
  const h = harness()
  await h.repo.init()
  const release = h.repo.holdRefresh()
  h.setRows([page('remote')])
  await h.repo.poll()
  assert.equal(h.repo.get('p').title, 'local')
  release()
  await h.repo.poll()
  assert.equal(h.repo.get('p').title, 'remote')
})

test('a frozen workspace rejects a mutation before changing its in-memory pages', async () => {
  let frozen = false
  const h = harness({ storageFrozen: () => frozen })
  await h.repo.init()
  frozen = true
  assert.throws(() => h.repo.update('p', { title: 'must not apply' }), /paused/)
  assert.equal(h.repo.get('p').title, 'local')
})

test('live editor changes enter the repository before refresh and survive reopening', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let written
  const h = harness({ savePages: async rows => { written = rows; await blocked; return { pages: rows } } })
  await h.repo.init()
  const view = readFileSync(new URL('./PageView.tsx', import.meta.url), 'utf8')
  const body = view.match(/onUpdate: \(\{ editor: current \}\) => \{([\s\S]*?)\n      \},/)?.[1]
  assert.ok(body, 'load the live production edit handler')
  const onEdit = new Function('repo', 'page', 'readOnly', 'problemRef', 'editSequence', 'onSave', 'flush', `return ({editor:current})=>{${body}
}`)(h.repo, { id: 'p' }, false, { current: null }, { current: 0 }, () => {}, async () => {})
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'typed before visiting two other pages' }] }] }
  onEdit({ editor: { getJSON: () => content } })
  h.setRows([page('remote')])
  await h.repo.poll()
  assert.deepEqual(h.repo.get('p').content, content)
  const saving = h.repo.flushed()
  release()
  await saving
  const reopened = harness({ allPages: async () => structuredClone(written) })
  await reopened.repo.init()
  assert.deepEqual(reopened.repo.get('p').content, content)
})

test('flush also waits for a write queued while the previous write was finishing', async () => {
  let releaseFirst, releaseSecond, enterFirst, enterSecond, writes = 0
  const first = new Promise(resolve => { releaseFirst = resolve })
  const second = new Promise(resolve => { releaseSecond = resolve })
  const startedFirst = new Promise(resolve => { enterFirst = resolve })
  const startedSecond = new Promise(resolve => { enterSecond = resolve })
  const h = harness({ savePages: async rows => {
    if (++writes === 1) { enterFirst(); await first } else { enterSecond(); await second }
    return { pages: rows }
  } })
  await h.repo.init()
  h.repo.update('p', { title: 'first' })
  let acknowledged = false
  const flushing = h.repo.flushed().then(() => { acknowledged = true })
  await startedFirst
  h.repo.update('p', { title: 'queued meanwhile' })
  void h.repo.flushed()
  releaseFirst()
  await startedSecond
  assert.equal(acknowledged, false)
  releaseSecond()
  await flushing
  assert.equal(writes, 2)
})
