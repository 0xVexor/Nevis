// `Nevis --bench`: the IPC cost of the desktop store (ROADMAP M6). Types into the REAL editor bound to a DocHandle on the SQLite
// store, 10 keys a second for NEVIS_BENCH_SECONDS (default 60), through the same Client the app uses (300 ms throttle).
// Reports p50/p95 of `store_commit` alone and of a whole `run` (reads + commit), plus a 20-operation batch.
import { Client, DocHandle } from '@nevis/core'
import { createEditor } from '@nevis/editor'
import { appInfo, invoke, isDesktop, openDesktopStore } from './desktop'
import { uuidv7, SV } from '@nevis/protocol'
import { TauriStore } from '@nevis/store-tauri'

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] ?? 0 }
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 0.5).toFixed(2)}ms p95=${pct(xs, 0.95).toFixed(2)}ms max=${Math.max(0, ...xs).toFixed(2)}ms`

async function main() {
  if (!isDesktop) throw new Error('not running inside the desktop app')
  const seconds = (await appInfo()).benchSeconds
  const commits: number[] = [], runs: number[] = []
  const ws = `bench-${Date.now()}`
  const inner = openDesktopStore(ws, ms => commits.push(ms)) as TauriStore
  // time every whole transaction (reads over IPC + the commit)
  const store = { run: async <T>(fn: Parameters<TauriStore['run']>[0]) => { const t = performance.now(); try { return (await inner.run(fn)) as T } finally { runs.push(performance.now() - t) } } }
  const client = new Client({ store: store as never, ws, device: uuidv7(), sv: SV })
  const doc = uuidv7()
  const h = await DocHandle.open({ client, doc })
  const host = document.createElement('div'); document.body.append(host)
  const ed = createEditor(h.ydoc, host)
  ed.commands.focus()
  const words = ['سلام', 'دنیا', 'نوشتن', 'برنامه', 'hello', 'sync']
  const t0 = performance.now()
  for (let i = 0; performance.now() - t0 < seconds * 1000; i++) {
    ed.commands.insertContent(words[i % words.length]!.charAt(i % 3) || 'a')
    await new Promise(r => setTimeout(r, 100)) // 10 keys / s
  }
  await h.flush()
  const typing = { commits: [...commits], runs: [...runs] }
  // a heavier transaction: 20 writes in one commit
  commits.length = 0; runs.length = 0
  for (let k = 0; k < 40; k++) await store.run(async tx => { for (let i = 0; i < 20; i++) await tx.putFieldIfNewer(`e${k}`, `f${i}`, '"v"', `h${k}-${i}`) })
  const batch = { commits: [...commits], runs: [...runs] }
  const report = [
    `typing 10 keys/s for ${seconds}s in the editor (DocHandle, 300 ms throttle):`,
    `  store_commit  ${fmt(typing.commits)}`,
    `  whole run     ${fmt(typing.runs)}`,
    `20-write batch x40:`,
    `  store_commit  ${fmt(batch.commits)}`,
    `  whole run     ${fmt(batch.runs)}`,
    `p95 store_commit (typing): ${pct(typing.commits, 0.95).toFixed(2)} ms — limit 50 ms: ${pct(typing.commits, 0.95) < 50 ? 'PASS' : 'FAIL'}`,
  ].join('\n')
  document.getElementById('out')!.textContent = report
  await invoke('app_exit', { code: pct(typing.commits, 0.95) < 50 ? 0 : 1, report })
}
main().catch(async e => { await invoke('app_exit', { code: 2, report: `bench crashed: ${String((e as Error)?.stack ?? e)}` }) })
