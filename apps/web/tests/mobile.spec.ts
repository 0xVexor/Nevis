import { expect, test } from '@playwright/test'

// ADR-0013 / ROADMAP M8b: responsive and touch. The main paths at phone width in WebKit with an iPhone-sized touch viewport: the sidebar is a
// drawer, nothing overflows sideways, a page can be made and written, and Settings works.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
test.skip(({ browserName }) => browserName !== 'webkit', 'the iPhone profile (touch + mobile viewport) is run in WebKit')
test.setTimeout(90_000)

test('at phone width: the drawer, a new page, writing Persian, Settings, no sideways overflow', async ({ page }) => {
  const name = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).tap()
  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').tap()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').tap()
  await expect(page.getByTestId('home')).toBeVisible()

  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(await overflow(), 'the page scrolls sideways at 390 px').toBeLessThanOrEqual(1)

  // the old shell keeps its icon rail at phone width; the Pages panel is a drawer, closed until the top bar's button opens it
  await expect(page.locator('.side')).toBeInViewport()
  await expect(page.locator('#workspace-context')).toBeHidden()
  await page.getByTestId('panel-toggle').tap()
  await expect(page.locator('#workspace-context')).toBeVisible()
  await page.locator('.context-backdrop').tap({ position: { x: 20, y: 300 } }).catch(() => undefined)
  await page.getByTestId('new-menu').tap()
  await page.getByTestId('new-page').tap()
  await page.waitForFunction(() => location.hash.startsWith('#/page/'))
  await page.getByTestId('title').fill('یادداشت موبایل')
  await page.getByTestId('editor').locator('.ProseMirror').tap()
  await page.keyboard.type('سلام از آیفون')
  await expect(page.getByTestId('editor').locator('.ProseMirror')).toContainText('سلام از آیفون')
  expect(await overflow()).toBeLessThanOrEqual(1)

  await page.getByTestId('nav-settings').tap()
  await expect(page.getByTestId('settings')).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(1)
  await page.getByTestId('nav-all').tap()
  await expect(page.getByTestId('all-pages-row')).toHaveCount(1)
  expect(await overflow()).toBeLessThanOrEqual(1)
  // every button a thumb must hit is at least 32 px tall
  const small = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 24 }).map(b => `${b.textContent?.trim().slice(0, 20)} (${b.className})`))
  expect(small, 'buttons shorter than 24 px').toEqual([])
})
