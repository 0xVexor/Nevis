import { expect, type Page } from '@playwright/test'

/** Creates something from the rail's "New" menu (the old app's way): kind = the menu item's hook. */
export async function createNew(page: Page, kind: 'new-page' | 'new-database' | 'new-all-blocks') {
  const before = await page.evaluate(() => location.hash)
  if (kind === 'new-all-blocks') {
    await page.getByTestId('nav-templates').click()
    await page.getByTestId('template-all-blocks').click()
    await page.getByTestId('tpl-use').click()
  } else {
    await page.getByTestId('new-menu').click()
    await page.getByTestId(kind).click()
  }
  await page.waitForFunction(h => location.hash !== h && location.hash.startsWith('#/page/'), before)
}
export const appReady = (page: Page) => expect(page.getByTestId('new-menu')).toBeVisible()

/** The remembered workspace opens automatically. Fresh browser profiles still choose one. */
export async function reopenWorkspace(page: Page) {
  const choose = page.getByTestId('ws-list').getByRole('button').first()
  const ready = page.getByTestId('new-menu')
  await ready.or(choose).first().waitFor({ state: 'visible' })
  if (await choose.isVisible()) await choose.click()
  await appReady(page)
}
