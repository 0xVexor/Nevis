import { expect, test } from '@playwright/test'
import { appReady, createNew } from './shell-helpers'

 test('database relations can be shown and open their exact rows', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(`g${Date.now().toString(36)}`)
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').click()
  await page.getByTestId('ws-new').click()
  await appReady(page)
  await createNew(page, 'new-database')
  await page.getByTestId('db-add-row').click()
  await page.getByTestId('db-add-row').click()
  await page.locator('[data-testid=cell][data-prop="نام"][data-row="0"] input').fill('Source row')
  await page.locator('[data-testid=cell][data-prop="نام"][data-row="0"] input').blur()
  await page.locator('[data-testid=cell][data-prop="نام"][data-row="1"] input').fill('Target row')
  await page.locator('[data-testid=cell][data-prop="نام"][data-row="1"] input').blur()
  const ids = await page.evaluate(async () => {
    const ws = (window as any).__ws
    const db = [...ws.data.databases.values()][0] as any
    const [a, b] = db.rows
    await ws.mutate([db.id], async (c: any) => {
      const prop = c.newIdFor()
      await c.setFields(prop, { db: db.id, name: 'Related', type: 'relation', config: { target: db.id }, sortKey: 'z', trashed: false, createdAt: c.nowMs() }, 'property')
      await c.setFields(a.id, { [`c:${prop}/${b.id}`]: true, [`c:${prop}/missing`]: true })
    })
    return { db: db.id, target: b.id }
  })
  await page.evaluate(() => { location.hash = '#/graph' })
  const graph = page.getByTestId('graph')
  const toggle = graph.getByRole('button', { name: /رابطه‌ها/ })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(graph).toContainText(/صفحه\s*۲/)
  await expect(graph).toContainText(/پیوند\s*۱/)
  await graph.getByRole('button', { name: /Target row/ }).first().click()
  await graph.getByRole('button', { name: 'باز کردن صفحه' }).click()
  await expect(page).toHaveURL(new RegExp(`#/row/${ids.db}/${ids.target}$`))
})
