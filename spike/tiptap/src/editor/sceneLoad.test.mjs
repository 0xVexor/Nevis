import assert from 'node:assert/strict'
import test from 'node:test'
import { readScene } from './sceneLoad.ts'

const restore = (d) => ({ elements: d.elements, files: d.files ?? {} })
const scene = { elements: [{ id: 'a', version: 3 }], files: {} }
const blobOf = (text) => new Blob([text], { type: 'application/json' })

test('the scene is read from the Blob and never through fetch (the desktop CSP refuses blob: URLs)', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new TypeError('Refused to connect because it violates the CSP'))
  try {
    const r = await readScene('id1', async () => blobOf(JSON.stringify(scene)), restore)
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.scene.elements, scene.elements)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('no id is an empty, editable canvas', async () => {
  assert.deepEqual(await readScene('', async () => assert.fail('must not read'), restore), { status: 'empty' })
})

test('an id whose file is absent is missing, not empty', async () => {
  assert.deepEqual(await readScene('id1', async () => null, restore), { status: 'missing' })
})

test('broken JSON, a failing restore and a failing store are unreadable', async (t) => {
  t.mock.method(console, 'error', () => {})
  assert.equal((await readScene('id1', async () => blobOf('{nope'), restore)).status, 'unreadable')
  const boom = new Error('bad scene')
  const r = await readScene('id1', async () => blobOf('{}'), () => { throw boom })
  assert.equal(r.status, 'unreadable')
  assert.equal(r.error, boom)
  assert.equal((await readScene('id1', async () => { throw new Error('io') }, restore)).status, 'unreadable')
})
