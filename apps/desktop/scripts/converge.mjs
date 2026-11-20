// pnpm --filter desktop test:converge — ROADMAP M6: the desktop app and the web app on ONE account converge.
//  1. desktop (`--sync`, phase a): sign up, write a page, push.           2. web (Chromium): sign in, see it, add text and a page.
//  3. desktop restarts (phase b) WITHOUT signing in (token from the store): pulls; must hold the web's edits as well.
import { chromium } from '@playwright/test'
import { appEnv, build, runApp, sandbox, startServer } from './lib.mjs'

if (!process.env.NO_BUILD) build()
const srv = await startServer()
const user = `cv${Date.now().toString(36)}`
const sb = sandbox()
let ok = false
try {
  const a = await runApp(['--sync'], appEnv(sb, { NEVIS_SERVER: srv.url, NEVIS_USER: user, NEVIS_PHASE: 'a' }), 120_000)
  const ws = /WS (\S+)/.exec(a.out)?.[1]
  if (a.code !== 0 || !ws) throw new Error(`desktop phase a failed:\n${a.out}`)
  console.log(`desktop wrote a page in workspace ${ws}`)

  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const page = await (await browser.newContext({ baseURL: srv.url })).newPage()
    // the Go server serves the web bundle itself only with WEB_DIR; here the page comes from the built dist through a tiny route
    await page.route('**/*', async route => {
      const u = new URL(route.request().url())
      if (u.pathname.startsWith('/v1/')) return route.continue()
      const { readFileSync, existsSync } = await import('node:fs')
      const { join, extname } = await import('node:path')
      const file = join(new URL('../../web/dist', import.meta.url).pathname, u.pathname === '/' ? 'index.html' : u.pathname)
      if (!existsSync(file)) return route.fulfill({ status: 404 })
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
      return route.fulfill({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    })
    await page.goto(srv.url + '/')
    await page.locator('input[name=username]').fill(user)
    await page.locator('input[name=password]').fill('correct horse battery')
    await page.getByTestId('auth-submit').click()
    await page.getByTestId('ws-list').getByRole('button').first().click()
    await page.getByTestId('page-row').first().waitFor({ timeout: 15000 })
    const body = page.getByTestId('editor').locator('.ProseMirror')
    await page.getByTestId('page-row').first().getByRole('button').nth(1).click()
    await body.waitFor()
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('متن دسکتاپ'), null, { timeout: 15000 })
    console.log('web saw the desktop page and its text')
    await body.click(); await page.keyboard.type(' + متن وب')
    await page.getByTestId('new-page').click()
    await page.waitForFunction(() => document.querySelector('[data-testid=title]')?.value === '') // the NEW page is selected (else the fill renames the old one)
    await page.getByTestId('title').fill('صفحهٔ وب')
    await page.waitForFunction(() => document.querySelector('[data-testid=outbox]')?.textContent === '0', null, { timeout: 15000 })
    await page.waitForTimeout(500)
  } finally { await browser.close() }

  const b = await runApp(['--sync'], appEnv(sb, { NEVIS_SERVER: srv.url, NEVIS_USER: user, NEVIS_PHASE: 'b', NEVIS_WS: ws }), 120_000)
  const res = /RESULT (.+)/.exec(b.out)?.[1]
  if (b.code !== 0 || !res) throw new Error(`desktop phase b failed:\n${b.out}`)
  const { titles, text } = JSON.parse(res)
  if (!titles.includes('از دسکتاپ') || !titles.includes('صفحهٔ وب')) throw new Error(`titles: ${JSON.stringify(titles)}`)
  if (!text.some(t => t.includes('متن دسکتاپ') && t.includes('متن وب'))) throw new Error(`body text: ${JSON.stringify(text)}`)
  console.log(`desktop restarted without signing in and holds both sides: ${JSON.stringify(titles)}`)
  ok = true
} finally { srv.stop() }
process.exitCode = ok ? 0 : 1
