import { addProp, choose } from './db-helpers'
import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady, reopenWorkspace } from './shell-helpers'
import type { Workspace } from '../src/workspace'

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
  await choose(page, cell(page, 'ژانر', 0).locator('.ds-dd-btn'), { label: 'رمان' })
  await cell(page, 'خوانده', 0).locator('.ds-check').click()
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
  await reopenWorkspace(page)
  await page.getByTestId('page-row').first().dblclick()
  await expect(page.getByTestId('db-title')).toHaveValue('کتاب‌ها')
  await expect(page.getByTestId('db-row')).toHaveCount(1)
  await expect(cell(page, 'نام', 0).locator('input')).toHaveValue('بوف کور')
  await expect(cell(page, 'قیمت', 0).locator('input')).toHaveValue('12.5')
  await expect(cell(page, 'ژانر', 0).locator('.ds-dd-btn')).toHaveText('رمان')
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

test('table keyboard selection, fill, clear and undo preserve input editing', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-database')
  await addProp(page, 'Amount', 'number')
  await page.getByTestId('db-add-row').click()
  await expect(page.getByTestId('db-row')).toHaveCount(1)
  await page.getByTestId('db-add-row').click()
  await expect(page.getByTestId('db-row')).toHaveCount(2)
  const first = cell(page, 'Amount', 0)
  const second = cell(page, 'Amount', 1)
  await first.locator('input').fill('12')
  await first.locator('input').blur()
  await expect(first.locator('input')).toHaveValue('12')
  await first.focus()
  await expect(first).toBeFocused()
  await expect(first).toHaveAttribute('data-cell-selected', 'true')
  const selectedSurface = first.locator('.db-cellbox')
  await expect(selectedSurface).toHaveCSS('outline-style', 'solid')
  await expect(selectedSurface).toHaveCSS('outline-width', '2px')
  expect(await selectedSurface.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(await second.locator('.db-cellbox').evaluate(element => getComputedStyle(element).backgroundColor))
  await page.keyboard.press('Shift+ArrowDown')
  await expect(second).toHaveAttribute('data-cell-selected', 'true')
  await page.keyboard.press('ControlOrMeta+d')
  await expect(second.locator('input')).toHaveValue('12')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(second.locator('input')).toHaveValue('')
  await page.keyboard.press('ControlOrMeta+d')
  await expect(second.locator('input')).toHaveValue('12')
  await page.keyboard.press('Delete')
  await expect(first.locator('input')).toHaveValue('')
  await expect(second.locator('input')).toHaveValue('')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(first.locator('input')).toHaveValue('12')
  await expect(second.locator('input')).toHaveValue('12')
  await page.keyboard.press('ControlOrMeta+a')
  await expect(page.locator('td[data-cell-selected]')).toHaveCount(4)
  await first.focus()
  await page.keyboard.press('F2')
  await expect(first.locator('input')).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('34')
  await first.locator('input').blur()
  await expect(first.locator('input')).toHaveValue('34')
})

test('column order and frozen columns persist after reopening the database', async ({ page }) => {
  page.setDefaultTimeout(5_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await signUpAndOpen(page)
  await createNew(page, 'new-database')
  await page.getByTestId('db-title').fill('Column layout')
  await page.getByTestId('db-add-row').click()
  const headers = page.locator('thead th[data-prop]')
  const selectAll = page.locator('th.dbtable-handle .ds-check')
  const selectRow = page.locator('td.dbtable-handle .ds-check').first()
  await expect(selectRow).toBeVisible()
  for (const direction of ['ltr', 'rtl']) {
    await page.evaluate(dir => { document.documentElement.dir = dir }, direction)
    const table = (await page.getByTestId('db-table').boundingBox())!
    const heading = (await selectAll.boundingBox())!
    const row = (await selectRow.boundingBox())!
    const add = (await page.getByTestId('col-add').locator('svg').boundingBox())!
    const selectionInset = direction === 'rtl' ? table.x + table.width - heading.x - heading.width : heading.x - table.x
    const addInset = direction === 'rtl' ? add.x - table.x : table.x + table.width - add.x - add.width
    expect(selectionInset).toBeLessThan(40)
    expect(addInset).toBeLessThan(24)
    expect(heading.x).toBeCloseTo(row.x, 0)
  }
  await addProp(page, 'First', 'text')
  await addProp(page, 'Second', 'text')
  await page.locator('td.dbtable-handle').first().hover()
  await expect(page.locator('td.dbtable-handle .dv-grip').first()).toHaveCSS('opacity', '1')
  await page.locator('th[data-prop="Second"] button[data-testid="col-head"]').click()
  await page.getByRole('menuitem', { name: 'انتقال ستون به قبل' }).click()
  await expect.poll(() => headers.evaluateAll(elements => elements.map(element => element.getAttribute('data-prop')))).toEqual(['نام', 'Second', 'First'])
  await page.locator('th[data-prop="Second"] button[data-testid="col-head"]').click()
  await page.getByRole('menuitem', { name: 'ثابت کردن ستون‌ها تا این ستون' }).click()
  await expect(page.locator('th[data-prop="Second"]')).toHaveAttribute('data-frozen', 'true')
  await expect(cell(page, 'Second', 0)).toHaveCSS('position', 'sticky')
  await expect(page.locator('th.dbtable-handle')).toHaveCSS('position', 'sticky')
  await expect(page.locator('td.dbtable-handle').first()).toHaveCSS('position', 'sticky')
  await expect(cell(page, 'First', 0)).not.toHaveAttribute('data-frozen', 'true')
  const widths = await headers.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
  expect(widths[0]).toBeGreaterThanOrEqual(320)
  expect(widths[1]).toBeGreaterThanOrEqual(280)
  expect(widths[2]).toBeGreaterThanOrEqual(280)
  const headerButton = headers.nth(1).getByTestId('col-head')
  const cellSurface = cell(page, 'Second', 0).locator('.db-cellbox')
  const cellInput = cellSurface.locator('input')
  for (const radius of ['3px', '18px']) {
    await page.evaluate(value => document.documentElement.style.setProperty('--user-radius', value), radius)
    await expect(headerButton).toHaveCSS('border-radius', radius)
    await expect(cellSurface).toHaveCSS('border-radius', radius)
    await expect(cellInput).toHaveCSS('border-radius', radius)
  }
  expect(parseFloat(await headerButton.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14)
  expect(parseFloat(await cellInput.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
  await page.setViewportSize({ width: 650, height: 800 })
  const overflow = await page.locator('.dbtable-wrap').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
  expect(overflow.scroll).toBeGreaterThan(overflow.client)
  await expect.poll(async () => page.locator('th[data-prop="Second"]').evaluate(element => {
    const headers = [...element.parentElement!.querySelectorAll('th')]
    return Math.abs(parseFloat(getComputedStyle(element).insetInlineStart) - headers.slice(0, 2).reduce((sum, header) => sum + header.getBoundingClientRect().width, 0))
  })).toBeLessThan(1)
  await page.reload()
  await reopenWorkspace(page)
  await expect(page.getByTestId('db-view')).toBeVisible()
  await expect.poll(() => headers.evaluateAll(elements => elements.map(element => element.getAttribute('data-prop')))).toEqual(['نام', 'Second', 'First'])
  await expect(cell(page, 'Second', 0)).toHaveCSS('position', 'sticky')
  await page.locator('th[data-prop="Second"] button[data-testid="col-head"]').click()
  await page.getByRole('menuitem', { name: 'آزاد کردن ستون‌ها' }).click()
  await expect(cell(page, 'Second', 0)).not.toHaveAttribute('data-frozen', 'true')
})

test('column resizing follows the layout direction and survives reload', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await signUpAndOpen(page)
  await createNew(page, 'new-database')
  await addProp(page, 'Resizable', 'text')
  await addProp(page, 'Trailing column', 'text')
  const header = page.locator('th[data-prop="Resizable"]')
  const handle = header.getByRole('separator')
  const before = (await header.boundingBox())!.width
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 80, box.y + box.height / 2)
  await expect.poll(async () => (await header.boundingBox())!.width).toBeGreaterThan(before + 50)
  await page.mouse.up()
  const resized = (await header.boundingBox())!.width
  await expect.poll(() => page.evaluate(() => {
    const ws = (window as unknown as { __ws: Workspace }).__ws
    const database = ws.data.databases.get(location.hash.split('/').pop()!)
    const property = database?.properties.find(p => p.name === 'Resizable')
    const config = database?.views[0]?.config as { columnWidths?: Record<string, number> } | undefined
    return (property && config?.columnWidths?.[property.id]) ?? 0
  })).toBeGreaterThan(280)
  await page.reload()
  await reopenWorkspace(page)
  await expect.poll(async () => (await header.boundingBox())!.width).toBeCloseTo(resized, 0)
  await handle.dblclick()
  await expect.poll(async () => (await header.boundingBox())!.width).toBeCloseTo(before, 0)

  await page.evaluate(() => { document.documentElement.dir = 'ltr' })
  const ltrBox = (await handle.boundingBox())!
  await page.mouse.move(ltrBox.x + ltrBox.width / 2, ltrBox.y + ltrBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(ltrBox.x + 80, ltrBox.y + ltrBox.height / 2)
  await expect.poll(async () => (await header.boundingBox())!.width).toBeGreaterThan(before + 50)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect.poll(async () => (await header.boundingBox())!.width).toBeCloseTo(before, 0)
  await handle.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '320')
})

test('record property fields use full width and the date picker remains usable', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-database')
  await addProp(page, 'Amount', 'number')
  await addProp(page, 'Due', 'date')
  await page.getByTestId('db-add-row').click()
  await expect(page.getByTestId('db-row')).toHaveCount(1)
  await page.getByTestId('db-row').first().focus()
  await expect(page.getByTestId('db-row').first()).toBeFocused()
  await page.keyboard.press('Enter')
  const peek = page.getByTestId('row-peek')
  await expect(peek).toBeVisible()
  const amount = peek.getByRole('textbox', { name: 'Amount' })
  const due = peek.getByRole('textbox', { name: 'Due' })
  await amount.fill('123')
  await amount.blur()
  await due.fill('2026-11-20')
  await due.blur()
  const geometry = await amount.evaluate(input => ({ width: input.getBoundingClientRect().width, available: input.parentElement!.getBoundingClientRect().width, radius: getComputedStyle(input).borderRadius }))
  expect(geometry.width).toBeGreaterThan(250)
  expect(geometry.width).toBeCloseTo(geometry.available, 0)
  expect(parseFloat(geometry.radius)).toBeGreaterThan(0)
  await expect(due).toHaveCSS('border-radius', geometry.radius)
  await due.click()
  await expect(page.locator('.dv-date-picker')).toBeVisible()
  await page.locator('.dv-date-picker [data-date="2026-11-21"]').click()
  await expect(page.locator('.dv-date-picker')).toBeHidden()
  await due.focus()
  await expect(due).toHaveValue('2026-11-21')
  await page.getByTestId('row-peek-close').click()
  await cell(page, 'نام', 0).locator('input').click()
  await expect(peek).toBeVisible()
})
