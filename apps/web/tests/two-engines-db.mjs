// ROADMAP M7 demo, automated: Chromium and WebKit on ONE account, both OFFLINE, edit DIFFERENT cells of the SAME row and each adds a
// select option; online again, everything is kept on both. The offline phase is guarded (the sides must really differ), as in M5.
import { chromium, webkit } from '@playwright/test'
import { addProp } from './db-helpers.ts'
import { createNew, reopenWorkspace } from './shell-helpers.ts'

const BASE = process.env.BASE ?? `http://localhost:${process.env.NEVIS_TEST_PORT ?? 5174}`
const name = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const pw = 'correct horse battery'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cell = (p, prop, row = 0) => p.locator(`[data-testid=cell][data-prop="${prop}"][data-row="${row}"]`)
async function until(fn, ms, what) {
  const t0 = Date.now()
  for (;;) { if (await fn()) return Date.now() - t0; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(25) }
}
const options = async (p, prop) => {
  await cell(p, prop).locator('.ds-dd-btn').click()
  const labels = (await p.locator('.ds-pop').last().getByRole('menuitem').allTextContents()).filter(t => t !== '—').sort()
  await p.keyboard.press('Escape')
  await p.locator('.ds-pop').last().waitFor({ state: 'detached' })
  return labels
}
const outbox = async p => Number(await p.getByTestId('outbox').innerText())

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
  await createNew(a, 'new-database')
  await a.getByTestId('db-title').fill('کتاب‌ها')
  for (const [n, t] of [['الف', 'text'], ['ب', 'text'], ['ژانر', 'select']]) {
    await addProp(a, n, t)
    await a.locator(`th[data-prop="${n}"]`).waitFor()
  }
  await a.getByTestId('db-add-row').click()
  await a.getByTestId('db-row').first().waitFor()
  await until(async () => (await outbox(a)) === 0, 15000, 'A synced')

  await b.goto(BASE)
  await b.locator('input[name=username]').fill(name)
  await b.locator('input[name=password]').fill(pw)
  await b.getByTestId('auth-submit').click()
  await reopenWorkspace(b)
  await until(async () => (await b.getByTestId('page-row').count()) === 1, 15000, 'B sees the database')
  await b.getByTestId('page-row').first().dblclick()
  await until(async () => (await b.getByTestId('db-row').count()) === 1 && (await b.locator('th[data-prop="ژانر"]').count()) === 1, 15000, 'B sees the row and the columns')

  await ca.setOffline(true); await cb.setOffline(true)
  await sleep(500)
  // different cells of the same row; one new option each
  await cell(a, 'الف').locator('input').fill('از کروم'); await cell(a, 'الف').locator('input').blur()
  await cell(b, 'ب').locator('input').fill('از وب‌کیت'); await cell(b, 'ب').locator('input').blur()
  await a.locator('th[data-prop="ژانر"]').getByTestId('opt-name').fill('گزینهٔ کروم'); await a.locator('th[data-prop="ژانر"]').getByTestId('opt-add').click()
  await b.locator('th[data-prop="ژانر"]').getByTestId('opt-name').fill('گزینهٔ وب‌کیت'); await b.locator('th[data-prop="ژانر"]').getByTestId('opt-add').click()
  await sleep(800)
  // guard: really apart while offline
  if ((await cell(a, 'ب').locator('input').inputValue()) !== '' || (await cell(b, 'الف').locator('input').inputValue()) !== '') throw new Error('an edit crossed while both were offline')
  if ((await options(a, 'ژانر')).join() !== 'گزینهٔ کروم' || (await options(b, 'ژانر')).join() !== 'گزینهٔ وب‌کیت') throw new Error(`options should differ while offline: ${await options(a, 'ژانر')} | ${await options(b, 'ژانر')}`)
  if ((await outbox(a)) === 0 || (await outbox(b)) === 0) throw new Error('nothing waiting to send while offline')

  await ca.setOffline(false); await cb.setOffline(false)
  const t0 = Date.now()
  const want = ['گزینهٔ کروم', 'گزینهٔ وب‌کیت'].sort().join()
  await until(async () => (await options(a, 'ژانر')).join() === want && (await options(b, 'ژانر')).join() === want, 8000, 'both options on both')
  await until(async () => {
    for (const p of [a, b]) if ((await cell(p, 'الف').locator('input').inputValue()) !== 'از کروم' || (await cell(p, 'ب').locator('input').inputValue()) !== 'از وب‌کیت') return false
    return true
  }, 8000, 'both cells on both')
  console.log(`offline edits of two cells of one row + one select option on each side: all kept on both devices ${Date.now() - t0} ms after reconnecting`)
  ok = true
} finally { await bc.close(); await bw.close() }
process.exit(ok ? 0 : 1)
