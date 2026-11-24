import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady, reopenWorkspace } from './shell-helpers'

// ROADMAP M8a: paste from Markdown, from a web page / Word / an AI chat. Pasted content is untrusted: nothing that runs, nothing huge.
const pw = 'correct horse battery'
test.setTimeout(90_000)
// Firefox ignores `clipboardData` in `new ClipboardEvent(...)`, so a synthetic paste cannot be driven there (a platform limit, not a bug of the editor);
// the owner's checklist covers pasting in Firefox. Chromium and WebKit run every case.
test.beforeEach(({ browserName }) => { test.skip(browserName === 'firefox', 'Firefox cannot be given clipboardData by a script') })

async function open(page: Page) {
  const name = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await createNew(page, 'new-page')
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor)
  await page.getByTestId('editor').locator('.ProseMirror').click()
  return name
}
const paste = (page: Page, data: { text?: string; html?: string }) => page.evaluate(d => {
  const dt = new DataTransfer()
  if (d.text !== undefined) dt.setData('text/plain', d.text)
  if (d.html !== undefined) dt.setData('text/html', d.html)
  document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}, data)
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string }
const json = (page: Page) => page.evaluate(() => (window as unknown as { __editor: { getJSON: () => unknown } }).__editor.getJSON()) as Promise<Json>
const all = (n: Json): Json[] => [n, ...(n.content ?? []).flatMap(all)]

test('Markdown from an AI chat becomes headings, lists, tasks, a callout, a toggle, math, a diagram, a table and code', async ({ page }) => {
  await open(page)
  await paste(page, { text: [
    '# عنوان', '', 'یک **پررنگ** و `کد` و [پیوند](https://example.com)', '', '- یک', '- دو', '', '1. اول', '2. دوم', '', '- [x] انجام شد', '- [ ] هنوز', '',
    '> [!WARNING]', '> مراقب باشید', '', '<details><summary>بیشتر</summary>', '', 'پنهان', '', '</details>', '', '$$', 'E = mc^2', '$$', '', 'و درون‌خطی $x^2$ تمام', '',
    '```mermaid', 'graph TD', '  A --> B', '```', '', '| الف | ب |', '|---|---|', '| ۱ | ۲ |', '', '```ts', 'const x = 1', '```',
  ].join('\n') })
  const nodes = all(await json(page))
  const types = new Set(nodes.map(n => n.type))
  for (const t of ['heading', 'bulletList', 'orderedList', 'taskList', 'callout', 'toggle', 'mathBlock', 'mathInline', 'mermaid', 'table', 'codeBlock']) expect(types.has(t), `no ${t}`).toBe(true)
  expect(nodes.find(n => n.type === 'callout')!.attrs!.icon).toBe('warning')
  expect(nodes.find(n => n.type === 'mathBlock')!.attrs!.latex).toBe('E = mc^2')
  expect(String(nodes.find(n => n.type === 'mermaid')!.attrs!.code)).toContain('A --> B')
  expect(nodes.filter(n => n.type === 'taskItem').map(n => n.attrs!.checked)).toEqual([true, false])
  expect(nodes.some(n => n.marks?.some(m => m.type === 'link' && m.attrs?.href === 'https://example.com'))).toBe(true)
  expect(nodes.find(n => n.type === 'codeBlock')!.attrs!.language).toBe('ts')
})

test('HTML from a web page, Word or a chat is cleaned: no scripts, handlers, styles, unsafe links or data: images', async ({ page }) => {
  await open(page)
  const dirty = `<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]-->
    <style>p{color:red}</style><script>window.__pwned = 1</script>
    <p class="MsoNormal" style="color:red" onclick="window.__pwned=2">سلام <o:p></o:p><b>پررنگ</b></p>
    <p><a href="javascript:window.__pwned=3">بد</a> <a href="https://example.com/ok" onmouseover="window.__pwned=4">خوب</a> <a href=" java&#9;script:alert(1)">بد۲</a></p>
    <img src="data:image/png;base64,${'A'.repeat(2000)}" alt="تصویر خطرناک"><img src="http://example.com/a.png" alt="http"><img src="https://example.com/ok.png" alt="خوب">
    <iframe src="https://evil.example"></iframe><form><input name="x"></form>`
  await paste(page, { html: dirty })
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  const doc = await json(page)
  const nodes = all(doc)
  const text = JSON.stringify(doc)
  expect(text).toContain('سلام')
  expect(text).not.toContain('javascript')
  expect(text).not.toContain('data:image')
  expect(text).not.toContain('AAAAAAAA')
  expect(text).not.toContain('evil.example')
  const links = nodes.flatMap(n => (n.marks ?? []).filter(m => m.type === 'link').map(m => m.attrs!.href))
  expect(links).toEqual(['https://example.com/ok'])
  const images = nodes.filter(n => n.type === 'image')
  expect(images.map(i => i.attrs!.src).sort()).toEqual(['', '', 'https://example.com/ok.png']) // data: and http: became placeholders
  await expect(page.getByTestId('editor').locator('.ProseMirror script, .ProseMirror iframe, .ProseMirror style')).toHaveCount(0)
})

test('raw Mermaid text becomes one diagram block; plain prose stays text', async ({ page }) => {
  await open(page)
  await paste(page, { text: 'یک جملهٔ ساده\nو خط دوم' })
  expect(all(await json(page)).filter(n => n.type === 'mermaid').length).toBe(0)
  await page.keyboard.press('Enter') // a new line: the next paste would otherwise replace what is selected
  await paste(page, { text: 'graph TD\n  A --> B\n  B --> C' })
  expect(all(await json(page)).filter(n => n.type === 'mermaid').length).toBe(1)
})

test('rich paste syncs embedded image bytes, links and Mermaid to another device', async ({ page, browser, storageState }) => {
  const username = await open(page)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a8sAAAAASUVORK5CYII='
  await paste(page, { html: `<p>Before <a href="https://example.com">link</a></p><img src="data:image/png;base64,${png}" alt="pixel"><pre><code class="language-mermaid">graph TD\n A--&gt;B</code></pre>` })
  await expect.poll(async () => all(await json(page)).find(n => n.type === 'image')?.attrs?.blob).toMatch(/^[a-f0-9]{64}$/)
  const nodes = all(await json(page))
  expect(nodes.find(n => n.type === 'image')!.attrs).toMatchObject({ mime: 'image/png', alt: 'pixel', src: '' })
  expect(nodes.some(n => n.marks?.some(m => m.type === 'link' && m.attrs?.href === 'https://example.com'))).toBe(true)
  expect(nodes.find(n => n.type === 'mermaid')?.attrs?.code).toContain('A-->B')
  await expect(page.locator('.image-block img')).toBeVisible()
  await page.waitForTimeout(900)
  await expect(page.locator('span:has([data-testid=outbox])').first()).toHaveText(/: 0$/, { timeout: 30_000 })
  await page.reload()
  await page.getByTestId('page-row').first().dblclick()
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor)
  await expect.poll(async () => all(await json(page)).find(n => n.type === 'image')?.attrs?.blob).toMatch(/^[a-f0-9]{64}$/)
  const second = await browser.newContext({ storageState })
  try {
    const other = await second.newPage()
    await other.goto('/')
    await other.locator('input[name=username]').fill(username)
    await other.locator('input[name=password]').fill(pw)
    await other.getByTestId('auth-submit').click()
    await reopenWorkspace(other)
    await other.getByTestId('page-row').first().dblclick()
    const body = other.getByTestId('editor')
    await expect(body.locator('.image-block img')).toBeVisible({ timeout: 30_000 })
    await expect(body.locator('a[href="https://example.com"]')).toHaveText('link')
    await expect.poll(async () => all(await json(other)).find(n => n.type === 'mermaid')?.attrs?.code).toContain('A-->B')
  } finally { await second.close() }
})

test('a rich clipboard image uses its accompanying file bytes without losing text', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const dt = new DataTransfer()
    const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    dt.items.add(new File([Uint8Array.from(binary, c => c.charCodeAt(0))], 'pixel.png', { type: 'image/png' }))
    dt.setData('text/html', '<p>Before <a href="https://example.com">link</a></p><img src="https://example.com/expires.png" alt="pixel"><p>After</p>')
    document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await expect.poll(async () => all(await json(page)).find(n => n.type === 'image')?.attrs?.blob).toMatch(/^[a-f0-9]{64}$/)
  const nodes = all(await json(page))
  expect(nodes.filter(n => n.type === 'image')).toHaveLength(1)
  expect(nodes.find(n => n.type === 'image')!.attrs).toMatchObject({ mime: 'image/png', alt: 'pixel', src: '' })
  expect(JSON.stringify(nodes)).toContain('Before')
  expect(JSON.stringify(nodes)).toContain('After')
  expect(nodes.some(n => n.marks?.some(m => m.type === 'link' && m.attrs?.href === 'https://example.com'))).toBe(true)
})
