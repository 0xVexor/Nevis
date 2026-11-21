// ROADMAP M8a demo, automated: the "all blocks" page on ONE account in Chromium and WebKit; both OFFLINE: one types in the callout, the
// other edits a table cell and adds a row; online again, the pages are identical and hold both edits. Offline phase guarded (as in M5/M7).
import { chromium, webkit } from '@playwright/test'
import { createNew } from './shell-helpers.ts'

const BASE = process.env.BASE ?? 'http://localhost:5174'
const name = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { if (await fn()) return Date.now() - t0; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(25) } }
const doc = p => p.evaluate(() => JSON.stringify(window.__editor.getJSON()))
const status = p => p.evaluate(async () => { const s = await window.__ws.status(); return s.outbox + s.unsaved })
const ids = s => s.replace(/"blockId":"[^"]*"/g, '"blockId":""')

const [bc, bw] = [await chromium.launch({ channel: 'chrome' }), await webkit.launch()]
let ok = false
try {
  const [ca, cb] = [await bc.newContext(), await bw.newContext()]
  const [a, b] = [await ca.newPage(), await cb.newPage()]
  await a.goto(BASE)
  await a.getByRole('button', { name: 'حساب ندارم' }).click()
  await a.locator('input[name=username]').fill(name)
  await a.locator('input[name=password]').fill('correct horse battery')
  await a.getByTestId('auth-submit').click()
  await a.getByTestId('recovery').waitFor()
  await a.getByTestId('ws-new').click()
  await createNew(a, 'new-all-blocks')
  await a.locator('.callout').waitFor({ timeout: 30000 })
  await a.locator('.mermaid-block svg').waitFor({ timeout: 30000 })
  await until(async () => (await status(a)) === 0, 20000, 'A synced')

  await b.goto(BASE)
  await b.locator('input[name=username]').fill(name)
  await b.locator('input[name=password]').fill('correct horse battery')
  await b.getByTestId('auth-submit').click()
  await b.getByTestId('ws-list').getByRole('button').first().click()
  await until(async () => (await b.getByTestId('page-row').count()) === 1, 15000, 'B sees the page')
  await b.getByTestId('page-row').first().dblclick()
  await b.locator('.callout').waitFor({ timeout: 30000 })
  await b.locator('.math-block .katex').waitFor({ timeout: 30000 })
  if (ids(await doc(a)) !== ids(await doc(b))) throw new Error('the two devices differ before the offline phase')

  await ca.setOffline(true); await cb.setOffline(true)
  await sleep(500)
  // A: types at the end of the callout's paragraph. B: appends to a table cell and adds a row.
  await a.evaluate(() => { const e = window.__editor; let pos = -1; e.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === 'callout') pos = p + 1 + n.firstChild.nodeSize - 1; return pos < 0 }); e.chain().focus().insertContentAt(pos, ' (ویرایش کروم)').run() })
  await b.evaluate(() => { const e = window.__editor; let pos = -1; e.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === 'tableCell' && n.textContent === '۱') pos = p + 1 + n.firstChild.nodeSize - 1; return pos < 0 }); e.chain().focus().insertContentAt(pos, ' (ویرایش وب‌کیت)').setTextSelection(pos).addRowAfter().run() })
  await sleep(900)
  const [da, db] = [await doc(a), await doc(b)]
  if (da.includes('ویرایش وب‌کیت') || db.includes('ویرایش کروم')) throw new Error('an edit crossed while both were offline')
  if (ids(da) === ids(db)) throw new Error('the two sides should differ while offline')
  if ((await status(a)) === 0 || (await status(b)) === 0) throw new Error('nothing waiting to send while offline')

  await ca.setOffline(false); await cb.setOffline(false)
  const t0 = Date.now()
  await until(async () => { const [x, y] = [ids(await doc(a)), ids(await doc(b))]; return x === y && x.includes('ویرایش کروم') && x.includes('ویرایش وب‌کیت') }, 10000, 'identical pages holding both edits')
  const rows = (JSON.parse(await doc(a)).content.find(n => n.type === 'table').content).length
  if (rows !== 3) throw new Error(`the table should have 3 rows (2 + the added one), has ${rows}`)
  console.log(`concurrent callout and table edits kept on both devices ${Date.now() - t0} ms after reconnecting; table has ${rows} rows`)
  ok = true
} finally { await bc.close(); await bw.close() }
process.exit(ok ? 0 : 1)
