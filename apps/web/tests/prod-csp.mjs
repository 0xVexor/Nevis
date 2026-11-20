// Manual check against a running demo server: node tests/prod-csp.mjs http://localhost:8788
import { chromium } from '@playwright/test'
const base = process.argv[2] ?? 'http://localhost:8788'
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage()
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
console.log(bad.length ? 'ERRORS:\n' + bad.join('\n') : 'no console errors / CSP violations')
await b.close()
