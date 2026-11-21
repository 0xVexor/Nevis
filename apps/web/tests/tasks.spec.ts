import { expect, test } from '@playwright/test'
import { appReady, createNew } from './shell-helpers'

// The old Tasks screen on the new data: every checklist item of every page; ticking one changes the PAGE itself.
test('a task is listed with its page; ticking it in Tasks ticks the item in the page; Completed folds it away', async ({ page }) => {
  const name = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(name); await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click(); await appReady(page)
  await createNew(page, 'new-page')
  await page.getByTestId('title').fill('خرید'); await page.waitForTimeout(700)
  await page.getByTestId('editor').locator('.ProseMirror').click()
  await page.evaluate(() => (window as unknown as { __editor: { chain: () => { focus: () => { toggleTaskList: () => { run: () => void } } } } }).__editor.chain().focus().toggleTaskList().run())
  await page.keyboard.type('نان')
  await page.keyboard.press('Enter'); await page.keyboard.type('شیر')
  await page.waitForTimeout(1500)
  await page.getByTestId('nav-tasks').click()
  await expect(page.getByTestId('task-row')).toHaveCount(2, { timeout: 30_000 })
  await page.getByTestId('task-row').filter({ hasText: 'نان' }).locator('.ds-check').click()
  await page.waitForTimeout(1500)
  // open the page: the item is ticked THERE
  await page.evaluate(() => { location.hash = `#/page/${(window as unknown as { __ws: { data: { pages: { id: string }[] } } }).__ws.data.pages[0]!.id}` })
  await page.waitForFunction(() => !!(window as unknown as { __editor?: { isDestroyed?: boolean } }).__editor && !(window as unknown as { __editor: { isDestroyed: boolean } }).__editor.isDestroyed)
  await expect(page.locator('.ProseMirror li[data-checked="true"]')).toHaveCount(1, { timeout: 20_000 })
})
