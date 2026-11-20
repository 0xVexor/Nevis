// pnpm --filter desktop test:kill [runs=10] — the app types one character every 50 ms; SIGKILL at a random moment; start again and
// count what survived. Only the last write window (300 ms throttle + the commit) may be missing.
import { spawn } from 'node:child_process'
import { appEnv, bin, build, runApp, sandbox } from './lib.mjs'

if (!process.env.NO_BUILD) build()
const runs = Number(process.argv[2] ?? 10)
let worst = 0, bad = 0
for (let i = 1; i <= runs; i++) {
  const sb = sandbox()
  const p = spawn(bin, ['--typing'], { env: appEnv(sb), stdio: ['ignore', 'pipe', 'pipe'] })
  let typed = 0, buf = ''
  p.stdout.on('data', d => { buf += d; for (const l of buf.split('\n')) { const m = /^KEY (\d+)$/.exec(l.trim()); if (m) typed = Math.max(typed, Number(m[1])) } buf = buf.slice(buf.lastIndexOf('\n') + 1) })
  const killAt = 1500 + Math.random() * 3000
  await new Promise(r => setTimeout(r, killAt))
  p.kill('SIGKILL')
  await new Promise(r => p.on('exit', r))
  const v = await runApp(['--typing'], appEnv(sb, { NEVIS_VERIFY: '1' }), 60_000)
  const found = Number(/FOUND (\d+)/.exec(v.out)?.[1] ?? NaN)
  const lost = typed - found
  const windowMs = lost * 50
  worst = Math.max(worst, windowMs)
  const ok = Number.isFinite(found) && lost >= 0 && windowMs <= 450 // 300 ms throttle + commit + log lag
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} run ${i}: typed ${typed}, found ${found}, lost ${lost} (~${windowMs} ms of typing)`)
}
console.log(`worst loss ${worst} ms; ${runs - bad}/${runs} within the 300 ms window (+150 ms slack for commit and log lag)`)
process.exitCode = bad ? 1 : 0
