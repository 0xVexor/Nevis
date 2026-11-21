import { expect, test, type Page } from '@playwright/test'
import { SV } from '@nevis/protocol'
import { createNew, appReady } from './shell-helpers'

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
  await appReady(page)
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
  await appReady(page)
}
const body = (page: Page) => page.getByTestId('editor').locator('.ProseMirror')

test('create a page, write Persian and English, reload: it is all still there; rename, nest, trash and restore', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await page.getByTestId('title').fill('سفر به شیراز')
  await body(page).click()
  await page.keyboard.type('سلام دنیا. hello world ۱۲۳')
  await expect(body(page)).toContainText('سلام دنیا. hello world ۱۲۳')
  // every block has an id (ADR-0003 §5)
  await expect(body(page).locator('p').first()).toHaveAttribute('data-block-id', /^[0-9a-f-]{36}$/)
  await page.waitForTimeout(700)

  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('page-row').first().dblclick()
  await expect(page.getByTestId('title')).toHaveValue('سفر به شیراز')
  await expect(body(page)).toContainText('سلام دنیا. hello world ۱۲۳')

  // a child page; the parent can be expanded
  await page.getByTestId('page-row').first().hover()
  await page.getByTestId('page-row').first().getByRole('button', { name: 'زیرصفحه جدید' }).click()
  await expect(page.getByTestId('title')).toHaveValue('') // the new page is selected (else the fill would rename the parent)
  await page.getByTestId('title').fill('بازار وکیل')
  await page.waitForTimeout(600)
  await expect(page.getByTestId('page-row')).toHaveCount(2) // the old tree shows a page's children open

  // trash the child, then restore it
  await page.getByTestId('page-row').nth(1).click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await expect(page.getByTestId('page-row')).toHaveCount(1)
  await page.getByTestId('trash-toggle').click()
  await expect(page.getByTestId('trash')).toContainText('بازار وکیل')
  await page.getByTestId('trash').getByRole('button', { name: 'بازیابی' }).click()
  await page.getByTestId('trash-toggle').click()
  await expect(page.getByTestId('page-row')).toHaveCount(2)
})

test('closing the tab 400 ms after the last key loses nothing (the throttle window is 300 ms)', async ({ page, context }) => {
  const name = await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await body(page).click()
  await page.keyboard.type('پایدار ماندن بعد از بستن صفحه')
  await page.waitForTimeout(400)
  await page.close()
  const again = await context.newPage()
  await signIn(again, name)
  await again.getByTestId('page-row').first().dblclick()
  await expect(body(again)).toContainText('پایدار ماندن بعد از بستن صفحه')
})

test('a page touched by a newer schema is not opened for editing (message instead)', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await page.getByTestId('title').fill('x')
  await page.waitForTimeout(700)
  const id = await page.getByTestId('page-row').first().getAttribute('data-id')
  await page.evaluate(([id, v]) => (window as unknown as { __ws: { rt: { store: { run: (f: (tx: { bumpMaxSv: (d: string, v: number) => Promise<void> }) => Promise<void>) => Promise<void> } } } }).__ws.rt.store.run(tx => tx.bumpMaxSv(id!, v)), [id, SV + 1] as const)
  await createNew(page, 'new-page') // select another page, then come back
  await page.getByTestId('page-row').first().dblclick()
  await expect(page.getByTestId('needs-update')).toBeVisible()
  await expect(page.getByTestId('editor')).toHaveCount(0)
})

test('signing out stops the sync and shows the sign-in form', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('signout').click()
  await expect(page.getByTestId('auth-form')).toBeVisible()
})

test('an edit too large for one op is refused with a visible message; the page turns read-only and reopens from what was saved', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await body(page).click()
  await page.keyboard.type('متن سالم')
  await page.waitForTimeout(700)
  await page.evaluate(() => (window as unknown as { __editor: { commands: { insertContent: (s: string) => void } } }).__editor.commands.insertContent('x'.repeat(1_700_000)))
  await expect(page.getByTestId('too-large')).toBeVisible({ timeout: 15_000 })
  await expect(body(page)).toHaveAttribute('contenteditable', 'false') // later typing would depend on the refused edit
  await page.getByTestId('too-large').getByRole('button').click()
  await expect(page.getByTestId('too-large')).toHaveCount(0)
  await expect(body(page)).toContainText('متن سالم')
  await expect(body(page)).not.toContainText('xxxxxxxxxx')
  await body(page).click()
  await page.keyboard.type(' ادامه')
  await expect(body(page)).toContainText('ادامه')
  await page.waitForFunction(() => document.querySelector('[data-testid=outbox]')?.textContent === '0', null, { timeout: 15_000 }) // nothing stuck behind it
})
