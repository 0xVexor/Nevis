import { readFile } from 'node:fs/promises'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { expect, test, type Page } from '@playwright/test'
import { appReady, createNew } from './shell-helpers'
import { addProp } from './db-helpers'

// ROADMAP M12 in the real app: download the bundle and the Markdown zip, import the bundle into a NEW workspace of the same account.
const pw = 'correct horse battery'
test.setTimeout(180_000)
const body = (p: Page) => p.getByTestId('editor').locator('.ProseMirror')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('export the bundle and the Markdown zip; import the bundle into a new workspace: the pages, the text and the picture are there', async ({ browser, storageState }) => {
  const c1 = await browser.newContext({ acceptDownloads: true, storageState }), c2 = await browser.newContext({ storageState })
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
    await a.keyboard.press('Enter'); await a.keyboard.type('/image'); await expect(a.locator('.slash-menu .ds-menu-item').first()).toBeVisible(); await a.keyboard.press('Enter')
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
    await b.getByTestId('page-row').first().dblclick()
    await expect(b.getByTestId('title')).toHaveValue('گزارش من')
    await expect(body(b)).toContainText('متن فارسی و English')
    await expect(b.locator('.image-block img')).toBeVisible({ timeout: 30_000 })
  } finally { await c1.close(); await c2.close() }
})


test('import a Markdown zip with multiple notes and a nested folder', async ({ page }) => {
  const user = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(user); await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await page.getByTestId('ws-import').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({
    'First.md': strToU8('# First heading\n\n**Bold text**\n\n![Archived image](images/p.png)'),
    'Folder/Second.md': strToU8('Second note content'),
    'images/p.png': PNG,
  })) })
  await appReady(page)
  await expect(page.getByTestId('page-row')).toHaveCount(3, { timeout: 30_000 })
  await page.getByTestId('page-row').filter({ hasText: 'First' }).dblclick()
  await expect(body(page)).toContainText('First heading')
  await expect(body(page).locator('strong')).toHaveText('Bold text')
  await expect(body(page).locator('.image-block img')).toBeVisible()
})

for (const [name, text] of [['single.md', '# Standalone Markdown'], ['single.txt', 'Standalone plain text']] as const) {
  test(`import ${name} directly`, async ({ page }) => {
    const user = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    await page.goto('/')
    await page.getByTestId('auth-switch').click()
    await page.locator('input[name=username]').fill(user)
    await page.locator('input[name=password]').fill(pw)
    await page.getByTestId('auth-submit').click()
    await page.getByTestId('ws-import').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
    await appReady(page)
    await page.getByTestId('page-row').first().dblclick()
    await expect(body(page)).toContainText(text.replace(/^# /, ''))
  })
}

test('workspace Markdown includes database record values', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('auth-switch').click()
  await page.locator('input[name=username]').fill('mdrecord' + Date.now().toString(36))
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await page.getByTestId('ws-new').click()
  await createNew(page, 'new-database')
  await page.getByTestId('db-title').fill('Projects')
  await addProp(page, 'Budget', 'number')
  await page.getByTestId('db-add-row').click()
  const record = page.getByTestId('db-row').first()
  await record.locator('[data-prop="نام"] input').fill('Garden')
  const budget = record.locator('[data-prop="Budget"] input')
  await budget.fill('42')
  await budget.blur()
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-tab-data').click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-markdown').click()])
  const files = unzipSync(new Uint8Array(await readFile((await download.path())!)))
  const recordPath = Object.keys(files).find(path => /^Projects--[^/]+\/Garden--.+\.md$/.test(path))
  expect(recordPath).toBeDefined()
  expect(strFromU8(files[recordPath!]!)).toContain('**Budget**: 42')
})

test('import formatted HTML table from a Markdown export', async ({ page }) => {
  const user = `table${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const text = '<table dir="rtl">\n<tr><td colspan="2"><p>literal **x** &amp; &lt;tag&gt; <strong>bold</strong> <code>code</code> <a href="https://example.com">link</a></p><p>second</p></td></tr>\n</table>\n'
  await page.goto('/')
  await page.getByTestId('auth-switch').click()
  await page.locator('input[name=username]').fill(user)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await page.getByTestId('ws-import').setInputFiles({ name: 'table.md', mimeType: 'text/markdown', buffer: Buffer.from(text) })
  await appReady(page)
  await page.getByTestId('page-row').first().dblclick()
  const cell = body(page).locator('td')
  await expect(cell).toContainText('literal **x** & <tag>')
  await expect(cell.locator('strong')).toHaveText('bold')
  await expect(cell.locator('code')).toHaveText('code')
  await expect(cell.locator('a')).toHaveAttribute('href', 'https://example.com')
  await expect(cell.locator('p')).toHaveCount(2)
})
