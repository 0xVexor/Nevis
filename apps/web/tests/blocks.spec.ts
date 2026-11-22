import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady, reopenWorkspace } from './shell-helpers'

// ROADMAP M8a: every block of the old editor, inserted from the slash menu in the real app, rendered, saved, and read back after a reload.
const pw = 'correct horse battery'
test.setTimeout(120_000)

async function signUpAndOpen(page: Page) {
  const name = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
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
const body = (page: Page) => page.getByTestId('editor').locator('.ProseMirror')
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string }
const docJson = (page: Page) => page.evaluate(() => (window as unknown as { __editor: { getJSON: () => unknown } }).__editor.getJSON()) as Promise<Json>
const find = (n: Json, type: string): Json[] => [...(n.type === type ? [n] : []), ...(n.content ?? []).flatMap(c => find(c, type))]

/** An empty paragraph at the end of the page (outside any block), the caret in it, then `/query` + Enter. */
async function slash(page: Page, query: string) {
  await page.evaluate(() => {
    const e = (window as unknown as { __editor: { chain: () => { focus: () => { command: (f: (p: { tr: { insert: (pos: number, n: unknown) => void }; state: { doc: { content: { size: number } }; schema: { nodes: Record<string, { create: () => unknown }> } } }) => boolean) => { run: () => void } } }; commands: { focus: (p: string) => void } } }).__editor
    e.chain().focus().command(({ tr, state }) => { tr.insert(state.doc.content.size, state.schema.nodes.paragraph!.create()); return true }).run()
    e.commands.focus('end')
  })
  await body(page).focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('/' + query)
  await expect(page.locator('.slash-menu .ds-menu-item').first()).toBeVisible()
  await page.keyboard.press('Enter')
}

const BLOCKS: { id: string; query: string; type: string; check?: (n: Json) => boolean }[] = [
  { id: 'h1', query: 'h1', type: 'heading', check: n => n.attrs?.level === 1 },
  { id: 'bullet', query: 'bullet', type: 'bulletList' },
  { id: 'ordered', query: 'ordered', type: 'orderedList' },
  { id: 'task', query: 'todo', type: 'taskList' },
  { id: 'quote', query: 'quote', type: 'blockquote' },
  { id: 'code', query: 'code', type: 'codeBlock' },
  { id: 'table', query: 'table', type: 'table' },
  { id: 'callout', query: 'callout', type: 'callout', check: n => n.attrs?.icon === 'bulb' },
  { id: 'toggle', query: 'toggle', type: 'toggle' },
  { id: 'columns2', query: 'two', type: 'layoutGroup', check: n => n.content?.length === 2 },
  { id: 'columns3', query: 'three', type: 'layoutGroup', check: n => n.content?.length === 3 },
  { id: 'math', query: 'latex', type: 'mathBlock' },
  { id: 'mermaid', query: 'mermaid', type: 'mermaid' },
  { id: 'drawing', query: 'excalidraw', type: 'drawing' },
  { id: 'imageUrl', query: 'url', type: 'image', check: n => n.attrs?.src === '' && n.attrs?.blob === '' },
]

test('every block can be inserted from the slash menu; they render, persist and come back after a reload', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await expect(body(page)).toBeVisible()
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor)
  for (const b of BLOCKS) {
    await slash(page, b.query)
    if (b.id === 'math') { await page.locator('.math-field').fill('x'); await page.keyboard.press('Enter') }
    if (b.id === 'mermaid') { await expect(page.locator('.mermaid-src')).toBeVisible(); await page.keyboard.press('Control+Enter') }
    const found = find(await docJson(page), b.type)
    expect(found.length, `${b.id} was not inserted`).toBeGreaterThan(0)
    if (b.check) expect(found.some(b.check), `${b.id}: wrong attrs ${JSON.stringify(found.map(f => f.attrs))}`).toBe(true)
  }
  // inline math and the page link
  await slash(page, 'inline')
  await page.locator('.math-field').fill('x'); await page.keyboard.press('Enter')
  expect(find(await docJson(page), 'mathInline').length).toBe(1)

  // rendering, per block
  await expect(body(page).locator('.callout .callout-ic svg')).toHaveCount(1)
  await expect(body(page).locator('.toggle .toggle-btn')).toHaveCount(1)
  await expect(body(page).locator('.layout-group')).toHaveCount(2)
  await expect(body(page).locator('.layout-column')).toHaveCount(5)
  await expect(body(page).locator('.image-placeholder')).toHaveCount(1)
  await expect(body(page).locator('.code-wrap .code-lang-btn')).toBeVisible()
  await expect(body(page).locator('.drawing-block button.dr-edit')).toHaveCount(1)

  // a formula: double-click, type LaTeX, Ctrl+Enter: KaTeX renders it and it is stored
  await body(page).locator('.math-block').click() // an empty one opens at once
  await page.locator('.math-field').fill('x^2 + \\frac{a}{b}')
  await page.keyboard.press('Enter')
  await expect(body(page).locator('.math-block .katex')).toBeVisible()
  expect(find(await docJson(page), 'mathBlock')[0]!.attrs!.latex).toBe('x^2 + \\frac{a}{b}')

  // a diagram: Mermaid renders SVG under securityLevel strict
  await body(page).locator('.mermaid-view').click()
  await page.locator('.mermaid-src').fill('graph TD\n  A[شروع] --> B[پایان]')
  await page.keyboard.press('Control+Enter')
  await expect(body(page).locator('.mermaid-block svg')).toBeVisible({ timeout: 30_000 })

  // a drawing: the editor opens full-screen (Excalidraw from our own origin), save stores a scene string
  await body(page).locator('.drawing-block').hover()
  await page.getByTestId('drawing-edit').click()
  await expect(page.locator('.drawing-modal .excalidraw')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('drawing-save').click()
  await expect(page.locator('.drawing-modal')).toHaveCount(0)
  // SV 3: the scene is an attachment (no 256 KB limit); the inline `scene` is emptied
  await expect.poll(async () => String(find(await docJson(page), 'drawing')[0]!.attrs!.sceneBlob)).toMatch(/^[0-9a-f]{64}$/)
  expect(find(await docJson(page), 'drawing')[0]!.attrs!.scene).toBe('')

  // code: choose a language, type code: highlighted
  await body(page).locator('.code-wrap pre').click()
  await page.keyboard.type('const x = 1')
  await body(page).locator('.code-lang-btn').click()
  await page.locator('.lang-search').fill('javascript')
  await page.locator('.lang-search').press('Enter')
  await expect(body(page).locator('.code-wrap .hljs-keyword')).toBeVisible()
  expect(find(await docJson(page), 'codeBlock')[0]!.attrs!.language, 'the chosen language is in the document').toBe('javascript')

  const before = (await docJson(page)).content!.map(c => c.type)
  // nothing may still be waiting in the 300 ms save window, and everything must have been sent: asked of the workspace itself (the header is drawn once a second)
  await expect.poll(async () => page.evaluate(async () => { const st = await (window as unknown as { __ws: { status: () => Promise<{ outbox: number; unsaved: number }> } }).__ws.status(); return st.outbox === 0 && st.unsaved === 0 }), { timeout: 30_000 }).toBe(true)
  await page.reload()
  await reopenWorkspace(page)
  await page.getByTestId('page-row').first().dblclick()
  await expect(body(page).locator('.math-block .katex')).toBeVisible({ timeout: 15_000 })
  expect((await docJson(page)).content!.map(c => c.type)).toEqual(before)
  expect(find(await docJson(page), 'mathBlock')[0]!.attrs!.latex).toBe('x^2 + \\frac{a}{b}')
  expect(find(await docJson(page), 'codeBlock')[0]!.attrs!.language).toBe('javascript')
})

test('the reference block grip appears next to a block on hover', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-all-blocks')
  await expect(body(page).locator('.callout')).toBeVisible({ timeout: 30_000 })
  await body(page).locator('.callout').hover()
  await expect(page.locator('.ds-grip[data-show=true]')).toBeVisible()
})

test('dragging a block with its handle moves it; the new order is saved and survives a reload', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor)
  await page.evaluate(() => (window as unknown as { __editor: { commands: { setContent: (c: unknown) => void } } }).__editor.commands.setContent({
    type: 'doc', content: ['اول', 'دوم', 'سوم'].map(t => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
  }))
  const order = async () => (await docJson(page)).content!.map(n => n.content?.[0]?.text ?? '')
  expect(await order()).toEqual(['اول', 'دوم', 'سوم'])
  const first = body(page).locator('p', { hasText: 'اول' }), last = body(page).locator('p', { hasText: 'سوم' })
  await first.hover()
  const handle = page.locator('.ds-grip[data-show=true]')
  await expect(handle).toBeVisible()
  const h = (await handle.boundingBox())!, l = (await last.boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(l.x + l.width / 2, l.y + l.height * 0.9, { steps: 12 })
  await page.mouse.up()
  await expect.poll(order, { timeout: 5000 }).toEqual(['دوم', 'سوم', 'اول'])
  await expect.poll(async () => page.evaluate(async () => { const st = await (window as unknown as { __ws: { status: () => Promise<{ outbox: number; unsaved: number }> } }).__ws.status(); return st.outbox === 0 && st.unsaved === 0 }), { timeout: 30_000 }).toBe(true)
  await page.reload()
  await reopenWorkspace(page)
  await page.getByTestId('page-row').first().dblclick()
  await expect(body(page)).toContainText('اول')
  expect(await order()).toEqual(['دوم', 'سوم', 'اول'])
})

test('/ typed AFTER text on the same line: the slash text goes, the line stays, the block comes after it, and nothing throws', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor)
  await body(page).click()
  await page.keyboard.type('متن /callout')
  await expect(page.locator('.slash-menu .ds-menu-item').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(body(page).locator('.callout')).toBeVisible()
  const doc = await docJson(page)
  expect(doc.content!.map(n => n.type)).toEqual(['paragraph', 'callout', ...(doc.content!.length > 2 ? ['paragraph'] : [])].slice(0, doc.content!.length))
  expect(doc.content![0]!.content![0]!.text).toBe('متن ') // the line keeps its text; "/callout" is gone
  expect(JSON.stringify(doc)).not.toContain('/callout')
  expect(errors).toEqual([])
  // and in the middle of a table cell: the block is added after the cell's line, the table keeps its shape
  await slash(page, 'table')
  const before = find(await docJson(page), 'tableCell').length
  await body(page).locator('td').first().click()
  await page.keyboard.type('x /toggle')
  await expect(page.locator('.slash-menu .ds-menu-item').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(body(page).locator('td .toggle')).toBeVisible()
  expect(find(await docJson(page), 'tableCell').length).toBe(before)
  expect(errors).toEqual([])
})
