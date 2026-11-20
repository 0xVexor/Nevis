// Two different browser engines (Chromium and WebKit) on one workspace of the real server: both edit while offline, then both
// come online and must converge. Run outside the Playwright test runner, which would force one `channel` on both launches.
import { chromium, webkit } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://localhost:5174'
const ws = randomUUID()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const lab = (page, fn, ...args) => page.evaluate(fn, ...args)

async function open(ctx) {
  const page = await ctx.newPage()
  await page.goto(`${BASE}/?ws=${ws}`)
  await page.evaluate(() => window.__labReady)
  return page
}
async function settle(page) {
  const t0 = Date.now()
  for (;;) {
    const s = await page.evaluate(() => window.__lab.status())
    const head = await page.evaluate(async w => (await (await fetch(`/v1/ws/${w}/ops?after=0&limit=1`, { headers: { Authorization: 'Bearer dev' } })).json()).head, ws)
    if (s.outbox === 0 && s.inbox === 0 && s.cursor === head && s.leader) return
    if (Date.now() - t0 > 60000) throw new Error(`did not settle: ${JSON.stringify(s)} head ${head}`)
    await sleep(100)
  }
}
const projection = page => page.evaluate(async () => JSON.stringify(await window.__lab.projection()))

const [bc, bw] = [await chromium.launch({ channel: 'chrome' }), await webkit.launch()]
let ok = false
try {
  const [ca, cb] = [await bc.newContext(), await bw.newContext()]
  const a = await open(ca)
  await a.evaluate(() => window.__lab.createNotes(5))
  await settle(a)
  const b = await open(cb)
  await settle(b)
  const before = await projection(b)
  if (!before.includes('یادداشت 1')) throw new Error('WebKit did not receive the notes made in Chromium')

  for (const p of [a, b]) await p.evaluate(() => { window.__lab.offline = true })
  const ids = await a.evaluate(async () => (await window.__lab.notes()).map(n => n.id))
  await a.evaluate(async ([x]) => { const l = window.__lab; await l.editTitle(x, 'عنوان از Chrome'); await l.newNote('فقط در Chrome') }, ids)
  await b.evaluate(async ([, y]) => { const l = window.__lab; await l.editTitle(y, 'عنوان از WebKit'); await l.client.setFields(y, { count: 77 }); await l.newNote('فقط در WebKit') }, ids)
  if ((await projection(a)) === (await projection(b))) throw new Error('the two engines should differ while offline')

  for (const p of [a, b]) await p.evaluate(() => { window.__lab.offline = false })
  await settle(a); await settle(b); await settle(a)
  const [pa, pb] = [await projection(a), await projection(b)]
  if (pa !== pb) throw new Error('the two engines did not converge')
  for (const needle of ['عنوان از Chrome', 'عنوان از WebKit', 'فقط در Chrome', 'فقط در WebKit', '77']) if (!pa.includes(needle)) throw new Error(`lost an edit: ${needle}`)
  console.log(`Chromium and WebKit converged after offline edits on both sides: ${Object.keys(JSON.parse(pa).fields).length} entities, all four edits kept`)
  ok = true
} finally { await bc.close(); await bw.close() }
process.exit(ok ? 0 : 1)
