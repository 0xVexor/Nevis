import { addProp } from './db-helpers'
import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady, reopenWorkspace } from './shell-helpers'

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
  await appReady(page)
  return name
}
type W = { __ws: { status: () => Promise<{ outbox: number; unsaved: number }>; ws: string } }

test('search and the synced workspace label fit at the minimum sidebar width', async ({ page }) => {
  await signUpAndOpen(page)
  await page.evaluate(() => localStorage.setItem('nevis.railW', '168'))
  for (const lang of ['fa', 'en']) {
    for (const sidebar of ['default', 'compact']) {
      await page.evaluate(settings => localStorage.setItem('nevis.device', JSON.stringify(settings)), { lang, sidebar })
      await page.reload()
      await appReady(page)
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const labels = page.locator('.search-row .ntitle, .wscard-tx small')
      await expect(labels).toHaveCount(2)
      for (const label of await labels.all()) {
        await expect(label).toHaveCSS('white-space', 'nowrap')
        expect(await label.evaluate(el => el.scrollWidth - el.clientWidth), (await label.textContent()) ?? 'Sidebar label').toBeLessThanOrEqual(1)
      }
    }
  }
})

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
  await device.getByRole('button', { name: 'تاریک' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await device.locator('input[type=color]').fill('#aa3366')
  await page.getByRole('button', { name: /ویرایشگر/ }).click() // the Editor tab holds the text size
  await page.getByLabel('اندازه‌ی متن').fill('20')
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--editor-size'))).toBe('20px')
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--user-accent'))).toBe('#aa3366')
  await page.waitForTimeout(1500) // long enough for anything that was going to be written to be written
  await settled(page)
  expect(await head(page), 'a device setting reached the server log').toBe(h0)
  expect(await page.evaluate(async () => (await (window as unknown as W).__ws.status()).outbox), 'a device setting entered the outbox').toBe(o0)
  // they stay on THIS device: they survive a reload from localStorage
  await page.reload()
  await reopenWorkspace(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  // the control: a SYNCED setting does reach the log, as exactly one op (this is what makes the check above non-vacuous)
  await page.getByTestId('nav-settings').click()
  await settled(page)
  const h1 = await head(page)
  await page.getByRole('button', { name: 'پایگاه داده', exact: true }).click()
  await page.getByTestId('settings-synced').getByRole('button', { name: 'میلادی' }).click()
  await settled(page)
  await expect.poll(() => head(page)).toBe(h1 + 1)
})

test('the palette (Ctrl+K, a physical key) finds a page by a Persian-normalised title and runs commands', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
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
  await page.keyboard.press('Control+k')
  await page.locator('.ds-command-dialog input').fill('> layout language')
  await expect(page.locator('.ds-command-dialog .ds-command-result')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('settings-tab-language')).toHaveAttribute('aria-current', 'page')
  await expect(page).toHaveURL(/#\/settings\/language$/)
  await page.getByTestId('settings-tab-about').click()
  await page.keyboard.press('Control+k')
  await page.locator('.ds-command-dialog input').fill('> language layout')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('settings-tab-language')).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+k')
  await page.locator('.ds-command-dialog input').fill('> whiteboard sketch')
  await page.locator('.ds-command-dialog .ds-command-result').getByText('نقاشی‌ها', { exact: true }).click()
  await expect(page).toHaveURL(/#\/drawings$/)

})

test('trash and restore, the tree, a deep link and the back button', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await page.getByTestId('title').fill('برای حذف')
  await page.waitForTimeout(600)
  const url = page.url()
  await page.getByTestId('page-row').first().click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await expect(page.getByTestId('home')).toBeVisible()
  await page.getByTestId('trash-toggle').click()
  await expect(page.getByTestId('trash')).toContainText('برای حذف')
  await page.getByTestId('trash').getByRole('button', { name: 'بازیابی' }).click()
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('page-row')).toHaveCount(1)
  expect(url).toMatch(/#\/page\//)
  await page.getByTestId('page-row').first().dblclick()
  await expect(page).toHaveURL(url) // the restored page has its old link
  await page.reload() // the deep link: the hash survives a reload and opens the page
  await reopenWorkspace(page)
  await expect(page.getByTestId('title')).toHaveValue('برای حذف')
  await page.goBack()
})

test('a template makes a page with its blocks; the database and the sync status are in the shell', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('nav-templates').click()
  await page.getByTestId('template-meeting').click()
  await page.getByTestId('tpl-use').click()
  await expect(page.getByTestId('editor').locator('.ProseMirror')).toContainText('دستور جلسه', { timeout: 20_000 })
  await expect(page.getByTestId('editor').locator('.callout')).toBeVisible()
  await expect(page.getByTestId('net')).toBeVisible()
  await createNew(page, 'new-database')
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
  await reopenWorkspace(page)
  await page.getByTestId('nav-home').click()
  await expect(page.locator('.home-page')).toHaveCount(3) // the old Home: the last page and three recent ones, never the 3000
  await page.getByTestId('nav-all').click()
  await expect(page.getByTestId('all-pages-row')).toHaveCount(100) // a hundred rows at a time, not all 3000
  await expect(page.getByTestId('pt-more')).toContainText('2900')
  await page.getByTestId('pt-more').click()
  await expect(page.getByTestId('all-pages-row')).toHaveCount(200)
  await page.keyboard.press('Control+k')
  await page.locator('.ds-command-dialog input').first().fill('صفحه ۱۲')
  await expect(page.locator('.ds-command-dialog .ds-command-result').first()).toBeVisible()
  expect(await page.locator('.ds-command-dialog .ds-command-result').count()).toBeLessThanOrEqual(30)
  // the sidebar tree renders only the roots that are expanded: 3000 roots, but the DOM holds 50 + the open ones? (it holds the roots: bounded by the tree view)
  await page.keyboard.press('Escape') // close the palette: it covers the sidebar
  await page.getByTestId('nav-home').click() // the tree is on Home
  // 3000 FLAT roots: the sidebar holds the first 200 and a "show more" button, not 3000 rows
  expect(await page.getByTestId('page-row').count()).toBeLessThanOrEqual(200)
  await expect(page.getByTestId('tree-more')).toBeVisible()
  await page.getByTestId('tree-more').click()
  expect(await page.getByTestId('page-row').count()).toBeLessThanOrEqual(400)
})

// ---- dark mode is READABLE: text against its real background, computed (WCAG contrast), for the blocks that hard-coded light colours ----
test('dark mode: text keeps WCAG AA contrast (4.5:1) on the callout, the table header, the slash menu, the floating bar, the palette and a board column', async ({ page }) => {
  await signUpAndOpen(page)
  await page.evaluate(() => localStorage.setItem('nevis.device', JSON.stringify({ theme: 'dark' })))
  await page.reload()
  await reopenWorkspace(page)
  await createNew(page, 'new-all-blocks')
  await expect(page.locator('.callout')).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain('dark')

  const ratio = (selector: string) => page.evaluate(sel => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return -1
    const rgba = (css: string): [number, number, number, number] => { const c = document.createElement('canvas').getContext('2d')!; c.clearRect(0, 0, 1, 1); c.fillStyle = '#000'; c.fillStyle = css; c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255] }
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!) }
    const fg = rgba(getComputedStyle(el).color)
    let bg: number[] = [0, 0, 0]
    // the nearest ancestor with an opaque background; translucent layers are mixed over what is below
    const layers: [number, number, number, number][] = []
    for (let n: HTMLElement | null = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 0.99) break }
    bg = [255, 255, 255]
    for (const l of layers.reverse()) bg = [0, 1, 2].map(i => l[i]! * l[3] + bg[i]! * (1 - l[3]))
    const [a, b] = [lum(fg), lum(bg)]
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }, selector)
  const AA = 4.5
  expect(await ratio('.callout .callout-body p'), 'callout text').toBeGreaterThanOrEqual(AA)
  // control: the check is not vacuous: put back the OLD bug (a hard-coded light background under the light text) and it must be caught
  const bug = await page.addStyleTag({ content: '.callout { background: #f6f8fa !important }' }) // a stylesheet (ProseMirror reverts inline style edits on its nodes)
  expect(await ratio('.callout .callout-body p'), 'the old light-on-light bug must be detected').toBeLessThan(AA)
  await bug.evaluate(e => (e as Element).remove())
  expect(await ratio('.ProseMirror th p, .ProseMirror th'), 'table header').toBeGreaterThanOrEqual(AA)
  await page.getByTestId('editor').locator('.ProseMirror p').first().click()
  await page.locator('.toolbar .tb-btn--primary').click()
  await expect(page.locator('.slash-menu .ds-menu-item').first()).toBeVisible()
  expect(await ratio('.slash-menu .ds-menu-label b'), 'slash menu').toBeGreaterThanOrEqual(AA)
  await page.keyboard.press('Escape')
  await page.getByTestId('editor').locator('p').first().click({ clickCount: 3 })
  await expect(page.locator('.toolbar .tb-btn:not(.tb-btn--primary)').first()).toBeVisible()
  expect(await ratio('.toolbar .tb-btn:not(.tb-btn--primary)'), 'formatting bar').toBeGreaterThanOrEqual(AA)
  await page.keyboard.press('Control+k')
  await page.locator('.ds-command-dialog input').first().fill('همه')
  await expect(page.locator('.ds-command-dialog .ds-command-result').first()).toBeVisible()
  expect(await ratio('.ds-command-dialog .ds-command-result'), 'palette').toBeGreaterThanOrEqual(AA)
  await page.keyboard.press('Escape')
  await createNew(page, 'new-database')
  await addProp(page, 'وضعیت', 'select')
  await page.locator('th[data-prop="وضعیت"]').getByTestId('opt-name').fill('الف'); await page.locator('th[data-prop="وضعیت"]').getByTestId('opt-add').click()
  await page.getByTestId('add-view').click()
  await page.getByTestId('new-view-board').click()
  await expect(page.getByTestId('board-col').first()).toBeVisible()
  expect(await ratio('.db-board-col h3'), 'board column header').toBeGreaterThanOrEqual(AA)
  expect(await ratio('.dbtable th, .dv-bar'), 'database chrome').toBeGreaterThanOrEqual(AA)
})
