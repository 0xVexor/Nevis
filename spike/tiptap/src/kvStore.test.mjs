import assert from 'node:assert/strict'
import test from 'node:test'
import { createKvStore } from './kvStore.ts'

const array = (v) => {
  if (!Array.isArray(v)) throw new Error('not an array')
  return v
}
// a fake disk with the backend's merge: union of base-removed / added items
function disk(initial, { failRead = false } = {}) {
  const d = { value: initial, failRead, saves: [] }
  d.read = async () => {
    if (d.failRead) throw new Error('STORAGE:unreadable_setting:x')
    return d.value
  }
  d.save = async (base, next) => {
    d.saves.push({ base, next })
    const cur = d.value ?? []
    const removed = (base ?? []).filter((x) => !next.includes(x))
    const merged = [...cur.filter((x) => !removed.includes(x)), ...next.filter((x) => !cur.includes(x))]
    d.value = merged
    return merged
  }
  return d
}
const make = (d, extra = {}) => createKvStore({ read: d.read, save: (b, n) => d.save(b, n), validate: array, empty: [], ...extra })

test('an unreadable file is an error state that refuses edits and never saves', async () => {
  const d = disk(['a'], { failRead: true })
  const s = make(d)
  await s.load()
  assert.equal(s.get().status, 'error')
  assert.equal(s.update((c) => [...c, 'b']), false)
  await s.settled()
  assert.equal(d.saves.length, 0)
  d.failRead = false
  await s.load() // Retry
  assert.deepEqual(s.get().value, ['a'])
})

test('a stored value that is not an array is an error, nothing stored is an empty list', async () => {
  const bad = make(disk({ x: 1 }))
  await bad.load()
  assert.equal(bad.get().status, 'error')
  const none = make(disk(undefined))
  await none.load()
  assert.deepEqual(none.get().value, [])
})

test('nothing is saved while loading', async () => {
  const d = disk(['a'])
  const s = make(d)
  assert.equal(s.update((c) => [...c, 'b']), false)
  assert.equal(d.saves.length, 0)
})

test('first save of a key without a file sends base null; the merged value is adopted', async () => {
  const d = disk(undefined)
  const s = make(d)
  await s.load()
  s.update((c) => [...c, 'a'])
  await s.settled()
  assert.equal(d.saves[0].base, null)
  d.value = ['a', 'remote']
  s.update((c) => [...c, 'b'])
  await s.settled()
  assert.deepEqual(s.get().value, ['a', 'remote', 'b'])
})

test('a download from another device is adopted by a reload and not overwritten by the next save', async () => {
  const d = disk(['a'])
  const s = make(d)
  await s.load()
  d.value = ['a', 'remote']
  await s.load() // external-change
  s.update((c) => [...c, 'b'])
  await s.settled()
  assert.deepEqual(d.value, ['a', 'remote', 'b'])
})

test('an edit made while a save is in flight keeps the sent value as base, so a remote change is not reverted', async () => {
  const d = disk(['a'])
  const s = make(d)
  await s.load()
  d.value = ['a', 'remote']
  s.update((c) => [...c, 'b']) // save 1 in flight (merge adds remote)
  s.update((c) => [...c, 'c']) // edited before save 1 returns
  await s.settled()
  assert.deepEqual(d.saves[1].base, ['a', 'b']) // not the merged list
  assert.deepEqual([...d.value].sort(), ['a', 'b', 'c', 'remote'])
})

test('a failed save keeps the value and the base; an unreadable one goes read-only', async () => {
  const d = disk(['a'])
  const errors = []
  const s = make(d, { onSaveError: (e) => errors.push(e) })
  await s.load()
  const save = d.save
  d.save = async () => {
    throw new Error('disk full')
  }
  s.update((c) => [...c, 'b'])
  await s.settled()
  assert.deepEqual(s.get().value, ['a', 'b'])
  assert.equal(errors.length, 1)
  d.save = async () => {
    throw new Error('STORAGE:unreadable_setting:x')
  }
  s.update((c) => [...c, 'c'])
  await s.settled()
  assert.equal(s.get().status, 'error')
  d.save = save
})

test('a read that finishes after an edit is discarded', async () => {
  const d = disk(['a'])
  const s = make(d)
  await s.load()
  const slow = s.load()
  s.update((c) => [...c, 'b'])
  await slow
  assert.deepEqual(s.get().value, ['a', 'b'])
})
