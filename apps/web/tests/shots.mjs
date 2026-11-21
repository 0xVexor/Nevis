// Screenshots of the main screens in light and dark (for LOOKING at them: the look of the app is part of M8b). node tests/shots.mjs <outdir>
import { chromium } from '@playwright/test'
import { createNew } from './shell-helpers.ts'
const out = process.argv[2]
const BASE = process.env.BASE ?? 'http://localhost:5174'
const b = await chromium.launch({ channel: 'chrome' })
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
const page = await ctx.newPage()
await page.goto(BASE)
await page.getByRole('button', { name: 'حساب ندارم' }).click()
await page.locator('input[name=username]').fill('shot' + Date.now().toString(36))
await page.locator('input[name=password]').fill('correct horse battery')
await page.getByTestId('auth-submit').click()
await page.getByTestId('recovery').waitFor()
await page.getByTestId('ws-new').click()
await createNew(page, 'new-all-blocks')
await page.locator('.mermaid-block svg').waitFor({ timeout: 30000 })
await page.waitForTimeout(1200)
// a database with a board
await createNew(page, 'new-database')
await page.getByTestId('db-title').fill('کتاب‌ها')
for (const [n, t] of [['وضعیت', 'select'], ['قیمت', 'number']]) { if (!(await page.getByTestId('db-prop-name').isVisible())) await page.getByTestId('chip-props').click(); await page.getByTestId('db-prop-name').fill(n); await page.getByTestId('db-prop-type').selectOption(t); await page.getByTestId('db-add-prop').click(); await page.keyboard.press('Escape'); await page.locator('.ds-pop').first().waitFor({ state: 'detached' }); await page.locator(`th[data-prop="${n}"]`).waitFor() }
for (const o of ['در انتظار', 'در حال انجام', 'تمام']) { await page.locator('th[data-prop="وضعیت"]').getByTestId('opt-name').fill(o); await page.locator('th[data-prop="وضعیت"]').getByTestId('opt-add').click(); await page.waitForTimeout(150) }
for (let i = 0; i < 3; i++) { await page.getByTestId('db-add-row').click(); await page.waitForTimeout(150); await page.locator(`[data-testid=cell][data-prop="نام"][data-row="${i}"] input`).fill(['الف', 'ب', 'ج'][i]); await page.locator(`[data-testid=cell][data-prop="نام"][data-row="${i}"] input`).blur() }
await page.locator('[data-testid=cell][data-prop="وضعیت"][data-row="0"] select').selectOption({ label: 'در انتظار' })
await page.locator('[data-testid=cell][data-prop="وضعیت"][data-row="1"] select').selectOption({ label: 'تمام' })
const shots = []
for (const scheme of ['light', 'dark']) {
  await page.evaluate(s => { localStorage.setItem('nevis.device', JSON.stringify({ theme: s })) }, scheme)
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.waitForTimeout(800)
  await page.getByTestId('nav-home').click(); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/${scheme}-home.png` })
  await page.getByTestId('page-row').first().dblclick(); await page.waitForTimeout(2500); await page.screenshot({ path: `${out}/${scheme}-allblocks.png` })
  await page.evaluate(() => document.querySelector('.callout')?.scrollIntoView()); await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${scheme}-callout.png` })
  await page.getByTestId('page-row').nth(1).dblclick(); await page.waitForTimeout(600); await page.screenshot({ path: `${out}/${scheme}-table.png` })
  await page.getByTestId('add-view').click(); await page.getByTestId('new-view-board').click(); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${scheme}-board.png` })
  await page.keyboard.press('Control+k'); await page.locator('.ds-command-dialog input').first().fill('كتاب'); await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${scheme}-palette.png` }); await page.keyboard.press('Escape')
  await page.getByTestId('nav-settings').click(); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/${scheme}-settings.png` })
  await page.getByTestId('nav-home').click()
}
await ctx.close()
// phone width
const m = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' })
const p2 = await m.newPage()
await p2.goto(BASE)
await p2.locator('input[name=username]').fill('shotb' + Date.now().toString(36))
await p2.getByRole('button', { name: 'حساب ندارم' }).click()
await p2.locator('input[name=username]').fill('shotb' + Date.now().toString(36))
await p2.locator('input[name=password]').fill('correct horse battery')
await p2.getByTestId('auth-submit').click(); await p2.getByTestId('recovery').waitFor(); await p2.getByTestId('ws-new').click()
await p2.waitForTimeout(500); await p2.screenshot({ path: `${out}/phone-home.png` })
await createNew(p2, 'new-all-blocks')
await p2.getByRole('button', { name: 'منو' }).click(); await p2.waitForTimeout(300); await p2.screenshot({ path: `${out}/phone-drawer.png` })
await b.close()
console.log('shots in', out)
