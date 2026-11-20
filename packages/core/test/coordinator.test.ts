import { describe, expect, it } from 'vitest'
import { TabCoordinator, type ChannelPort, type LockPort } from '../src'

/** An in-memory Web Locks: exclusive, queued, released when the holder settles or its signal aborts. */
class FakeLocks {
  private held = new Set<string>()
  private queues = new Map<string, (() => void)[]>()
  port(): LockPort {
    return {
      request: (name, signal, held) => new Promise<void>((resolve, reject) => {
        const grant = async () => {
          if (signal.aborted) { this.release(name); return resolve() }
          this.held.add(name)
          try {
            await Promise.race([held(), new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true }))])
            resolve()
          } catch (e) { reject(e) } finally { this.release(name) }
        }
        if (!this.held.has(name)) void grant()
        else this.queues.set(name, [...(this.queues.get(name) ?? []), () => void grant()])
      }),
    }
  }
  private release(name: string) {
    this.held.delete(name)
    const next = this.queues.get(name)?.shift()
    if (next) { this.held.add(name); next() }
  }
}

class FakeBus {
  private subs = new Set<(m: unknown) => void>()
  channel(): ChannelPort & { self: (m: unknown) => void } {
    let mine: ((m: unknown) => void) | null = null
    return {
      post: m => { for (const s of this.subs) if (s !== mine) queueMicrotask(() => s(structuredClone(m))) },
      onMessage: cb => { mine = cb; this.subs.add(cb); return () => this.subs.delete(cb) },
      close: () => { if (mine) this.subs.delete(mine) },
      self: m => mine?.(m),
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const make = (locks: FakeLocks, bus: FakeBus, cycle: () => Promise<unknown>, extra: Partial<ConstructorParameters<typeof TabCoordinator>[0]> = {}) =>
  new TabCoordinator({ ws: 'w', locks: locks.port(), channel: bus.channel(), cycle, intervalMs: 10, ...extra })

describe('TabCoordinator', () => {
  it('only one of three tabs becomes leader and syncs', async () => {
    const locks = new FakeLocks(), bus = new FakeBus()
    const calls = [0, 0, 0]
    const tabs = [0, 1, 2].map(i => make(locks, bus, async () => { calls[i]!++ }))
    tabs.forEach(t => t.start())
    await sleep(80)
    expect(tabs.filter(t => t.isLeader).length).toBe(1)
    expect(calls.filter(c => c > 0).length).toBe(1)
    tabs.forEach(t => t.stop())
  })

  it('when the leader goes away another tab takes over and keeps syncing', async () => {
    const locks = new FakeLocks(), bus = new FakeBus()
    const calls = [0, 0]
    const a = make(locks, bus, async () => { calls[0]!++ }), b = make(locks, bus, async () => { calls[1]!++ })
    a.start(); await sleep(20); b.start(); await sleep(30)
    expect(a.isLeader).toBe(true); expect(b.isLeader).toBe(false)
    const t0 = Date.now()
    a.stop()
    while (!b.isLeader && Date.now() - t0 < 2000) await sleep(5)
    expect(b.isLeader).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
    const before = calls[1]!
    await sleep(60)
    expect(calls[1]!).toBeGreaterThan(before)
    b.stop()
  })

  it('a local change is announced to the other tabs, and the leader syncs at once', async () => {
    const locks = new FakeLocks(), bus = new FakeBus()
    const seen: unknown[] = []
    let leaderRounds = 0
    const leader = make(locks, bus, async () => { leaderRounds++ }, { intervalMs: 5000 })
    const writer = make(locks, bus, async () => undefined, { intervalMs: 5000, onRemoteChange: m => seen.push(m) })
    leader.start(); await sleep(20); writer.start(); await sleep(20)
    const r0 = leaderRounds
    writer.notifyLocalChange({ ents: ['e1'] })
    await sleep(40)
    expect(leaderRounds).toBeGreaterThan(r0) // woken long before its 5 s interval
    leader.stop(); writer.stop()
  })

  it('tells the tabs about each other (not about themselves)', async () => {
    const locks = new FakeLocks(), bus = new FakeBus()
    const aSeen: unknown[] = [], bSeen: unknown[] = []
    const a = make(locks, bus, async () => undefined, { onRemoteChange: m => aSeen.push(m) })
    const b = make(locks, bus, async () => undefined, { onRemoteChange: m => bSeen.push(m) })
    a.start(); b.start()
    a.notifyLocalChange({ docs: ['d'] })
    await sleep(20)
    expect(aSeen.length).toBe(0)
    expect(bSeen.length).toBe(1)
    a.stop(); b.stop()
  })

  it('a failing round is reported and retried with backoff, not in a tight loop', async () => {
    const locks = new FakeLocks(), bus = new FakeBus()
    let calls = 0
    const errors: unknown[] = []
    const t = make(locks, bus, async () => { calls++; throw new Error('offline') }, { intervalMs: 20, onError: e => errors.push(e) })
    t.start()
    await sleep(200)
    expect(errors.length).toBe(calls)
    expect(calls).toBeGreaterThan(1)
    expect(calls).toBeLessThan(8) // 20, 40, 80, 160 ms ... not 200/20 = 10 rounds
    t.stop()
  })
})
