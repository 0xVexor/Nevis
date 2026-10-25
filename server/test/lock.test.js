import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { acquireLock } from '../src/lock.js'
import { MemStorage } from '../src/storage.js'

const fast = { sleep: async () => {}, stepMs: 0, settleMs: 0, beatMs: 3_600_000 }

describe('single instance lock', () => {
  it('lets the first instance in and keeps a second one out', async () => {
    const storage = new MemStorage()
    const a = await acquireLock(storage, { ...fast, id: 'A' })
    let t = 0
    await assert.rejects(acquireLock(storage, { ...fast, id: 'B', waitMs: 10, now: () => (t += 20) }), /another server instance \(A\)/)
    await a.release()
    const b = await acquireLock(storage, { ...fast, id: 'B' })
    assert.equal(b.id, 'B')
    await b.release()
  })

  it('takes over from an instance that stopped without letting go (its heartbeat is old)', async () => {
    const storage = new MemStorage()
    let clock = 1000
    const a = await acquireLock(storage, { ...fast, id: 'A', now: () => clock })
    clock += 31_000
    const b = await acquireLock(storage, { ...fast, id: 'B', now: () => clock })
    assert.equal(b.id, 'B')
    await a.release() // A is gone anyway; it must not remove B's lock
    assert.equal(await storage.has('_lock/instance.json'), true)
    await b.release()
    assert.equal(await storage.has('_lock/instance.json'), false)
  })

  it('waits for an instance that is stopping, as in a rolling deploy', async () => {
    const storage = new MemStorage()
    const a = await acquireLock(storage, { ...fast, id: 'A' })
    let sleeps = 0
    const sleep = async () => {
      if (++sleeps === 3) await a.release()
    }
    const b = await acquireLock(storage, { ...fast, id: 'B', sleep, waitMs: 60_000 })
    assert.equal(b.id, 'B')
    assert.ok(sleeps >= 3)
    await b.release()
  })

  it('the same instance can take its own lock again', async () => {
    const storage = new MemStorage()
    const a = await acquireLock(storage, { ...fast, id: 'A' })
    const again = await acquireLock(storage, { ...fast, id: 'A' })
    assert.equal(again.id, 'A')
    await a.release()
  })
})
