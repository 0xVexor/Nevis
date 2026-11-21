import { expect, type Page } from '@playwright/test'

/** Creates something from the rail's "New" menu (the old app's way): kind = the menu item's hook. */
export async function createNew(page: Page, kind: 'new-page' | 'new-database' | 'new-all-blocks') {
  const before = await page.evaluate(() => location.hash)
  await page.getByTestId('new-menu').click()
  await page.getByTestId(kind).click()
  await page.waitForFunction(h => location.hash !== h && location.hash.startsWith('#/page/'), before)
}
export const appReady = (page: Page) => expect(page.getByTestId('new-menu')).toBeVisible()
