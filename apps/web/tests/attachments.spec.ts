import { createHash } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady } from './shell-helpers'

// ROADMAP M9 in the real app, against the real Go server: images and files go into a page, live on this device first, upload in the
// background, and the op that names them waits for them. Chromium, WebKit and Firefox.
const pw = 'correct horse battery'
test.setTimeout(180_000)

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const body = (page: Page) => page.getByTestId('editor').locator('.ProseMirror')
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[] }
const docJson = (page: Page) => page.evaluate(() => (window as unknown as { __editor: { getJSON: () => unknown } }).__editor.getJSON()) as Promise<Json>
const nodes = (n: Json, type: string): Json[] => [...(n.type === type ? [n] : []), ...(n.content ?? []).flatMap(c => nodes(c, type))]

async function signUp(page: Page, name = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`) {
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
async function newPage(page: Page) {
  await createNew(page, 'new-page')
  await expect(body(page)).toBeVisible()
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor)
}
/** An empty paragraph at the end, the caret in it, then `/query` + Enter. */
async function slash(page: Page, query: string) {
  await page.evaluate(() => {
    const e = (window as unknown as { __editor: { chain: () => { focus: () => { command: (f: (p: { tr: { insert: (pos: number, n: unknown) => void }; state: { doc: { content: { size: number } }; schema: { nodes: Record<string, { create: () => unknown }> } } }) => boolean) => { run: () => void } } }; commands: { focus: (p: string) => void } } }).__editor
    e.chain().focus().command(({ tr, state }) => { tr.insert(state.doc.content.size, state.schema.nodes.paragraph!.create()); return true }).run()
    e.commands.focus('end')
  })
  await body(page).focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('/' + query)
  await expect(page.locator('.floating-menu .row').first()).toBeVisible()
  await page.keyboard.press('Enter')
}
/** Slash command that opens the file picker, answered with `files`. */
async function attach(page: Page, query: string, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent('filechooser')
  await slash(page, query)
  await (await chooser).setFiles(files)
}
const outbox = (page: Page) => page.getByTestId('outbox')
/** Everything this tab wrote has been written to the local database AND sent: the status line says "not sent yet: 0" with no unsaved suffix.
 *  (The page's own write is debounced, so "0" read at once can simply mean the write has not been made yet.) */
const sent = async (page: Page) => {
  await page.waitForTimeout(900)
  await expect(page.locator('span:has([data-testid=outbox])').first()).toHaveText(/: 0$/, { timeout: 30_000 })
}
const waiting = (page: Page) => expect.poll(async () => Number(await outbox(page).innerText()), { timeout: 15_000 }).toBeGreaterThan(0)
const myWorkspace = (page: Page) => page.evaluate(async () => (await (await fetch('/v1/ws')).json()).workspaces[0].id as string)
const serverHas = (page: Page, ws: string, hash: string) => page.evaluate(async ([w, h]) => (await fetch(`/v1/ws/${w}/blobs/${h}`, { method: 'HEAD' })).status, [ws, hash] as const)

test('an image picked from the slash menu shows at once, uploads in the background, and is still there after a reload', async ({ page }) => {
  await signUp(page)
  await newPage(page)
  await attach(page, 'image', [{ name: 'عکس.png', mimeType: 'image/png', buffer: PNG }])
  const img = page.locator('.image-block img')
  await expect(img).toBeVisible()
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1)
  expect((await img.getAttribute('src'))!.startsWith('blob:')).toBe(true) // drawn from bytes we looked at, never from a server URL
  const [node] = nodes(await docJson(page), 'image')
  expect(node!.attrs).toMatchObject({ blob: sha(PNG), mime: 'image/png', size: PNG.length })
  await sent(page) // the op went only after the file was on the server
  expect(await serverHas(page, await myWorkspace(page), sha(PNG))).toBe(200)
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('page-row').first().dblclick()
  await expect(page.locator('.image-block img')).toBeVisible()
  expect(await page.locator('.image-block img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1)
})

test('a file that is not a picture becomes a file card and downloads as the identical bytes; a picture by name that is really SVG is never drawn', async ({ page }) => {
  await signUp(page)
  await newPage(page)
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) & 255))])
  await attach(page, 'file', [{ name: 'گزارش.pdf', mimeType: 'application/pdf', buffer: pdf }])
  const card = page.getByTestId('file-card')
  await expect(card).toBeVisible()
  await expect(card).toContainText('گزارش.pdf')
  const [dl] = await Promise.all([page.waitForEvent('download'), card.click()])
  expect(dl.suggestedFilename()).toBe('گزارش.pdf')
  const got = Buffer.from(await (await import('node:fs/promises')).readFile((await dl.path())!))
  expect(sha(got)).toBe(sha(pdf))
  // an SVG called x.png, sent through the PICTURE picker: by its bytes it is not a picture
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await attach(page, 'image', [{ name: 'x.png', mimeType: 'image/png', buffer: svg }])
  await expect.poll(async () => nodes(await docJson(page), 'file').length).toBe(2)
  expect(nodes(await docJson(page), 'image').length).toBe(0)
  await expect(page.locator('.image-block img')).toHaveCount(0)
})

test('offline: the image is kept and shown here, the op waits; online: it uploads and another browser shows it', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  try {
    const a = await ca.newPage()
    const user = await signUp(a)
    await newPage(a)
    await body(a).click(); await a.keyboard.type('پیش از پیوست')
    await sent(a)
    await ca.setOffline(true)
    await attach(a, 'image', [{ name: 'offline.png', mimeType: 'image/png', buffer: PNG }])
    await expect(a.locator('.image-block img')).toBeVisible()
    await expect(a.getByTestId('files')).toBeVisible() // "files waiting to upload"
    await waiting(a) // the op that names the file is written and waits
    await ca.setOffline(false)
    await a.evaluate(() => window.dispatchEvent(new Event('online')))
    await sent(a)
    // the second browser signs in to the same account and opens the page: it has never seen the file
    const b = await cb.newPage()
    await b.goto('/')
    await b.locator('input[name=username]').fill(user)
    await b.locator('input[name=password]').fill(pw)
    await b.getByTestId('auth-submit').click()
    await b.getByTestId('ws-list').getByRole('button').first().click()
    await expect(b.getByTestId('page-row')).toHaveCount(1, { timeout: 30_000 })
    await b.getByTestId('page-row').first().dblclick()
    const img = b.locator('.image-block img')
    await expect(img).toBeVisible({ timeout: 30_000 })
    expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1)
  } finally { await ca.close(); await cb.close() }
})

test('a page that arrives before its file says so, never writes over it, and shows the picture when it comes', async ({ page }) => {
  await signUp(page)
  await newPage(page)
  const hash = sha(PNG)
  await page.evaluate(h => (window as unknown as { __editor: { commands: { insertContent: (c: unknown) => void } } }).__editor.commands.insertContent({ type: 'image', attrs: { blob: h, mime: 'image/png', size: 70, alt: 'x' } }), hash)
  const missing = page.locator('.image-placeholder[data-state=missing]')
  await expect(missing).toBeVisible()
  const before = JSON.stringify(await docJson(page))
  await page.waitForTimeout(2500)
  expect(JSON.stringify(await docJson(page))).toBe(before) // nothing was written because bytes were missing
  // the file reaches the server (as if another device had just uploaded it)
  const ws = await myWorkspace(page)
  const status = await page.evaluate(async ([w, h, b64]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    return (await fetch(`/v1/ws/${w}/blobs/${h}?offset=0&total=${bytes.length}`, { method: 'PUT', headers: { 'Nevis-Proto': '1' }, body: bytes })).status
  }, [ws, hash, PNG.toString('base64')] as const)
  expect(status).toBe(200)
  await expect(page.locator('.image-block img')).toBeVisible({ timeout: 30_000 })
})

test('the server says the account is full: a clear message, the file and the page stay here, and it goes when there is room', async ({ page }) => {
  await signUp(page)
  await newPage(page)
  await page.route('**/v1/ws/*/blobs/*', route => (route.request().method() === 'PUT' ? route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: { code: 'quota_exceeded', message: 'full', retryable: false } }) }) : route.continue()))
  await attach(page, 'image', [{ name: 'q.png', mimeType: 'image/png', buffer: PNG }])
  await expect(page.getByTestId('files-quota')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.image-block img')).toBeVisible() // local data intact
  await waiting(page) // the op that names the file is written and still waits
  await page.unroute('**/v1/ws/*/blobs/*')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await sent(page)
  await expect(page.getByTestId('files-quota')).toHaveCount(0)
})

test('a file dropped on the page becomes an image block (Chromium: scripted drops are not delivered the same way elsewhere)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'WebKit and Firefox do not accept a scripted drop of files')
  await signUp(page)
  await newPage(page)
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }))
    const target = document.querySelector('.ProseMirror')!
    const r = target.getBoundingClientRect()
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }))
  }, PNG.toString('base64'))
  await expect(page.locator('.image-block img')).toBeVisible()
})
