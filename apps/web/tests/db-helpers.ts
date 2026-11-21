import type { Page } from '@playwright/test'

/** The database toolbar keeps its controls in small panels (as the old app does): open one, use it, close it. */
export async function addProp(page: Page, name: string, type: string) {
  if (!(await page.getByTestId('db-prop-name').isVisible())) await page.getByTestId('chip-props').click()
  await page.getByTestId('db-prop-name').fill(name)
  await page.getByTestId('db-prop-type').selectOption(type)
  await page.getByTestId('db-add-prop').click()
  await page.locator(`th[data-prop="${name}"]`).waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.ds-pop').first().waitFor({ state: 'detached' }) // the panel fades out first
}
export const openPanel = async (page: Page, testid: string, inside: string) => { if (!(await page.getByTestId(inside).first().isVisible())) await page.getByTestId(testid).click() }
