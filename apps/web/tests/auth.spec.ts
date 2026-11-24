import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady } from './shell-helpers'

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
  await expect(page.getByTestId('ws-new')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await appReady(page)

  // the session is a cookie the page's scripts cannot read
  expect(await page.evaluate(() => document.cookie)).not.toContain('nevis_session')
  const cookie = (await context.cookies()).find(c => c.name === 'nevis_session')
  expect(cookie, 'session cookie was stored').toBeTruthy()
  expect(cookie!.httpOnly).toBe(true)
  expect(cookie!.sameSite).toBe('Strict')

  // a reload and a second tab are still signed in
  await page.reload()
  await appReady(page)
  const second = await context.newPage()
  await second.goto('/')
  await appReady(second)
  await second.close()

  await page.getByTestId('workspaces').click()
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

test('fresh profiles start in English and the recovery key can reset the password', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  try {
    const page = await context.newPage()
    const name = user()
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    await page.getByTestId('auth-switch').click()
    await page.locator('input[name=username]').fill(name)
    await page.locator('input[name=password]').fill(pw)
    await page.getByTestId('auth-submit').click()
    const key = page.getByTestId('recovery').locator('code')
    await expect(key).not.toBeEmpty()
    const original = await key.innerText()
    await page.getByRole('button', { name: 'Copy recovery key' }).click()
    await expect(key).toHaveText(original)
    await page.getByTestId('signout').click()
    await page.getByRole('button', { name: 'Forgot your password?' }).click()
    await page.locator('input[name=username]').fill(name)
    await page.locator('input[name=recoveryKey]').fill(original)
    await page.locator('input[name=password]').fill('a replacement password')
    await page.getByTestId('auth-submit').click()
    await expect(key).toBeVisible()
    await expect(key).not.toHaveText(original)
  } finally { await context.close() }
})

test('the sign-in screen recovers after the network returns', async ({ page }) => {
  // The page itself is served by Vite. Simulate losing only the API on startup.
  const fail = (route: import('@playwright/test').Route) => route.abort()
  await page.route('**/v1/me', fail)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'تلاش دوباره' })).toBeVisible()
  await page.unroute('**/v1/me', fail)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByTestId('auth-form')).toBeVisible()
})
