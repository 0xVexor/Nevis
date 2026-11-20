import { expect, test, type Page } from '@playwright/test'

// Sign-in with a real account, in each engine: the cookie must be set, survive a reload, be shared by a second tab, and go on signout.
const user = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const pw = 'correct horse battery'

async function signUp(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
}

test('sign up, create a workspace, reload stays signed in, sign out', async ({ page, context }) => {
  const name = user()
  await signUp(page, name)
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible()
  await page.getByTestId('ws-new').click()
  await expect(page.getByTestId('new-page')).toBeVisible()

  // the session is a cookie the page's scripts cannot read
  expect(await page.evaluate(() => document.cookie)).not.toContain('nevis_session')
  const cookie = (await context.cookies()).find(c => c.name === 'nevis_session')
  expect(cookie, 'session cookie was stored').toBeTruthy()
  expect(cookie!.httpOnly).toBe(true)
  expect(cookie!.sameSite).toBe('Strict')

  // a reload and a second tab are still signed in
  await page.reload()
  await expect(page.getByTestId('ws-list').getByRole('button')).toHaveCount(1)
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByTestId('ws-list')).toBeVisible()
  await second.close()

  await page.getByTestId('signout').click()
  await expect(page.getByTestId('auth-form')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('auth-form')).toBeVisible()
})

test('a wrong password is refused with a readable message; signing out one browser leaves the other signed in', async ({ page, browser }) => {
  const name = user()
  await signUp(page, name)
  await page.getByTestId('signout').click()

  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill('wrong wrong wrong')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-error')).toContainText('درست نیست')

  const other = await (await browser.newContext()).newPage()
  for (const p of [page, other]) {
    await p.goto('/')
    await p.locator('input[name=username]').fill(name)
    await p.locator('input[name=password]').fill(pw)
    await p.getByTestId('auth-submit').click()
    await expect(p.getByTestId('ws-new')).toBeVisible()
  }
  await page.getByTestId('signout').click()
  await expect(page.getByTestId('auth-form')).toBeVisible()
  await other.reload()
  await expect(other.getByTestId('ws-new')).toBeVisible()
})
