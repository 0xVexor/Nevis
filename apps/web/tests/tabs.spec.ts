import { expect, test } from '@playwright/test'
import { newWs, open, sleep, status } from './helpers'

const leaderOf = async (pages: import('@playwright/test').Page[]) => (await Promise.all(pages.map(async p => (p.isClosed() ? false : (await status(p)).leader)))).filter(Boolean).length

test('two tabs: exactly one leader; closing it hands over within 2 s', async ({ context, browserName }) => {
  const ws = newWs()
  const t1 = await open(context, ws)
  const t2 = await open(context, ws)
  let n = 0
  for (let i = 0; i < 30 && (n = await leaderOf([t1, t2])) !== 1; i++) await sleep(100)
  expect(n, 'exactly one leader').toBe(1)
  const leader = (await status(t1)).leader ? t1 : t2
  const other = leader === t1 ? t2 : t1
  const t0 = Date.now()
  await leader.close()
  let took = -1
  while (Date.now() - t0 < 5000) { if ((await status(other)).leader) { took = Date.now() - t0; break } await sleep(50) }
  console.log(`${browserName}: leader handoff took ${took} ms`)
  expect(took).toBeGreaterThanOrEqual(0)
  expect(took).toBeLessThanOrEqual(2000)
})

test('a change in one tab shows in the other within 1 s, with the network off (BroadcastChannel only)', async ({ context, browserName }) => {
  const ws = newWs()
  const t1 = await open(context, ws)
  const t2 = await open(context, ws)
  for (const p of [t1, t2]) await p.evaluate(() => { (window as unknown as { __lab: { offline: boolean } }).__lab.offline = true })
  const before = (await status(t2)).notes
  const t0 = Date.now()
  await t1.evaluate(() => (window as unknown as { __lab: { newNote(): Promise<string> } }).__lab.newNote())
  let took = -1
  while (Date.now() - t0 < 3000) { if ((await status(t2)).notes === before + 1) { took = Date.now() - t0; break } await sleep(25) }
  console.log(`${browserName}: a change reached the other tab in ${took} ms`)
  expect(took).toBeGreaterThanOrEqual(0)
  expect(took).toBeLessThanOrEqual(1000)
})

test('navigator.storage.persist() is asked on the first load and the answer is shown', async ({ context, browserName }) => {
  const page = await open(context, newWs())
  const s = await status(page)
  console.log(`${browserName}: persisted() = ${s.persisted}, estimate() usage ${s.usage}, quota ${s.quota}`)
  expect(['true', 'false', 'null']).toContain(String(s.persisted))
  await expect(page.getByTestId('persisted')).toHaveText(String(s.persisted))
})
