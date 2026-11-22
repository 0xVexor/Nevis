// ROADMAP M5 criteria 1 and 6, in the real app: Chromium and WebKit signed in to ONE account and workspace.
//  6: edit -> second device latency while both are online (p95 < 1.5 s on localhost; the LAN adds little).
//  1: both go offline, edit the SAME page's text and make separate pages, come back online: the page list and the text are
//     identical on both within 5 s. Run outside the Playwright runner (two different engines; see engines.spec.ts).
import { chromium, webkit } from '@playwright/test'
import { createNew, reopenWorkspace } from './shell-helpers.ts'

const BASE = process.env.BASE ?? `http://localhost:${process.env.NEVIS_TEST_PORT ?? 5174}`
const name = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const pw = 'correct horse battery'
const N = 60
const sleep = ms => new Promise(r => setTimeout(r, ms))
const body = p => p.getByTestId('editor').locator('.ProseMirror')
const text = p => body(p).innerText()
const rows = p => p.getByTestId('page-row').count()
const select = (p, i) => p.getByTestId('page-row').nth(i).dblclick()
async function until(fn, ms, what) {
  const t0 = Date.now()
  for (;;) { if (await fn()) return Date.now() - t0; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(20) }
}

const [bc, bw] = [await chromium.launch({ channel: 'chrome' }), await webkit.launch()]
let ok = false
try {
  const [ca, cb] = [await bc.newContext(), await bw.newContext()]
  const [a, b] = [await ca.newPage(), await cb.newPage()]

  await a.goto(BASE)
  await a.getByRole('button', { name: 'حساب ندارم' }).click()
  await a.locator('input[name=username]').fill(name)
  await a.locator('input[name=password]').fill(pw)
  await a.getByTestId('auth-submit').click()
  await a.getByTestId('recovery').waitFor()
  await a.getByTestId('ws-new').click()
  await createNew(a, 'new-page')
  await a.getByTestId('title').fill('مشترک')
  await body(a).click()
  await a.keyboard.type('شروع')
  await until(async () => (await a.getByTestId('outbox').innerText()) === '0', 10000, 'A outbox empty')

  await b.goto(BASE)
  await b.locator('input[name=username]').fill(name)
  await b.locator('input[name=password]').fill(pw)
  await b.getByTestId('auth-submit').click()
  await reopenWorkspace(b)
  await until(async () => (await rows(b)) === 1, 15000, 'B sees the page made in Chromium')
  await select(b, 0)
  await until(async () => (await text(b)).includes('شروع'), 10000, 'B sees the body')

  // criterion 6: N keystroke bursts in A, time until they show in B
  const lat = []
  for (let i = 0; i < N; i++) {
    const mark = `m${i}`
    await a.keyboard.type(` ${mark}`)
    lat.push(await until(async () => (await text(b)).includes(mark), 5000, `latency ${mark}`))
    await sleep(100)
  }
  lat.sort((x, y) => x - y)
  const p95 = lat[Math.ceil(lat.length * 0.95) - 1]
  console.log(`latency A->B ms: median ${lat[N >> 1]}, p95 ${p95}, max ${lat[N - 1]}`)
  if (p95 >= 1500) throw new Error(`p95 ${p95} ms >= 1500`)

  // criterion 1: both offline, same page + separate pages
  await ca.setOffline(true); await cb.setOffline(true)
  await until(async () => (await a.getByTestId('net').getAttribute('data-online')) === 'false'
    || (await a.getByTestId('net').innerText()).includes('آفلاین'), 15000, 'A notices offline').catch(() => {})
  await body(a).click(); await a.keyboard.type(' ویرایش‌کروم')
  await body(b).click(); await b.keyboard.type(' ویرایش‌وب‌کیت')
  await createNew(a, 'new-page'); await a.getByTestId('title').fill('صفحهٔ کروم')
  await createNew(b, 'new-page'); await b.getByTestId('title').fill('صفحهٔ وب‌کیت')
  await sleep(700)
  // guard: while offline the two sides must really differ, else the "convergence" below proves nothing
  const [ta, tb] = [await text(a), await text(b)]
  if (ta.includes('ویرایش‌وب‌کیت') || tb.includes('ویرایش‌کروم')) throw new Error('an edit crossed while both were offline')
  if ((await rows(a)) !== 2 || (await rows(b)) !== 2) throw new Error(`offline lists should have 2 pages each, got ${await rows(a)} and ${await rows(b)}`)
  if ((await a.getByTestId('outbox').innerText()) === '0' || (await b.getByTestId('outbox').innerText()) === '0') throw new Error('nothing waiting to send while offline')
  await ca.setOffline(false); await cb.setOffline(false)
  const t0 = Date.now()
  await until(async () => (await rows(a)) === 3 && (await rows(b)) === 3, 5000, 'both lists reach 3 pages within 5 s')
  // reselect the shared page (the first row) on both and compare
  await select(a, 0); await select(b, 0)
  await until(async () => { const [x, y] = [await text(a), await text(b)]; return x === y && x.includes('ویرایش‌کروم') && x.includes('ویرایش‌وب‌کیت') }, 5000, 'same text with both edits')
  console.log(`offline edits converged ${Date.now() - t0} ms after reconnecting: 3 pages, shared text identical with both edits`)
  ok = true
} finally { await bc.close(); await bw.close() }
process.exit(ok ? 0 : 1)
