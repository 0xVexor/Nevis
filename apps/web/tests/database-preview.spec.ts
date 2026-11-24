import { expect, test } from '@playwright/test'
import { appReady, createNew } from './shell-helpers'

test('database preview shows live metadata and opens an exact row', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(`p${Date.now().toString(36)}`)
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').click()
  await page.getByTestId('ws-new').click()
  await appReady(page)
  await createNew(page, 'new-database')
  await page.getByTestId('db-title').fill('Books')
  await page.getByTestId('nav-databases').click()
  const preview = page.getByTestId('database-preview')
  await expect(preview).toContainText('Books')
  await expect(preview).toContainText('هنوز موردی نیست')
  await expect(preview.locator('.dbs-chip')).toHaveCount(2)
  await preview.getByTestId('open-database').click()
  await page.getByTestId('db-add-row').click()
  await page.locator('[data-testid=cell][data-prop="نام"][data-row="0"] input').fill('The book')
  await page.locator('[data-testid=cell][data-prop="نام"][data-row="0"] input').blur()
  const ids = await page.evaluate(() => {
    const db = [...(window as any).__ws.data.databases.values()][0] as any
    return { db: db.id, row: db.rows[0].id }
  })
  await page.getByTestId('nav-databases').click()
  await expect(preview).toContainText('The book')
  await preview.getByRole('button', { name: 'The book' }).click()
  await expect(page).toHaveURL(new RegExp(`#/row/${ids.db}/${ids.row}$`))
})
