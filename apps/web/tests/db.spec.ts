import { addProp } from './db-helpers'
import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady } from './shell-helpers'

// ROADMAP M7: a database "کتاب‌ها" in the real app: properties of several types, a select option, cells (with Persian digits),
// reload: everything persisted and read back typed.
const pw = 'correct horse battery'
test.setTimeout(90_000)

async function signUpAndOpen(page: Page) {
  const name = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
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
const cell = (page: Page, prop: string, row: number) => page.locator(`[data-testid=cell][data-prop="${prop}"][data-row="${row}"]`)

test('a database: columns of several types, an option, rows, Persian digits in a number cell; reload keeps it all', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-database')
  await expect(page.getByTestId('db-view')).toBeVisible()
  await page.getByTestId('db-title').fill('کتاب‌ها')
  for (const [name, type] of [['قیمت', 'number'], ['ژانر', 'select'], ['خوانده', 'checkbox'], ['تاریخ', 'date']] as const) {
    await addProp(page, name, type)
    await expect(page.locator(`th[data-prop="${name}"]`)).toBeVisible()
  }
  // a select option, added from the table
  await page.locator('th[data-prop="ژانر"]').getByTestId('opt-name').fill('رمان')
  await page.locator('th[data-prop="ژانر"]').getByTestId('opt-add').click()
  await expect(cell(page, 'ژانر', 0)).toHaveCount(0) // no row yet
  await page.getByTestId('db-add-row').click()
  await expect(page.getByTestId('db-row')).toHaveCount(1)

  await cell(page, 'نام', 0).locator('input').fill('بوف کور')
  await cell(page, 'نام', 0).locator('input').blur()
  await cell(page, 'قیمت', 0).locator('input').fill('۱۲٫۵')
  await cell(page, 'قیمت', 0).locator('input').blur()
  await expect(cell(page, 'قیمت', 0).locator('input')).toHaveValue('12.5') // normalized to ASCII digits
  await cell(page, 'ژانر', 0).locator('select').selectOption({ label: 'رمان' })
  await cell(page, 'خوانده', 0).locator('input').check()
  await cell(page, 'تاریخ', 0).locator('input').fill('۱۴۰۵/۰۸/۲۹')
  await cell(page, 'تاریخ', 0).locator('input').blur()
  await expect(cell(page, 'تاریخ', 0).locator('input')).toHaveValue('۱۴۰۵/۰۸/۲۹') // shown in the Persian calendar

  // an invalid number is refused (shown as an error, nothing written)
  await cell(page, 'قیمت', 0).locator('input').fill('1/2')
  await cell(page, 'قیمت', 0).locator('input').blur()
  await expect(cell(page, 'قیمت', 0).getByRole('alert')).toBeVisible()
  await cell(page, 'قیمت', 0).locator('input').fill('12.5')
  await cell(page, 'قیمت', 0).locator('input').blur()
  await page.waitForFunction(() => document.querySelector('[data-testid=outbox]')?.textContent === '0')

  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('page-row').first().dblclick()
  await expect(page.getByTestId('db-title')).toHaveValue('کتاب‌ها')
  await expect(page.getByTestId('db-row')).toHaveCount(1)
  await expect(cell(page, 'نام', 0).locator('input')).toHaveValue('بوف کور')
  await expect(cell(page, 'قیمت', 0).locator('input')).toHaveValue('12.5')
  await expect(cell(page, 'ژانر', 0).locator('select')).toHaveValue(/.+/)
  await expect(cell(page, 'ژانر', 0).locator('select option:checked')).toHaveText('رمان')
  await expect(cell(page, 'خوانده', 0).locator('input')).toBeChecked()
  await expect(cell(page, 'تاریخ', 0).locator('input')).toHaveValue('۱۴۰۵/۰۸/۲۹')
})

// West of UTC a date parsed or formatted in LOCAL time shows the previous day. A date-only cell must show the same day everywhere.
test.describe('a browser west of UTC', () => {
  test.use({ timezoneId: 'America/Los_Angeles' })
  test('a date cell keeps its day (stored 2026-11-20, shown 29 Aban 1405) and the stored form is the Gregorian day typed', async ({ page }) => {
    await signUpAndOpen(page)
    await createNew(page, 'new-database')
    await addProp(page, 'تاریخ', 'date')
    await page.getByTestId('db-add-row').click()
    expect(await page.evaluate(() => new Date(2026, 10, 20).getTimezoneOffset())).toBeGreaterThan(0) // really west of UTC
    await cell(page, 'تاریخ', 0).locator('input').fill('2026-11-20')
    await cell(page, 'تاریخ', 0).locator('input').blur()
    await expect(cell(page, 'تاریخ', 0).locator('input')).toHaveValue('۱۴۰۵/۰۸/۲۹')
    await cell(page, 'تاریخ', 0).locator('input').focus()
    await expect(cell(page, 'تاریخ', 0).locator('input')).toHaveValue('2026-11-20')
    await cell(page, 'تاریخ', 0).locator('input').fill('۱۴۰۵/۰۱/۰۱')
    await cell(page, 'تاریخ', 0).locator('input').blur()
    await cell(page, 'تاریخ', 0).locator('input').focus()
    await expect(cell(page, 'تاریخ', 0).locator('input')).toHaveValue('2026-03-21') // Nowruz 1405
  })
})
