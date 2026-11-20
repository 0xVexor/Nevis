// Faults injected around the Net port of ONE replica: a lost request, a lost answer after the server has committed, a repeated
// request, and offline periods. The server is the real one; only the wire between client and server is made unreliable.
import { NetError, type Net } from '@nevis/core'
import type { Rng } from './rng'

export interface FaultConfig { loseRequest: number; loseResponse: number; duplicate: number }
export interface FaultCounts { lostRequests: number; lostResponses: number; duplicates: number; offlineRefusals: number }

export class FaultyNet implements Net {
  offline = false
  enabled = true
  readonly counts: FaultCounts = { lostRequests: 0, lostResponses: 0, duplicates: 0, offlineRefusals: 0 }
  private readonly inner: Net
  private readonly rng: Rng
  private readonly cfg: FaultConfig
  constructor(inner: Net, rng: Rng, cfg: FaultConfig) {
    this.inner = inner
    this.rng = rng
    this.cfg = cfg
  }

  private async go<T>(call: () => Promise<T>): Promise<T> {
    if (!this.enabled) return call()
    if (this.offline) { this.counts.offlineRefusals++; throw new NetError(0, 'offline', true) }
    if (this.rng() < this.cfg.loseRequest) { this.counts.lostRequests++; throw new NetError(0, 'request_lost', true) }
    if (this.rng() < this.cfg.duplicate) { this.counts.duplicates++; await call() }
    const out = await call()
    if (this.rng() < this.cfg.loseResponse) { this.counts.lostResponses++; throw new NetError(0, 'response_lost', true) }
    return out
  }

  push: Net['push'] = (ws, envs) => this.go(() => this.inner.push(ws, envs))
  pull: Net['pull'] = (ws, after, limit, opts) => this.go(() => this.inner.pull(ws, after, limit, opts))
}
