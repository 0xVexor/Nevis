// pnpm converge --replicas 3 --seeds 50 --ops 2000 --server http://localhost:8787 --token dev [--seed N] [--from N] [--seconds N] [--live]
//   with a real account (M4): --user NAME [--password PW] [--invite CODE]   (signs up if the user does not exist)
//   a device clock two hours ahead, then fixed: --clock-ahead
import { parseArgs } from 'node:util'
import { deviceToken } from './account'
import { runSeed, type SeedResult, type Stats } from './run'
import { EXPECTED_OPS } from './structured'

const { values: v } = parseArgs({
  options: {
    replicas: { type: 'string', default: '3' }, seeds: { type: 'string', default: '50' }, ops: { type: 'string', default: '2000' },
    server: { type: 'string', default: 'http://localhost:8787' }, token: { type: 'string', default: 'dev' },
    user: { type: 'string' }, password: { type: 'string' }, invite: { type: 'string' }, 'clock-ahead': { type: 'boolean', default: false },
    seed: { type: 'string' }, from: { type: 'string', default: '1' }, seconds: { type: 'string' }, live: { type: 'boolean', default: false }, 'no-crashes': { type: 'boolean', default: false },
  },
})

const opts: Parameters<typeof runSeed>[1] = { server: v.server!, token: v.token!, replicas: Number(v.replicas), ops: Number(v.ops), crashes: !v['no-crashes'], clockAhead: v['clock-ahead'] }
const sum = (a: Stats, b: Stats): Stats => ({
  ...a, ops: a.ops + b.ops, syncs: a.syncs + b.syncs, netErrors: a.netErrors + b.netErrors, lostRequests: a.lostRequests + b.lostRequests, lostResponses: a.lostResponses + b.lostResponses,
  duplicates: a.duplicates + b.duplicates, offlineRefusals: a.offlineRefusals + b.offlineRefusals, serverHead: a.serverHead + b.serverHead, clockAheadRefusals: a.clockAheadRefusals + b.clockAheadRefusals, dupStatuses: a.dupStatuses + b.dupStatuses, structured: Object.fromEntries([...new Set([...Object.keys(a.structured), ...Object.keys(b.structured)])].map(k => [k, (a.structured[k] ?? 0) + (b.structured[k] ?? 0)])),
  crashes: { afterLocalCommit: a.crashes.afterLocalCommit + b.crashes.afterLocalCommit, afterPush: a.crashes.afterPush + b.crashes.afterPush, afterPull: a.crashes.afterPull + b.crashes.afterPull },
})
const zero = (): Stats => ({ seed: 0, ops: 0, syncs: 0, netErrors: 0, lostRequests: 0, lostResponses: 0, duplicates: 0, offlineRefusals: 0, crashes: { afterLocalCommit: 0, afterPush: 0, afterPull: 0 }, serverHead: 0, dupStatuses: 0, quarantined: 0, clockAheadRefusals: 0, structured: {} })

try {
  const r = await fetch(`${opts.server}/v1/health`)
  if (!r.ok) throw new Error(String(r.status))
} catch {
  console.error(`no Nevis server at ${opts.server}. Start one: pnpm dev:server`)
  process.exit(2)
}

if (v.user) opts.account = { token: await deviceToken(opts.server, v.user, v.password ?? 'correct horse battery', v.invite) }

const started = Date.now()
const deadline = v.seconds ? started + Number(v.seconds) * 1000 : Infinity
const results: SeedResult[] = []
let total = zero()
let lastLive = 0
const seeds = v.seed ? [Number(v.seed)] : Array.from({ length: Number(v.seeds) }, (_, i) => Number(v.from) + i)

for (const seed of seeds) {
  if (Date.now() > deadline) break
  const res = await runSeed(seed, { ...opts, onTick: s => {
    if (v.live && Date.now() - lastLive > 1000) { lastLive = Date.now(); console.log(`  seed ${seed}: ops ${s.ops}, syncs ${s.syncs}, lost req ${s.lostRequests}, lost resp ${s.lostResponses}, dup sends ${s.duplicates}, crashes ${s.crashes.afterLocalCommit + s.crashes.afterPush + s.crashes.afterPull}`) }
  } })
  results.push(res)
  total = sum(total, res.stats)
  console.log(`${res.ok ? 'ok  ' : 'FAIL'} seed ${String(seed).padStart(4)}  ops ${res.stats.ops}  server log ${res.stats.serverHead}  lost req/resp ${res.stats.lostRequests}/${res.stats.lostResponses}  dup sends ${res.stats.duplicates}  crashes ${res.stats.crashes.afterLocalCommit}/${res.stats.crashes.afterPush}/${res.stats.crashes.afterPull}  ${res.ms}ms${res.ok ? '' : `\n      ${res.reason}\n      reproduce: pnpm converge --seed ${seed} --replicas ${opts.replicas} --ops ${opts.ops}`}`)
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length} seeds, ${total.ops} operations, ${total.serverHead} ops in the server logs, ${((Date.now() - started) / 1000).toFixed(1)} s`)
console.log(`faults: ${total.lostRequests} lost requests, ${total.lostResponses} lost answers, ${total.duplicates} repeated requests, ${total.offlineRefusals} offline refusals`)
if (opts.clockAhead) console.log(`clock: ${total.clockAheadRefusals} pushes refused with 422 clock_ahead, repaired once the clock was fixed`)
console.log(`crashes: ${total.crashes.afterLocalCommit} after a local commit, ${total.crashes.afterPush} after a push (before the outbox row was removed), ${total.crashes.afterPull} after a pull (before applying)`)
const missing = EXPECTED_OPS.filter(n => !((total.structured[n] ?? 0) > 0))
console.log(`structured ops that wrote something (M7): ${EXPECTED_OPS.map(n => `${n} ${total.structured[n] ?? 0}`).join(', ')}`)
if (missing.length && results.length * opts.ops >= 20_000) { console.log(`COVERAGE: these ops never ran: ${missing.join(', ')}`); failed.push({ seed: 0, ok: false, stats: total, ms: 0, reason: 'coverage' }) }
console.log(failed.length ? `converged: NO (${failed.length} failed: ${failed.map(f => f.seed).join(', ')})` : 'converged: yes')
process.exit(failed.length ? 1 : 0)
