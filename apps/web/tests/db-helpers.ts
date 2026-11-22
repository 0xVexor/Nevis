import type { Page, Locator } from '@playwright/test'

/** The database toolbar keeps its controls in small panels (as the old app does): open one, use it, close it. */
export async function addProp(page: Page, name: string, type: string) {
  if (!(await page.getByTestId('db-prop-name').isVisible())) await page.getByTestId('chip-props').click()
  await page.getByTestId('db-prop-name').fill(name)
  await choose(page, page.getByTestId('db-prop-type'), { value: type })
  await page.getByTestId('db-add-prop').click()
  await page.locator(`th[data-prop="${name}"]`).waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.ds-pop').first().waitFor({ state: 'detached' }) // the panel fades out first
}
export const openPanel = async (page: Page, testid: string, inside: string) => { if (!(await page.getByTestId(inside).first().isVisible())) await page.getByTestId(testid).click() }

/** Use the same shared menu as a person, including nested dropdowns in a filter panel. */
export async function choose(page: Page, control: Locator, option: { value?: string; label?: string }) {
  await control.click()
  const menu = page.locator('.ds-pop').last()
  if (option.value !== undefined) await menu.locator(`[role="menuitem"][data-value=${JSON.stringify(option.value)}]`).click()
  else await menu.getByRole('menuitem', { name: option.label!, exact: true }).click()
}
