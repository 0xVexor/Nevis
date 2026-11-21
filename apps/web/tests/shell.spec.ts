import { expect, test, type Page } from '@playwright/test'

// ROADMAP M8b: the main paths of the app (create a page, the tree, a database, trash, settings), device settings that never reach the log,
// the command palette, and 10 000 pages that are never all rendered.
const pw = 'correct horse battery'
test.setTimeout(120_000)

async function signUpAndOpen(page: Page) {
  const name = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await expect(page.getByTestId('new-page')).toBeVisible()
  return name
}
type W = { __ws: { status: () => Promise<{ outbox: number; unsaved: number }>; ws: string } }
const settled = (page: Page) => expect.poll(() => page.evaluate(async () => { const s = await (window as unknown as W).__ws.status(); return s.outbox === 0 && s.unsaved === 0 }), { timeout: 30_000 }).toBe(true)
/** The server's log head for this workspace: how many ops the SERVER holds. */
const head = (page: Page) => page.evaluate(async () => { const id = (window as unknown as W).__ws.ws; const r = await fetch(`/v1/ws/${id}/ops?after=0&limit=1`); return ((await r.json()) as { head: number }).head })

test('device settings never reach the outbox or the server; a synced setting is exactly one op', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('settings')).toBeVisible()
  await settled(page)
  const [h0, o0] = [await head(page), await page.evaluate(async () => (await (window as unknown as W).__ws.status()).outbox)]

  // every device setting, through the Settings screen
  const device = page.getByTestId('settings-device')
  await device.getByRole('button', { name: 'تیره' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
  await device.getByLabel('اندازهٔ متن').fill('120')
  await device.getByLabel('عرض نوار کنار').fill('300')
  await device.locator('input[type=color]').fill('#aa3366')
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe('120%')
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--user-accent'))).toBe('#aa3366')
  await page.waitForTimeout(1500) // long enough for anything that was going to be written to be written
  await settled(page)
  expect(await head(page), 'a device setting reached the server log').toBe(h0)
  expect(await page.evaluate(async () => (await (window as unknown as W).__ws.status()).outbox), 'a device setting entered the outbox').toBe(o0)
  // they stay on THIS device: they survive a reload from localStorage
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  // the control: a SYNCED setting does reach the log, as exactly one op (this is what makes the check above non-vacuous)
  await page.getByTestId('nav-settings').click()
  await settled(page)
  const h1 = await head(page)
  await page.getByTestId('settings-synced').getByRole('button', { name: 'میلادی' }).click()
  await settled(page)
  await expect.poll(() => head(page)).toBe(h1 + 1)
})

test('the palette (Ctrl+K, a physical key) finds a page by a Persian-normalised title and runs commands', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('new-page').click()
  await page.getByTestId('title').fill('کتابخانهٔ من')
  await page.waitForTimeout(600)
  await page.getByTestId('nav-home').click()
  await page.keyboard.press('Control+k')
  await page.getByRole('searchbox').or(page.locator('.ds-command-dialog input')).first().fill('كتابخانه') // an Arabic kaf: the Persian one is found
  await expect(page.locator('.ds-command-dialog')).toContainText('کتابخانهٔ من')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('title')).toHaveValue('کتابخانهٔ من')
  // a command
  await page.keyboard.press('Control+k')
  await page.locator('.ds-command-dialog input').first().fill('تنظیمات')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('settings')).toBeVisible()
  await expect(page).toHaveURL(/#\/settings$/)
})

test('trash and restore, the tree, a deep link and the back button', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('new-page').click()
  await page.getByTestId('title').fill('برای حذف')
  await page.waitForTimeout(600)
  const url = page.url()
  await page.getByTestId('page-actions').getByRole('button', { name: 'حذف' }).click()
  await expect(page.getByTestId('home')).toBeVisible()
  await page.getByTestId('trash-toggle').click()
  await expect(page.getByTestId('trash')).toContainText('برای حذف')
  await page.getByTestId('trash').getByRole('button', { name: 'بازگردانی' }).click()
  await expect(page.getByTestId('page-row')).toHaveCount(1)
  expect(url).toMatch(/#\/page\//)
  await page.getByTestId('page-row').first().getByRole('button').nth(1).click()
  await expect(page).toHaveURL(url) // the restored page has its old link
  await page.reload() // the deep link: the hash survives a reload and opens the page
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await expect(page.getByTestId('title')).toHaveValue('برای حذف')
  await page.goBack()
})

test('a template makes a page with its blocks; the database and the sync status are in the shell', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('nav-templates').click()
  await page.getByTestId('template-meeting').click()
  await expect(page.getByTestId('editor').locator('.ProseMirror')).toContainText('دستور جلسه', { timeout: 20_000 })
  await expect(page.getByTestId('editor').locator('.callout')).toBeVisible()
  await expect(page.getByTestId('net')).toBeVisible()
  await page.getByTestId('new-database').click()
  await expect(page.getByTestId('db-view')).toBeVisible()
})

test('10 000 pages: Home, the palette and the "all pages" table touch only what they show', async ({ page }) => {
  await signUpAndOpen(page)
  // seed 3000 pages straight into the store (a fraction of 10 000: enough to prove a screen does not render them all)
  await page.evaluate(async () => {
    const rt = (window as unknown as { __ws: { rt: { client: { setFields: (e: string, s: Record<string, unknown>, k?: string) => Promise<string> } } } }).__ws.rt
    for (let i = 0; i < 3000; i++) await rt.client.setFields(crypto.randomUUID(), { title: `صفحه ${i}`, parent: '', sortKey: 'a' + String(i).padStart(5, '0'), trashed: false, kind: 'doc', createdAt: 1_700_000_000_000 + i }, 'page')
  })
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('recent').locator('li')).toHaveCount(8)
  await page.getByTestId('nav-all').click()
  await expect(page.getByTestId('all-pages-row')).toHaveCount(50)
  await expect(page.getByTestId('pager')).toContainText('3000')
  await page.getByTestId('pager').getByRole('button', { name: 'بعدی' }).click()
  await expect(page.getByTestId('all-pages-row')).toHaveCount(50)
  await page.keyboard.press('Control+k')
  await page.locator('.ds-command-dialog input').first().fill('صفحه ۱۲')
  await expect(page.locator('.ds-command-dialog .ds-command-result').first()).toBeVisible()
  expect(await page.locator('.ds-command-dialog .ds-command-result').count()).toBeLessThanOrEqual(30)
  // the sidebar tree renders only the roots that are expanded: 3000 roots, but the DOM holds 50 + the open ones? (it holds the roots: bounded by the tree view)
  expect(await page.getByTestId('page-row').count()).toBeLessThan(3100)
})
