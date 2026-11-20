import { expect, test } from '@playwright/test'
import { newWs, open, projection, settle, sleep } from './helpers'

// ROADMAP M3 criterion 2: close the page at a random moment during a burst of writes, many times. After reopening, nothing
// that was committed is lost and no write is half-done: once synced, the device shows exactly what the server's log makes.
test('closing the page at random moments during writes: nothing lost, nothing half-written', async ({ browser, browserName }) => {
  const ITERATIONS = browserName === 'chromium' ? 50 : 25
  const ws = newWs()
  const a = await browser.newContext()
  const observer = await browser.newContext() // a second, fresh browser profile that only reads the server's log
  let page = await open(a, ws)
  await page.evaluate(() => (window as unknown as { __lab: { createNotes(n: number): Promise<void> } }).__lab.createNotes(100))
  await settle(page, ws)
  await page.close()

  const cut: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    page = await open(a, ws)
    void page.evaluate(() => (window as unknown as { __lab: { burst(n: number): Promise<void> } }).__lab.burst(3)).catch(() => undefined)
    const ms = 10 + Math.floor(Math.random() * 240)
    cut.push(ms)
    await sleep(ms)
    await page.close() // like swiping the app away or killing the tab: no beforeunload, no cleanup
  }

  page = await open(a, ws)
  const s = await settle(page, ws)
  const b = await open(observer, ws)
  await settle(b, ws)
  const [mine, theirs] = [await projection(page), await projection(b)]
  console.log(`${browserName}: ${ITERATIONS} closes at ${Math.min(...cut)}-${Math.max(...cut)} ms into a burst; ${s.notes} notes; the device and the server's log agree: ${mine === theirs}`)
  expect(mine).toBe(theirs)
  expect(JSON.parse(mine).fields).not.toEqual({})
  await a.close(); await observer.close()
})
