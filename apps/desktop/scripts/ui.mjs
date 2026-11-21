// pnpm --filter desktop test:ui — the REAL UI of the app, driven from inside its WebView (`--ui-test`), and the window close.
//  launch 1: server form -> sign up through the form -> workspace -> page -> type -> close the window AT ONCE (the flush on close
//            must save text typed inside the 300 ms throttle); the process must exit by itself within 5.5 s.
//  launch 4: restart; the "all blocks" page is made and every block renders in the desktop WebView (its own CSP);
//  launch 2: restart (no server form, no sign-in): the workspace list; the page has the text; sign out.
//  launch 3: restart after sign-out: the sign-in form.
import { spawn } from 'node:child_process'
import { appEnv, bin, build, runApp, sandbox, startServer } from './lib.mjs'

if (!process.env.NO_BUILD) build()
const srv = await startServer()
const sb = sandbox()
const user = `ui${Date.now().toString(36)}`
const cfg = phase => JSON.stringify({ phase, server: srv.url, user, password: 'correct horse battery' })
let ok = false
try {
  // launch 1 is timed from the moment the app says CLOSING until the process is gone
  const t = await new Promise(resolve => {
    const p = spawn(bin, ['--ui-test'], { env: appEnv(sb, { NEVIS_UI_CFG: cfg(1) }), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', closingAt = 0
    const kill = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: 124, out: out + '\ntimeout (the app did not exit)', ms: -1 }) }, 90_000)
    const on = d => { out += d; if (!closingAt && out.includes('CLOSING')) closingAt = Date.now() }
    p.stdout.on('data', on); p.stderr.on('data', on)
    p.on('exit', code => { clearTimeout(kill); resolve({ code, out, ms: closingAt ? Date.now() - closingAt : -1 }) })
  })
  console.log(t.out.trim().split('\n').filter(l => /CLOSING|failed|timeout|panic/i.test(l)).join('\n'))
  if (t.code !== 0 || t.ms < 0) throw new Error(`launch 1 failed (code ${t.code}):\n${t.out}`)
  console.log(`launch 1: signed up through the form, typed, closed at once; the app exited ${t.ms} ms after the close`)
  if (t.ms > 5500) throw new Error(`closing took ${t.ms} ms (limit 5 s + slack)`)

  const d = await runApp(['--ui-test'], appEnv(sb, { NEVIS_UI_CFG: cfg(4) }), 180_000)
  console.log(d.out.trim().split('\n').filter(l => /UI-PHASE|failed/.test(l)).join('\n'))
  if (d.code !== 0) throw new Error(`launch 4 (all blocks) failed (code ${d.code}):\n${d.out}`)
  const b = await runApp(['--ui-test'], appEnv(sb, { NEVIS_UI_CFG: cfg(2) }), 90_000)
  console.log(b.out.trim().split('\n').filter(l => /UI-PHASE|failed/.test(l)).join('\n'))
  if (b.code !== 0) throw new Error(`launch 2 failed (code ${b.code}):\n${b.out}`)
  const c = await runApp(['--ui-test'], appEnv(sb, { NEVIS_UI_CFG: cfg(3) }), 90_000)
  console.log(c.out.trim().split('\n').filter(l => /UI-PHASE|failed/.test(l)).join('\n'))
  if (c.code !== 0) throw new Error(`launch 3 failed (code ${c.code}):\n${c.out}`)
  ok = true
} finally { srv.stop() }
process.exitCode = ok ? 0 : 1
