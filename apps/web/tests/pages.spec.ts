import { expect, test, type Page } from '@playwright/test'

// The notes app (M5) with a real account against the real server, in each engine.
const user = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const pw = 'correct horse battery'
test.setTimeout(60_000)

export async function signUpAndOpen(page: Page, name = user()) {
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await expect(page.getByTestId('new-page')).toBeVisible()
  return name
}
export async function signIn(page: Page, name: string) {
  await page.goto('/')
  // the cookie of a context outlives its pages: only sign in when asked to
  if (await page.getByTestId('auth-form').isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.locator('input[name=username]').fill(name)
    await page.locator('input[name=password]').fill(pw)
    await page.getByTestId('auth-submit').click()
  }
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await expect(page.getByTestId('new-page')).toBeVisible()
}
const body = (page: Page) => page.getByTestId('editor').locator('.ProseMirror')

test('create a page, write Persian and English, reload: it is all still there; rename, nest, trash and restore', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('new-page').click()
  await page.getByTestId('title').fill('سفر به شیراز')
  await body(page).click()
  await page.keyboard.type('سلام دنیا. hello world ۱۲۳')
  await expect(body(page)).toContainText('سلام دنیا. hello world ۱۲۳')
  // every block has an id (ADR-0003 §5)
  await expect(body(page).locator('p').first()).toHaveAttribute('data-block-id', /^[0-9a-f-]{36}$/)
  await page.waitForTimeout(700)

  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('page-row').first().getByRole('button').nth(1).click()
  await expect(page.getByTestId('title')).toHaveValue('سفر به شیراز')
  await expect(body(page)).toContainText('سلام دنیا. hello world ۱۲۳')

  // a child page; the parent can be expanded
  await page.getByRole('button', { name: 'زیرصفحه' }).click()
  await expect(page.getByTestId('title')).toHaveValue('') // the new page is selected (else the fill would rename the parent)
  await page.getByTestId('title').fill('بازار وکیل')
  await page.waitForTimeout(600)
  await page.getByTestId('page-row').first().getByRole('button').first().click()
  await expect(page.getByTestId('page-row')).toHaveCount(2)

  // trash the child, then restore it
  await page.getByRole('button', { name: 'حذف' }).click()
  await expect(page.getByTestId('page-row')).toHaveCount(1)
  await page.getByTestId('trash-toggle').click()
  await expect(page.getByTestId('trash')).toContainText('بازار وکیل')
  await page.getByTestId('trash').getByRole('button', { name: 'بازگردانی' }).click()
  await page.getByTestId('trash-toggle').click()
  await expect(page.getByTestId('page-row')).toHaveCount(2)
})

test('closing the tab 400 ms after the last key loses nothing (the throttle window is 300 ms)', async ({ page, context }) => {
  const name = await signUpAndOpen(page)
  await page.getByTestId('new-page').click()
  await body(page).click()
  await page.keyboard.type('پایدار ماندن بعد از بستن صفحه')
  await page.waitForTimeout(400)
  await page.close()
  const again = await context.newPage()
  await signIn(again, name)
  await again.getByTestId('page-row').first().getByRole('button').nth(1).click()
  await expect(body(again)).toContainText('پایدار ماندن بعد از بستن صفحه')
})

test('a page touched by a newer schema is not opened for editing (message instead)', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('new-page').click()
  await page.getByTestId('title').fill('x')
  await page.waitForTimeout(700)
  const id = await page.getByTestId('page-row').first().getAttribute('data-id')
  await page.evaluate(id => (window as unknown as { __ws: { rt: { store: { run: (f: (tx: { bumpMaxSv: (d: string, v: number) => Promise<void> }) => Promise<void>) => Promise<void> } } } }).__ws.rt.store.run(tx => tx.bumpMaxSv(id!, 2)), id)
  await page.getByTestId('new-page').click() // select another page, then come back
  await page.getByTestId('page-row').first().getByRole('button').nth(1).click()
  await expect(page.getByTestId('needs-update')).toBeVisible()
  await expect(page.getByTestId('editor')).toHaveCount(0)
})

test('signing out stops the sync and shows the sign-in form', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('signout').click()
  await expect(page.getByTestId('auth-form')).toBeVisible()
})
