import { expect, test, type Page } from '@playwright/test'
import { appReady, createNew, reopenWorkspace } from './shell-helpers'

// ROADMAP M11 (page history): a version is an event; restoring yesterday's text is an ordinary edit that reaches the other device.
const pw = 'correct horse battery'
async function openHistory(p: import('@playwright/test').Page) { if (!(await p.locator('.page-drawer.open').count())) await p.getByTestId('page-panel-toggle').click(); await p.getByTestId('open-history').click() }
test.setTimeout(180_000)
const body = (p: Page) => p.getByTestId('editor').locator('.ProseMirror')

async function start(page: Page) {
  const name = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
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
const settled = (p: Page) => expect(p.locator('span:has([data-testid=outbox])').first()).toHaveText(/: 0$/, { timeout: 30_000 })

test('save a version, change the page, restore it: the old text is back, a version of the newer text was kept, and the other device converges', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext()
  try {
    const a = await ca.newPage()
    const user = await start(a)
    await createNew(a, 'new-page')
    await a.getByTestId('title').fill('تاریخچه')
    await a.waitForTimeout(700)
    await body(a).click(); await a.keyboard.type('متن دیروز')
    await a.waitForTimeout(900)
    await openHistory(a)
    await a.getByTestId('history-save').click()
    await expect(a.getByTestId('history-row')).toHaveCount(1)
    await a.keyboard.press('Escape')
    await body(a).click(); await a.keyboard.press('Control+End'); await a.keyboard.type(' و متن امروز')
    await expect(body(a)).toContainText('و متن امروز')
    await a.waitForTimeout(900)
    await openHistory(a)
    await expect(a.getByTestId('history-preview')).toContainText('متن دیروز')
    await a.getByTestId('history-restore').click()
    await expect(body(a)).not.toContainText('و متن امروز')
    await expect(body(a)).toContainText('متن دیروز')
    // the newer text was saved as a version before the restore
    await openHistory(a)
    await expect.poll(() => a.getByTestId('history-row').count()).toBeGreaterThanOrEqual(2)
    await a.keyboard.press('Escape')
    await settled(a)
    // another device sees the restored text (a restore is an ordinary edit)
    const b = await cb.newPage()
    await b.goto('/')
    await b.locator('input[name=username]').fill(user)
    await b.locator('input[name=password]').fill(pw)
    await b.getByTestId('auth-submit').click()
    await reopenWorkspace(b)
    await expect(b.getByTestId('page-row')).toHaveCount(1, { timeout: 30_000 })
    await b.getByTestId('page-row').first().dblclick()
    await expect(body(b)).toContainText('متن دیروز', { timeout: 30_000 })
    await expect(body(b)).not.toContainText('و متن امروز')
  } finally { await ca.close(); await cb.close() }
})
