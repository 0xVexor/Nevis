// Execution leases (handoff §21): one device (or one hosted runner) executes a workflow domain at a time; a crashed holder is
// taken over after its lease expires. Local scheduled automations use a designated runner; other devices stay idle.
import type { Id } from '../model/types.ts'

export interface LeaseStore {
  /** returns a fencing token, or null while another holder's lease is still valid */
  acquire(domain: string, holder: Id, ttlMs: number, nowMs: number): Promise<number | null>
  renew(domain: string, holder: Id, ttlMs: number, nowMs: number): Promise<boolean>
  release(domain: string, holder: Id): Promise<void>
}

export class MemoryLeases implements LeaseStore {
  private m = new Map<string, { holder: Id; until: number; token: number }>()
  private counter = 0
  async acquire(domain: string, holder: Id, ttlMs: number, nowMs: number) {
    const cur = this.m.get(domain)
    if (cur && cur.holder !== holder && cur.until > nowMs) return null
    const token = cur && cur.holder === holder ? cur.token : ++this.counter
    this.m.set(domain, { holder, until: nowMs + ttlMs, token })
    return token
  }
  async renew(domain: string, holder: Id, ttlMs: number, nowMs: number) {
    const cur = this.m.get(domain)
    if (!cur || cur.holder !== holder) return false
    cur.until = nowMs + ttlMs
    return true
  }
  async release(domain: string, holder: Id) {
    if (this.m.get(domain)?.holder === holder) this.m.delete(domain)
  }
}
