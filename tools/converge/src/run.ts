// One seed: N replicas of the core against the REAL Go server, a random run with faults and crashes, then a check that
// everything converged and that every operation committed on a device is in the server's log exactly once.
import { MemoryStore, SyncEngine, projectStore, type Net, type Projection } from '@nevis/core'
import { UuidGenerator } from '@nevis/protocol'
import { createWorkspace } from './account'
import { httpNet } from './http'
import { randomOp, type World } from './ops'
import { Replica, type CrashPoint } from './replica'
import { int, mulberry32, pick, seededBytes } from './rng'

export interface Options {
  server: string
  token: string
  replicas: number
  ops: number
  faults?: { loseRequest: number; loseResponse: number; duplicate: number }
  crashes?: boolean
  /** a real account (M4): the token of a device; the workspace is created through the API */
  account?: { token: string }
  /** replica R1's clock runs two hours ahead for the first 40% of the run, then is fixed (ADR-0005: `422 clock_ahead`) */
  clockAhead?: boolean
  onTick?: (s: Stats) => void
}

export interface Stats {
  seed: number
  ops: number
  syncs: number
  netErrors: number
  lostRequests: number
  lostResponses: number
  duplicates: number
  offlineRefusals: number
  crashes: Record<CrashPoint, number>
  serverHead: number
  dupStatuses: number
  quarantined: number
  /** pushes the server refused with `422 clock_ahead` */
  clockAheadRefusals: number
}

export interface SeedResult { seed: number; ok: boolean; reason?: string; stats: Stats; ms: number }

const defaultFaults = { loseRequest: 0.1, loseResponse: 0.1, duplicate: 0.1 }

const same = (a: Projection, b: Projection) => JSON.stringify(a) === JSON.stringify(b)

/** Where two projections first differ, for the failure report. */
function diff(a: unknown, b: unknown, path = ''): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return `${path}: ${JSON.stringify(a)?.slice(0, 90)}  vs  ${JSON.stringify(b)?.slice(0, 90)}`
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = diff((a as any)[k], (b as any)[k], `${path}/${k}`); if (d) return d }
  return path
}

export async function runSeed(seed: number, o: Options): Promise<SeedResult> {
  const t0 = Date.now()
  const rng = mulberry32(seed)
  const base = Date.now()
  let tick = 0
  const token = o.account?.token ?? o.token
  const net: Net = httpNet(o.server, token)
  const idGen = new UuidGenerator(() => base + tick, seededBytes(rng))
  const ws = idGen.next()
  const world: World = { entities: Array.from({ length: 20 }, () => idGen.next()), docs: Array.from({ length: 5 }, () => idGen.next()) }
  const skews = Array.from({ length: o.replicas }, () => int(rng, 6000) - 3000) // each device's clock is a little off, within 10 minutes
  const ahead = Array.from({ length: o.replicas }, () => 0) // extra offset: a clock that ran fast
  if (o.clockAhead) ahead[0] = 2 * 3_600_000
  if (o.account) await createWorkspace(o.server, token, ws)
  const reps = Array.from({ length: o.replicas }, (_, i) => new Replica(`R${i + 1}`, ws, net, rng, o.faults ?? defaultFaults, () => base + tick + skews[i]! + ahead[i]! - (rng() < 0.02 ? int(rng, 2000) : 0)))
  const stats: Stats = { seed, ops: 0, syncs: 0, netErrors: 0, lostRequests: 0, lostResponses: 0, duplicates: 0, offlineRefusals: 0, crashes: { afterLocalCommit: 0, afterPush: 0, afterPull: 0 }, serverHead: 0, dupStatuses: 0, quarantined: 0, clockAheadRefusals: 0 }

  try {
    for (let i = 0; i < o.ops; i++) {
      tick += int(rng, 4)
      const rep = pick(rng, reps)
      await randomOp(rep, rng, world)
      stats.ops++
      if (o.clockAhead && i === Math.floor(o.ops * 0.4)) ahead[0] = 0 // the person fixes the clock
      if (o.crashes !== false && rng() < 0.02) rep.crash('afterLocalCommit')
      if (rng() < 0.12) {
        const s = pick(rng, reps)
        if (o.crashes !== false && rng() < 0.12) s.crashNext = pick(rng, ['afterPush', 'afterPull'] as const)
        const r = await s.sync()
        stats.syncs++
        if (r === 'neterror') stats.netErrors++
      }
      if (rng() < 0.03) pick(rng, reps).net.offline = !pick(rng, reps).net.offline
      if (i % 200 === 0) o.onTick?.(collect(stats, reps))
    }

    // quiet down: everyone online, no faults, no crashes; sync until nothing is left to send or apply
    for (const r of reps) { r.net.offline = false; r.net.enabled = false; r.crashNext = null }
    const direct = httpNet(o.server, token)
    let head = 0
    for (let round = 0; round < 40; round++) {
      for (const r of reps) await r.sync()
      head = (await direct.pull(ws, 0, 1)).head
      const ps = await Promise.all(reps.map(r => r.pending()))
      if (ps.every(p => p.outbox === 0 && p.inbox === 0 && p.cursor === head)) break
      if (round === 39) throw new Error(`did not settle: ${JSON.stringify(ps)} head ${head}`)
    }
    for (const r of reps) await r.sync()
    stats.serverHead = head

    // 1. every replica shows the same registers, events and document bodies
    const projections = await Promise.all(reps.map(r => projectStore(r.store)))
    for (let i = 1; i < projections.length; i++) if (!same(projections[0]!, projections[i]!)) return fail(seed, stats, reps, t0, `replicas ${reps[0]!.name} and ${reps[i]!.name} differ at ${diff(projections[0], projections[i])}`)

    // 2. the server's log holds every op committed on a device exactly once, and nothing else
    const log: string[] = []
    for (let after = 0; ;) {
      const page = await direct.pull(ws, after, 1000)
      for (const op of page.ops) { log.push(JSON.parse(op.env).op); after = op.seq }
      if (!page.more) break
    }
    const produced = reps.flatMap(r => r.produced)
    if (new Set(log).size !== log.length) return fail(seed, stats, reps, t0, 'an op is in the server log twice')
    const inLog = new Set(log)
    // the ops rebuilt after a clock repair have new ids (by design), so only the OTHER replicas' ops are matched by id there
    const strict = (o.clockAhead ? reps.slice(1) : reps).flatMap(r => r.produced)
    const missing = strict.filter(op => !inLog.has(op))
    if (missing.length) return fail(seed, stats, reps, t0, `${missing.length} op(s) committed on a device are not in the log (first ${missing[0]})`)
    if (log.length !== produced.length) return fail(seed, stats, reps, t0, `log has ${log.length} ops, devices produced ${produced.length}`)

    // 3. a device that starts from nothing and reads the whole log ends in the same state
    const fresh = new MemoryStore()
    const device = idGen.next()
    await new SyncEngine({ store: fresh, net: direct, ws, device, sv: 1, now: () => base + tick }).cycle()
    if (!same(projections[0]!, await projectStore(fresh))) return fail(seed, stats, reps, t0, 'a fresh device reading the log differs from the replicas')

    for (const r of reps) stats.quarantined += (await r.store.run(tx => tx.listQuarantine())).length
    if (stats.quarantined) return fail(seed, stats, reps, t0, `${stats.quarantined} op(s) were quarantined`)
    return { seed, ok: true, stats: collect(stats, reps), ms: Date.now() - t0 }
  } catch (e) {
    return fail(seed, stats, reps, t0, `exception: ${(e as Error).stack ?? e}`)
  }
}

function collect(stats: Stats, reps: Replica[]): Stats {
  const s = { ...stats, crashes: { afterLocalCommit: 0, afterPush: 0, afterPull: 0 }, lostRequests: 0, lostResponses: 0, duplicates: 0, offlineRefusals: 0 }
  for (const r of reps) {
    for (const k of Object.keys(s.crashes) as CrashPoint[]) s.crashes[k] += r.crashes[k]
    s.lostRequests += r.net.counts.lostRequests
    s.lostResponses += r.net.counts.lostResponses
    s.duplicates += r.net.counts.duplicates
    s.offlineRefusals += r.net.counts.offlineRefusals
    s.clockAheadRefusals += r.clockAheadRefusals
  }
  return s
}

function fail(seed: number, stats: Stats, reps: Replica[], t0: number, reason: string): SeedResult {
  return { seed, ok: false, reason, stats: collect(stats, reps), ms: Date.now() - t0 }
}
