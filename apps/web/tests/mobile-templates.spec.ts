import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, timezoneId: 'America/Los_Angeles' })
test.skip(({ browserName }) => browserName === 'firefox', 'Firefox does not support the mobile browser context')

for (const lang of ['fa', 'en'] as const) {
  test(`phone templates browse and create the correct page kinds in ${lang}`, async ({ page }) => {
    await page.addInitScript(language => localStorage.setItem('nevis.device', JSON.stringify({ lang: language, theme: language === 'fa' ? 'dark' : 'light' })), lang)
    await page.goto('/')
    await page.getByTestId('auth-switch').tap()
    await page.locator('input[name=username]').fill(`templates${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`)
    await page.locator('input[name=password]').fill('correct horse battery')
    await page.getByTestId('auth-submit').tap()
    await page.getByTestId('ws-new').tap()
    await page.clock.setFixedTime(new Date('2026-11-26T01:00:00Z'))
    await page.getByTestId('mobile-menu').tap()
    await page.getByTestId('nav-templates').tap()

    await expect(page.getByTestId('templates')).toBeVisible()
    await expect(page.locator('.tpl-group')).toHaveCount(2)
    await expect(page.getByTestId('template-lecture').locator('small')).toHaveCSS('white-space', 'normal')
    await expect(page.locator('.tpl-preview')).toBeHidden()
    await page.getByTestId('template-lecture').tap()
    await expect(page.getByTestId('template-back')).toBeFocused()
    await expect(page.locator('.tpl-preview-head h2')).toHaveText(lang === 'fa' ? 'جلسه‌ی درس' : 'Lecture')
    await expect(page.locator('.tpl-paper')).toContainText(lang === 'fa' ? 'مفاهیم کلیدی' : 'Key concepts')
    await page.getByTestId('template-back').tap()
    await expect(page.getByTestId('template-lecture')).toBeFocused()
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)

    await page.getByTestId('template-all-blocks').tap()
    await expect(page.locator('.tpl-paper')).toBeVisible()
    await expect(page.getByTestId('tpl-use')).toBeInViewport()
    await page.getByTestId('template-back').tap()
    await page.getByTestId('template-lecture').tap()
    await page.getByTestId('tpl-use').tap()
    await expect(page.getByTestId('editor')).toContainText(lang === 'fa' ? 'مفاهیم کلیدی' : 'Key concepts')

    await page.evaluate(() => { location.hash = '#/templates' })
    await page.getByTestId('template-daily').tap()
    await expect(page.locator('.tpl-paper-title')).toHaveText('۱۴۰۵/۰۹/۰۴')
    await expect(page.locator('.tpl-paper')).toContainText(lang === 'fa' ? 'برنامهٔ امروز' : "Today's plan")
    await expect(page.locator('.tpl-paper')).toContainText(lang === 'fa' ? 'یادداشت‌ها' : 'Notes')
    await page.getByTestId('tpl-use').tap()
    await expect(page.getByTestId('title')).toHaveValue('۱۴۰۵/۰۹/۰۴')
    await expect(page.getByTestId('editor')).toContainText(lang === 'fa' ? 'برنامهٔ امروز' : "Today's plan")

    await page.evaluate(() => { location.hash = '#/templates' })
    await page.getByTestId('template-database').tap()
    await expect(page.locator('.tpl-mobile-database')).toBeVisible()
    await page.getByTestId('tpl-use').tap()
    await expect(page.getByTestId('db-view')).toBeVisible()

    await page.evaluate(() => { location.hash = '#/templates' })
    await page.getByTestId('template-drawing').tap()
    await expect(page.locator('.tpl-mobile-drawing')).toBeVisible()
    await page.getByTestId('tpl-use').tap()
    await expect(page.getByTestId('board')).toBeVisible()

    await page.evaluate(() => { location.hash = '#/templates' })
    await page.getByTestId('template-blank').tap()
    await page.evaluate(() => {
      const state = window as any
      const createPage = state.__ws.newPage.bind(state.__ws)
      state.__templateCreates = 0
      state.__ws.newPage = async (...args: unknown[]) => {
        state.__templateCreates++
        await new Promise(resolve => setTimeout(resolve, 100))
        return createPage(...args)
      }
    })
    await page.getByTestId('tpl-use').evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
    await expect(page.getByTestId('editor')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__templateCreates)).toBe(1)
    await expect(page.getByTestId('title')).toHaveValue('')
  })
}
