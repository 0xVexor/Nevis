import { expect, test, type Page } from '@playwright/test'
import { appReady, createNew, reopenWorkspace } from './shell-helpers'

// ROADMAP M13 in the real app: "Delete permanently" in the trash removes the page (and what is under it) on every device.
const pw = 'correct horse battery'
test.setTimeout(180_000)
const settled = (p: Page) => expect(p.locator('span:has([data-testid=outbox])').first()).toHaveText(/: 0$/, { timeout: 30_000 })

test('a page deleted permanently in one browser is gone in the other, and its ops are gone from the server', async ({ browser, storageState }) => {
  const ca = await browser.newContext({ storageState }), cb = await browser.newContext({ storageState })
  try {
    const a = await ca.newPage()
    const user = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    a.on('dialog', d => void d.accept())
    await a.goto('/')
    await a.getByRole('button', { name: 'حساب ندارم' }).click()
    await a.locator('input[name=username]').fill(user); await a.locator('input[name=password]').fill(pw)
    await a.getByTestId('auth-submit').click()
    await expect(a.getByTestId('recovery')).toBeVisible()
    await a.getByTestId('ws-new').click(); await appReady(a)
    await createNew(a, 'new-page')
    await a.getByTestId('title').fill('برای حذف دائمی'); await a.waitForTimeout(700)
    await a.getByTestId('editor').locator('.ProseMirror').click(); await a.keyboard.type('محتوایی که باید برای همیشه برود')
    await a.waitForTimeout(900); await settled(a)
    const id = await a.evaluate(() => (window as unknown as { __ws: { data: { pages: { id: string }[] } } }).__ws.data.pages[0]!.id)
    const ws = await a.evaluate(() => (window as unknown as { __ws: { ws: string } }).__ws.ws)
    const b = await cb.newPage()
    await b.goto('/')
    await b.locator('input[name=username]').fill(user); await b.locator('input[name=password]').fill(pw)
    await b.getByTestId('auth-submit').click()
    await reopenWorkspace(b)
    await expect(b.getByTestId('page-row')).toHaveCount(1, { timeout: 30_000 })
    // trash, then delete permanently
    await a.getByTestId('page-row').first().click({ button: 'right' })
    await a.getByTestId('menu-delete').click()
    await a.getByTestId('trash-toggle').click()
    await a.getByRole('button', { name: 'حذف دائمی' }).click()
    await expect.poll(() => a.evaluate(() => (window as unknown as { __ws: { data: { pages: unknown[] } } }).__ws.data.pages.length)).toBe(0)
    await settled(a)
    await expect(b.getByTestId('page-row')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => b.evaluate(() => (window as unknown as { __ws: { data: { pages: unknown[] } } }).__ws.data.pages.length), { timeout: 30_000 }).toBe(0) // the page is forgotten, not only hidden
    // the server keeps only the purge op for that document
    const ops = await a.evaluate(async w => ((await (await fetch(`/v1/ws/${w}/ops?after=0&limit=1000`)).json()) as { ops: { env: { doc: string } }[] }).ops.filter(o => o.env.doc).map(o => o.env.doc), ws)
    expect(ops.filter(d => d === id).length).toBe(1)
  } finally { await ca.close(); await cb.close() }
})
