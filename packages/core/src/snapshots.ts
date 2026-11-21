// Snapshots (ROADMAP M13): a device that has everything the server has writes a snapshot op for a document that has many ops no snapshot covers, so
// a new device starts from the snapshot and the server may later remove the covered ops. The rule that keeps this safe lives in
// `Client.writeSnapshot`: only when the cursor has reached the head and the inbox is empty.
import { OpTooLargeError, type Client } from './client'
import type { Net } from './engine'
import type { Store } from './store'

export interface SnapshotterOptions { client: Client; store: Store; net: Net; ws: string; now?: () => number; minOps?: number; every?: number; perRun?: number }

export class Snapshotter {
  private readonly o: Required<SnapshotterOptions>
  constructor(o: SnapshotterOptions) { this.o = { now: Date.now, minOps: 100, every: 3600_000, perRun: 10, ...o } }

  /** Asks the server which documents are worth a snapshot and writes up to `perRun` of them. Returns how many were written. */
  async run(): Promise<number> {
    const { store, net, ws, client } = this.o
    if (!net.candidates) return 0
    const last = Number((await store.run(tx => tx.getMeta('snapshotAt'))) ?? 0)
    if (this.o.now() - last < this.o.every) return 0
    let n = 0
    try {
      const docs = await net.candidates(ws, this.o.minOps)
      for (const doc of docs.slice(0, this.o.perRun)) {
        // one document that cannot be snapshotted (too large for one op) must not stop the others, nor make every round ask again
        try { if (await client.writeSnapshot(doc)) n++ } catch (e) { if (!(e instanceof OpTooLargeError)) throw e }
      }
    } finally { await store.run(tx => tx.setMeta('snapshotAt', String(this.o.now()))) }
    return n
  }
}
