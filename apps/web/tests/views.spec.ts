import { addProp } from './db-helpers'
import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady } from './shell-helpers'

// ROADMAP M8b: the database views on the M7 model: tabs, sort, hidden columns, a board whose cards are moved by dragging (one op), the view config saved.
const pw = 'correct horse battery'
test.setTimeout(120_000)

async function open(page: Page) {
  const name = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await createNew(page, 'new-database')
  await expect(page.getByTestId('db-view')).toBeVisible()
}
const cell = (page: Page, prop: string, row: number) => page.locator(`[data-testid=cell][data-prop="${prop}"][data-row="${row}"]`)
type W = { __ws: { status: () => Promise<{ outbox: number; unsaved: number }>; ws: string } }
const settled = (page: Page) => expect.poll(() => page.evaluate(async () => { const s = await (window as unknown as W).__ws.status(); return s.outbox === 0 && s.unsaved === 0 }), { timeout: 30_000 }).toBe(true)
const head = (page: Page) => page.evaluate(async () => { const r = await fetch(`/v1/ws/${(window as unknown as W).__ws.ws}/ops?after=0&limit=1`); return ((await r.json()) as { head: number }).head })

async function seed(page: Page) {
  for (const [n, t] of [['وضعیت', 'select'], ['قیمت', 'number']] as const) {
    await addProp(page, n, t)
    await page.locator(`th[data-prop="${n}"]`).waitFor()
  }
  for (const o of ['در انتظار', 'در حال انجام', 'تمام']) {
    await page.locator('th[data-prop="وضعیت"]').getByTestId('opt-name').fill(o)
    await page.locator('th[data-prop="وضعیت"]').getByTestId('opt-add').click()
    await expect(page.locator('th[data-prop="وضعیت"] .optadd')).toContainText(o)
  }
  for (const [i, [name, price]] of ([['الف', '30'], ['ب', '5'], ['ج', '12.5']] as [string, string][]).entries()) {
    await page.getByTestId('db-add-row').click()
    await expect(page.getByTestId('db-row')).toHaveCount(i + 1)
    await cell(page, 'نام', i).locator('input').fill(name); await cell(page, 'نام', i).locator('input').blur()
    await cell(page, 'قیمت', i).locator('input').fill(price); await cell(page, 'قیمت', i).locator('input').blur()
  }
  await cell(page, 'وضعیت', 0).locator('select').selectOption({ label: 'در انتظار' })
  await cell(page, 'وضعیت', 1).locator('select').selectOption({ label: 'در انتظار' })
}

test('table view: sort by a number (exact), hide a column, and the view config survives a reload', async ({ page }) => {
  await open(page)
  await seed(page)
  await page.getByTestId('chip-sort').click()
  await page.getByTestId('sort-prop').selectOption({ label: 'قیمت' })
  await expect.poll(async () => (await page.locator('[data-testid=cell][data-prop="نام"] input').evaluateAll(els => els.map(e => (e as HTMLInputElement).value)))).toEqual(['ب', 'ج', 'الف']) // 5, 12.5, 30
  await page.getByTestId('sort-dir').click()
  await expect.poll(async () => (await page.locator('[data-testid=cell][data-prop="نام"] input').evaluateAll(els => els.map(e => (e as HTMLInputElement).value)))).toEqual(['الف', 'ج', 'ب'])
  await page.keyboard.press('Escape')
  await page.locator('.ds-pop').first().waitFor({ state: 'detached' })
  await page.getByTestId('chip-props').click()
  await page.getByTestId('col-toggle').nth(1).uncheck() // the status column
  await page.keyboard.press('Escape')
  await page.locator('.ds-pop').first().waitFor({ state: 'detached' })
  await expect(page.locator('th[data-prop="وضعیت"]')).toHaveCount(0)
  await settled(page)
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('page-row').first().dblclick()
  await expect(page.locator('th[data-prop="وضعیت"]')).toHaveCount(0)
  await expect(page.locator('.dv-conditions')).toContainText('نزولی')
})

test('board view: columns are the options; dragging a card moves it as ONE op; the table shows the same data', async ({ page, browserName }) => {
  await open(page)
  await seed(page)
  await page.getByTestId('add-view').click()
  await page.getByTestId('new-view-board').click()
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(page.getByTestId('board-col')).toHaveCount(4) // no value + three options
  const col = (name: string) => page.getByTestId('board-col').filter({ has: page.getByRole('heading', { name }) })
  await expect(col('در انتظار').getByTestId('board-card')).toHaveCount(2)
  await expect(col('بدون مقدار').getByTestId('board-card')).toHaveCount(1)
  await settled(page)
  const h0 = await head(page)

  // the "move to" menu (touch, and every engine)
  await col('در انتظار').getByTestId('board-card').filter({ has: page.locator('span', { hasText: /^ب$/ }) }).locator('select').selectOption({ label: 'تمام' })
  await expect(col('تمام').getByTestId('board-card')).toHaveCount(1)
  await settled(page)
  await expect.poll(() => head(page)).toBe(h0 + 1) // the option and the position: ONE op

  // real drag and drop (Chromium: scripted HTML5 drag is not reliable in the other engines)
  if (browserName === 'chromium') {
    const card = col('در انتظار').getByTestId('board-card').first()
    const target = col('در حال انجام')
    const [a, b] = [(await card.boundingBox())!, (await target.boundingBox())!]
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2, b.y + 60, { steps: 12 })
    await page.mouse.up()
    await expect(col('در حال انجام').getByTestId('board-card')).toHaveCount(1)
    await expect(col('در انتظار').getByTestId('board-card')).toHaveCount(0)
  }
  await settled(page)
  // the table view of the SAME database shows the moved cards
  await page.getByTestId('view-tab').first().click()
  const shown = await page.locator('[data-testid=cell][data-prop="وضعیت"] select option:checked').allTextContents()
  expect(shown).toContain('تمام')
  if (browserName === 'chromium') expect(shown).toContain('در حال انجام')
  // a card can be added in a column
  await page.getByTestId('view-tab').nth(1).click()
  await col('تمام').getByTestId('board-add').click()
  await expect(col('تمام').getByTestId('board-card')).toHaveCount(2)
})
