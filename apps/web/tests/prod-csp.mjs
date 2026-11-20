// Manual check against a running demo server: node tests/prod-csp.mjs http://localhost:8788
import { chromium, firefox, webkit } from '@playwright/test'
// node tests/prod-csp.mjs [url] [chromium|webkit|firefox]
const base = process.argv[2] ?? 'http://localhost:8788'
const engine = process.argv[3] ?? 'chromium'
const b = engine === 'webkit' ? await webkit.launch() : engine === 'firefox' ? await firefox.launch() : await chromium.launch({ channel: 'chrome' })
const ctx = await b.newContext()
const p = await ctx.newPage()
p.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.request().method(), r.url()) })
const bad = []
p.on('console', m => { if (m.type() === 'error') bad.push(m.text()) })
p.on('pageerror', e => bad.push(String(e)))
await p.goto(base)
await p.getByRole('button', { name: 'حساب ندارم' }).click()
await p.locator('input[name=username]').fill('csp' + Date.now().toString(36))
await p.locator('input[name=password]').fill('correct horse battery')
await p.getByTestId('auth-submit').click()
await p.getByTestId('recovery').waitFor()
await p.getByTestId('ws-new').click()
await p.getByTestId('status').waitFor()
await p.getByRole('button', { name: 'یادداشت تازه' }).click()
await p.waitForTimeout(3500)
console.log('outbox', await p.getByTestId('outbox').innerText(), 'cursor', await p.getByTestId('cursor').innerText())
const ck = (await ctx.cookies()).find(c => c.name === 'nevis_session')
console.log(engine, 'cookie:', ck ? `stored (secure=${ck.secure}, httpOnly=${ck.httpOnly}, sameSite=${ck.sameSite})` : 'NOT STORED')
console.log(bad.length ? 'ERRORS:\n' + bad.join('\n') : 'no console errors / CSP violations')
await b.close()
