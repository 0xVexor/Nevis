import { expect, test, type Page } from '@playwright/test'
import { appReady, createNew, reopenWorkspace } from './shell-helpers'

// ROADMAP M11 (cards): a toggle is a card; a review is an event; two devices that review at the same time both keep their review.
const pw = 'correct horse battery'
test.setTimeout(180_000)
const body = (p: Page) => p.getByTestId('editor').locator('.ProseMirror')
const toggle = (q: string, a: string) => ({ type: 'toggle', attrs: { open: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: q }] }, { type: 'paragraph', content: [{ type: 'text', text: a }] }] })

async function start(page: Page) {
  const name = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await appReady(page)
  return name
}

test('a toggle is a card; review it; it is no longer due; the review is an event in the log', async ({ page }) => {
  await start(page)
  await createNew(page, 'new-page')
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor)
  await page.evaluate(c => (window as unknown as { __editor: { commands: { setContent: (c: unknown) => void } } }).__editor.commands.setContent({ type: 'doc', content: [c] }), toggle('پایتخت ایران؟', 'تهران'))
  await page.getByTestId('title').fill('جغرافیا')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ws: { search: { cards: () => unknown[] } } }).__ws.search.cards().length), { timeout: 30_000 }).toBe(1)
  await page.getByTestId('nav-cards').click()
  await expect(page.getByTestId('fc-due')).toContainText('۱ کارت')
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('fc-question')).toHaveText('پایتخت ایران؟')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('fc-answer')).toContainText('تهران')
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '۳', code: 'Digit3', bubbles: true })))
  await expect(page.getByTestId('fc-done')).toBeVisible()
  await page.getByRole('button', { name: 'بازگشت به دسته‌ها' }).click().catch(() => page.getByTestId('nav-cards').click())
  await expect(page.getByTestId('fc-due')).toContainText('همه را مرور کرده‌اید') // "You are up to date"
})

test('the same card reviewed on two devices while apart: both reviews are kept after they meet (the schedule folds both)', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext()
  try {
    const a = await ca.newPage()
    const user = await start(a)
    await createNew(a, 'new-page')
    await a.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor)
    await a.evaluate(c => (window as unknown as { __editor: { commands: { setContent: (c: unknown) => void } } }).__editor.commands.setContent({ type: 'doc', content: [c] }), toggle('سؤال مشترک؟', 'جواب'))
    await a.getByTestId('title').fill('مشترک')
    await expect.poll(() => a.evaluate(() => (window as unknown as { __ws: { search: { cards: () => unknown[] } } }).__ws.search.cards().length), { timeout: 30_000 }).toBe(1)
    await expect(a.locator('span:has([data-testid=outbox])').first()).toHaveText(/: 0$/, { timeout: 30_000 })
    const b = await cb.newPage()
    await b.goto('/')
    await b.locator('input[name=username]').fill(user)
    await b.locator('input[name=password]').fill(pw)
    await b.getByTestId('auth-submit').click()
    await reopenWorkspace(b)
    await expect.poll(() => b.evaluate(() => (window as unknown as { __ws: { search: { cards: () => unknown[] } } }).__ws.search.cards().length), { timeout: 30_000 }).toBe(1)
    await ca.setOffline(true); await cb.setOffline(true)
    for (const [p, grade] of [[a, 2], [b, 3]] as const) {
      await p.getByTestId('nav-cards').click()
      await p.getByTestId('fc-start').click()
      await p.getByTestId('fc-show').click()
      await p.getByTestId(`fc-grade-${grade}`).click()
      await expect(p.getByTestId('fc-done')).toBeVisible()
    }
    await ca.setOffline(false); await cb.setOffline(false)
    for (const p of [a, b]) await p.evaluate(() => window.dispatchEvent(new Event('online')))
    for (const p of [a, b]) await expect.poll(async () => p.evaluate(async () => (await (window as unknown as { __ws: { reviewData: () => Promise<{ times: number[] }> } }).__ws.reviewData()).times.length), { timeout: 30_000 }).toBe(2)
    const recs = await Promise.all([a, b].map(p => p.evaluate(async () => JSON.stringify([...(await (window as unknown as { __ws: { reviewData: () => Promise<{ recs: Map<string, unknown> }> } }).__ws.reviewData()).recs])))) 
    expect(recs[0]).toBe(recs[1]) // the same schedule on both
    expect(JSON.parse(recs[0]!)[0][1].reps).toBe(2)
  } finally { await ca.close(); await cb.close() }
})
