import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'
import { expect, test, type Page } from '@playwright/test'
import { appReady, createNew } from './shell-helpers'

// ROADMAP M12 in the real app: download the bundle and the Markdown zip, import the bundle into a NEW workspace of the same account.
const pw = 'correct horse battery'
test.setTimeout(180_000)
const body = (p: Page) => p.getByTestId('editor').locator('.ProseMirror')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('export the bundle and the Markdown zip; import the bundle into a new workspace: the pages, the text and the picture are there', async ({ browser }) => {
  const c1 = await browser.newContext({ acceptDownloads: true }), c2 = await browser.newContext()
  try {
    const a = await c1.newPage()
    const user = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    await a.goto('/')
    await a.getByRole('button', { name: 'حساب ندارم' }).click()
    await a.locator('input[name=username]').fill(user); await a.locator('input[name=password]').fill(pw)
    await a.getByTestId('auth-submit').click()
    await expect(a.getByTestId('recovery')).toBeVisible()
    await a.getByTestId('ws-new').click(); await appReady(a)
    await createNew(a, 'new-page')
    await a.getByTestId('title').fill('گزارش من'); await a.waitForTimeout(700)
    await body(a).click(); await a.keyboard.type('متن فارسی و English')
    // a picture (an attachment)
    await a.getByTestId('editor').click()
    const chooser = a.waitForEvent('filechooser')
    await a.keyboard.press('Enter'); await a.keyboard.type('/image'); await expect(a.locator('.floating-menu .row').first()).toBeVisible(); await a.keyboard.press('Enter')
    await (await chooser).setFiles([{ name: 'p.png', mimeType: 'image/png', buffer: PNG }])
    await expect(a.locator('.image-block img')).toBeVisible()
    await a.waitForTimeout(1500)
    await a.getByTestId('nav-settings').click()
    await a.getByTestId('settings-tab-data').click()
    const [bundle] = await Promise.all([a.waitForEvent('download'), a.getByTestId('export-bundle').click()])
    const zip = new Uint8Array(await readFile((await bundle.path())!))
    const files = unzipSync(zip)
    expect(Object.keys(files)).toContain('manifest.json')
    expect(strFromU8(files['entities.ndjson']!)).toContain('گزارش من')
    const pageFile = Object.keys(files).find(k => k.startsWith('pages/'))!
    expect(strFromU8(files[pageFile]!)).toContain('متن فارسی و English')
    expect(Object.keys(files).filter(k => k.startsWith('attachments/') && !k.endsWith('.ndjson')).length).toBe(1)
    const [md] = await Promise.all([a.waitForEvent('download'), a.getByTestId('export-markdown').click()])
    const mdFiles = unzipSync(new Uint8Array(await readFile((await md.path())!)))
    const mdName = Object.keys(mdFiles).find(k => k.endsWith('.md'))!
    expect(strFromU8(mdFiles[mdName]!)).toContain('متن فارسی و English')
    expect(strFromU8(mdFiles[mdName]!)).toContain('title: "گزارش من"')

    // import into a NEW workspace of the same account, in another browser
    const b = await c2.newPage()
    await b.goto('/')
    await b.locator('input[name=username]').fill(user); await b.locator('input[name=password]').fill(pw)
    await b.getByTestId('auth-submit').click()
    await b.getByTestId('ws-list').waitFor()
    await b.getByTestId('ws-import').setInputFiles({ name: 'nevis.nevis.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) })
    await appReady(b)
    await expect(b.getByTestId('page-row')).toHaveCount(1, { timeout: 30_000 })
    await b.getByTestId('page-row').first().click()
    await expect(b.getByTestId('title')).toHaveValue('گزارش من')
    await expect(body(b)).toContainText('متن فارسی و English')
    await expect(b.locator('.image-block img')).toBeVisible({ timeout: 30_000 })
  } finally { await c1.close(); await c2.close() }
})
