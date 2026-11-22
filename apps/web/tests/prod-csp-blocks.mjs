// The PRODUCTION build under the server's strict content security policy, in each engine: the "all blocks" page renders (KaTeX, Mermaid,
// code highlighting, Excalidraw from our own origin, Persian fonts) with no console error and no CSP violation, and nothing is fetched
// from another origin.  node tests/prod-csp-blocks.mjs [chromium,webkit,firefox]
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit } from '@playwright/test'
import { createNew } from './shell-helpers.ts'

const root = new URL('../../..', import.meta.url).pathname
execFileSync(join(root, 'apps/web/node_modules/.bin/vite'), ['build', '--logLevel', 'error'], { cwd: join(root, 'apps/web'), stdio: 'inherit' })
const dir = mkdtempSync(join(tmpdir(), 'nevis-csp-'))
const exe = join(dir, 'nevis-server')
execFileSync('go', ['build', '-o', exe, './cmd/nevis-server'], { cwd: join(root, 'server'), stdio: 'inherit' })
const port = 8793, base = `http://localhost:${port}`
const srv = spawn(exe, [], { env: { ...process.env, SESSION_SECRET: 'x'.repeat(40), REGISTRATION: 'open', POW_BITS: '8', PORT: String(port), LISTEN_HOST: '127.0.0.1', DATA_DIR: join(dir, 'data'), WEB_DIR: join(root, 'apps/web/dist'), INSECURE_COOKIES: '1' }, stdio: 'ignore' })
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/v1/health`)).ok) break } catch { /* not up */ } await new Promise(r => setTimeout(r, 50)) }

const engines = (process.argv[2] ?? 'chromium,webkit,firefox').split(',')
let failed = 0
try {
  for (const e of engines) {
    const b = e === 'webkit' ? await webkit.launch() : e === 'firefox' ? await firefox.launch() : await chromium.launch({ channel: 'chrome' })
    const p = await (await b.newContext()).newPage()
    const bad = [], foreign = []
    // (the 401 is the pre-sign-in probe of /v1/me)
    p.on('console', m => { if (m.type() === 'error' && !/status of 401/.test(m.text())) bad.push(m.text()) })
    p.on('pageerror', x => bad.push('pageerror: ' + String(x)))
    p.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/v1/me')) bad.push(`HTTP ${r.status()} ${r.url()}`) })
    if (process.env.DEBUG_ASSETS) p.on('response', r => { if (r.url().includes('excalidraw-assets')) console.log('ASSET', r.status(), r.headers()['content-type'], r.url().slice(-70)) })
    p.on('request', r => { const u = new URL(r.url()); if (!['localhost', '127.0.0.1'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol) && u.hostname !== 'example.com') foreign.push(r.url()) })
    await p.addInitScript(() => document.addEventListener('securitypolicyviolation', ev => { (window.__csp ??= []).push(`${ev.violatedDirective} ${ev.blockedURI}`) }))
    await p.goto(base)
    await p.getByRole('button', { name: 'حساب ندارم' }).click()
    await p.locator('input[name=username]').fill('csp' + Date.now().toString(36))
    await p.locator('input[name=password]').fill('correct horse battery')
    await p.getByTestId('auth-submit').click()
    await p.getByTestId('recovery').waitFor()
    await p.getByTestId('ws-new').click()
    await createNew(p, 'new-all-blocks')
    await p.locator('.math-block .katex').waitFor({ timeout: 30000 })
    await p.locator('.mermaid-block').scrollIntoViewIfNeeded() // reference diagrams render when near the viewport
    await p.locator('.mermaid-block svg').waitFor({ timeout: 30000 })
    await p.locator('.code-wrap .hljs-keyword').first().waitFor({ timeout: 15000 })
    // the drawing editor: Excalidraw loads from /excalidraw-assets, offline-capable
    await p.locator('.drawing-block').hover()
    await p.getByTestId('drawing-edit').click()
    await p.locator('.drawing-modal .excalidraw').waitFor({ timeout: 60000 })
    await p.waitForTimeout(1500)
    const fontOk = await p.evaluate(() => document.fonts.check('16px Vazirmatn', 'سلام'))
    await p.getByTestId('drawing-save').click()
    const csp = await p.evaluate(() => window.__csp ?? [])
    const problems = [...bad, ...csp.map(c => 'CSP ' + c), ...foreign.map(f => 'foreign request ' + f)]
    console.log(`${e}: ${problems.length ? 'PROBLEMS\n  ' + problems.join('\n  ') : 'every block rendered; no console error, no CSP violation, nothing from another origin'}; Vazirmatn available: ${fontOk}`)
    if (problems.length || !fontOk) failed++
    await b.close()
  }
} finally { srv.kill() }
process.exit(failed ? 1 : 0)
