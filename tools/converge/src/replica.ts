// One simulated device: a MemoryStore, a client, an engine, and a faulty network. A "crash" throws away every in-memory
// object except the COMMITTED state of the store, then builds new ones on it, which is what a restart does.
import { Client, MemoryStore, NetError, SyncEngine, type Net } from '@nevis/core'
import { UuidGenerator } from '@nevis/protocol'
import { FaultyNet, type FaultConfig } from './faults'
import { seededBytes, type Rng } from './rng'

export class CrashSignal extends Error {}
export type CrashPoint = 'afterLocalCommit' | 'afterPush' | 'afterPull'

export interface Clock { now(): number }

export class Replica {
  readonly name: string
  readonly device: string
  readonly store = new MemoryStore()
  readonly net: FaultyNet
  client!: Client
  engine!: SyncEngine
  crashNext: CrashPoint | null = null
  readonly crashes: Record<CrashPoint, number> = { afterLocalCommit: 0, afterPush: 0, afterPull: 0 }
  readonly produced: string[] = []
  clockAheadRefusals = 0
  readonly ws: string
  private readonly clock: () => number
  private readonly ids: UuidGenerator
  private readonly rng: Rng

  constructor(name: string, ws: string, inner: Net, rng: Rng, faults: FaultConfig, clock: () => number) {
    this.name = name
    this.ws = ws
    this.clock = clock
    this.rng = rng
    this.ids = new UuidGenerator(() => this.clock(), seededBytes(rng))
    this.device = this.ids.next()
    this.net = new FaultyNet(inner, rng, faults)
    this.build()
  }

  /** New in-memory objects on the same committed store. */
  build() {
    this.client = new Client({ store: this.store, ws: this.ws, device: this.device, sv: 1, now: this.clock, newId: () => this.ids.next(), rnd: () => this.rng() })
    this.engine = new SyncEngine({
      store: this.store, net: this.net, ws: this.ws, device: this.device, sv: 1, now: this.clock,
      hooks: {
        afterPush: () => { if (this.crashNext === 'afterPush') { this.crashNext = null; throw new CrashSignal('afterPush') } },
        afterPull: () => { if (this.crashNext === 'afterPull') { this.crashNext = null; throw new CrashSignal('afterPull') } },
      },
    })
  }

  crash(point: CrashPoint) {
    this.crashes[point]++
    this.crashNext = null
    this.build()
  }

  /** One sync attempt as the app would make it: network trouble is normal, a crash restarts the replica. */
  async sync(): Promise<'ok' | 'neterror' | 'crash'> {
    try {
      await this.engine.cycle()
      return 'ok'
    } catch (e) {
      if (e instanceof CrashSignal) { this.crash(e.message as CrashPoint); return 'crash' }
      if (e instanceof NetError) { if (e.code === 'clock_ahead') this.clockAheadRefusals++; return 'neterror' }
      throw e
    }
  }

  async pending(): Promise<{ outbox: number; inbox: number; cursor: number }> {
    return this.store.run(async tx => ({ outbox: (await tx.listOutbox(1e9)).length, inbox: (await tx.listInbox(0, 1e9)).length, cursor: Number((await tx.getMeta('cursor')) ?? 0) }))
  }

  record(op: string) { this.produced.push(op) }
}
