import { expect, test } from '@playwright/test'
import { createNew, appReady } from './shell-helpers'

const pw = 'correct horse battery'
async function signUpAndOpen(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(`s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await appReady(page)
}

// The screens the old app has beyond the page itself (inbox tasks, lists, files, drawings, databases, find in page, the toolbar), in the real app.
test.setTimeout(120_000)
const body = (p: import('@playwright/test').Page) => p.getByTestId('editor').locator('.ProseMirror')

test('Tasks: a task typed into the inbox shows at once, can be ticked, and survives a reload; a new list is a page', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('nav-tasks').click()
  await page.getByTestId('task-add').fill('خرید نان')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('task-row')).toContainText('خرید نان', { timeout: 15_000 })
  await page.getByTestId('task-row').locator('.ds-check').first().click()
  await expect(page.locator('.tk-done-toggle .ds-badge')).toHaveText('۱', { timeout: 15_000 }) // a ticked task moves to Completed
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('nav-tasks').click()
  await expect(page.locator('.tk-done-toggle .ds-badge')).toHaveText('۱', { timeout: 15_000 }) // still done after the reload
  // the inbox is a page the tree does not show; a new list is one it does
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('page-row')).toHaveCount(0)
  await page.getByTestId('nav-tasks').click()
  await page.getByTestId('new-list').click()
  await expect(page.getByTestId('title')).toBeVisible()
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('page-row')).toHaveCount(1)
})

test('Files, Drawings and Databases open in the old frames and act on the real pages', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await page.getByTestId('title').fill('برگه')
  await page.waitForTimeout(700)
  await page.getByTestId('nav-files').click()
  await expect(page.getByTestId('files')).toContainText('برگه')
  await page.getByTestId('nav-drawings').click()
  await expect(page.getByTestId('drawings')).toBeVisible()
  await page.getByTestId('nav-databases').click()
  await expect(page.getByTestId('databases')).toBeVisible()
  await createNew(page, 'new-database')
  await expect(page.getByTestId('db-view')).toBeVisible()
  await page.getByTestId('nav-databases').click()
  await expect(page.getByTestId('databases')).toContainText('پایگاه')
})

test('find in page (Ctrl+F) highlights every match and steps through them; the toolbar bolds the selection', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await body(page).click()
  await page.keyboard.type('سلام دنیا. سلام دوباره. وداع')
  await page.keyboard.press('Control+f')
  await expect(page.getByTestId('find')).toBeVisible()
  await page.getByTestId('find').locator('input').fill('سلام')
  await expect(page.getByTestId('find')).toContainText('1 از 2')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('find')).toContainText('2 از 2')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('find')).toHaveCount(0)
  await body(page).click()
  await page.evaluate(() => (window as unknown as { __editor: { commands: { selectAll: () => void } } }).__editor.commands.selectAll())
  await page.getByRole('toolbar').getByRole('button', { name: /^درشت/ }).click()
  await expect(body(page).locator('strong, b').first()).toBeVisible()
})
