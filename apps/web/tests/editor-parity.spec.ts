import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'
import type { Workspace } from '../src/workspace'
import { createNew, reopenWorkspace } from './shell-helpers'

type W = { __editor: Editor; __ws: Workspace }
const body = (page: Page) => page.getByTestId('editor').locator('.ProseMirror')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
test.setTimeout(90_000)
const errors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
  const found: string[] = []; errors.set(page, found)
  page.on('pageerror', error => found.push(error.message))
})
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]) })

async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem('nevis.device', JSON.stringify({ lang: 'en', theme: 'light' })))
  await page.goto('/')
  await page.getByTestId('auth-switch').click()
  await page.locator('input[name=username]').fill(`ui${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`)
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await createNew(page, 'new-page')
  await expect(body(page)).toBeVisible()
}
async function slash(page: Page, query: string) {
  await body(page).click()
  await page.keyboard.type('/' + query)
  await expect(page.locator('.slash-menu .ds-menu-item').first()).toBeVisible()
  await page.keyboard.press('Enter')
}
const json = (page: Page) => page.evaluate(() => (window as unknown as W).__editor.getJSON())

test('marker shortcut converts a block and follows its remapping', async ({ page }) => {
  await start(page)
  await body(page).click()
  await page.keyboard.type('##')
  await page.keyboard.press('Tab')
  await expect(body(page).locator('h2')).toHaveCount(1)
  await page.evaluate(async () => { const path = '/src/deviceSettings.ts'; const settings = await import(path); settings.updateSettings({ shortcuts: { 'study:Turn a typed marker (#, -, 1., >, [], ```, ---) into a block': ['Alt', 'T'] } }) })
  await page.evaluate(() => (window as unknown as W).__editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '###' }] }] }))
  await page.evaluate(() => (window as unknown as W).__editor.commands.focus('end'))
  await page.keyboard.press('Alt+t')
  await expect(body(page).locator('h3')).toHaveCount(1)
  await page.evaluate(() => { const editor = (window as unknown as W).__editor; editor.commands.setContent({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'code' }] }] }); editor.commands.focus('end') })
  await page.keyboard.press('Tab')
  expect(await body(page).locator('pre').textContent()).toBe('code    ')
  await page.evaluate(() => { const editor = (window as unknown as W).__editor; editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] }); editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() })
  const before = await page.evaluate(() => (window as unknown as W).__editor.state.selection.from)
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => (window as unknown as W).__editor.state.selection.from)).toBeGreaterThan(before)
})

test('reference slash menu has groups, icons, preview and keyboard controls; the toolbar opens it without writing a slash', async ({ page }) => {
  await start(page)
  await body(page).click()
  await page.keyboard.type('/')
  await expect(page.locator('.slash-menu')).toBeVisible()
  await expect(page.locator('.slash-menu .ds-menu-head', { hasText: 'Lists' })).toBeVisible()
  await expect(page.locator('.slash-menu .ds-menu-foot')).toContainText('Navigate')
  await expect(page.locator('.slash-preview svg')).toBeVisible()
  expect(await page.locator('.slash-menu .ds-menu-ic svg').count()).toBeGreaterThan(10)
  await page.keyboard.type('h1')
  await expect(page.locator('.slash-menu .ds-menu-item')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(body(page).locator('h1')).toHaveCount(1)
  await page.keyboard.type('A heading')
  const before = await json(page)
  await page.locator('.toolbar .tb-btn--primary').click()
  await expect(page.locator('.slash-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await json(page)).toEqual(before)
})

test('column controls resize using the keyboard, preserve text and persist scalar widths after reopening', async ({ page }) => {
  await start(page)
  await slash(page, 'two')
  await expect(body(page).locator('.layout-columns > .layout-column')).toHaveCount(2)
  await body(page).locator('.layout-column').nth(0).locator('p').fill('First column')
  await body(page).locator('.layout-column').nth(1).locator('p').fill('Second column')
  const slider = page.getByRole('slider', { name: 'Resize columns 1 and 2' })
  await slider.focus()
  await slider.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuenow', '51')
  const doc = await json(page)
  const group = doc.content!.find(n => n.type === 'layoutGroup')!
  expect(group.content!.map(c => 'attrs' in c ? c.attrs?.width : undefined)).toEqual([51000, 49000])
  await page.getByTestId('nav-home').click()
  await page.getByTestId('page-row').first().dblclick()
  await expect(body(page)).toContainText('Second column')
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuenow', '51')
  await page.reload()
  await reopenWorkspace(page)
  await expect(body(page)).toContainText('First column')
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuenow', '51')
})

test('block grip uses the reference move menu, creates columns and offers an accessible destination picker', async ({ page }) => {
  await start(page)
  await page.evaluate(() => (window as unknown as W).__editor.commands.setContent({ type: 'doc', content: ['First', 'Second', 'Third'].map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) }))
  await body(page).locator('p').first().hover()
  const grip = page.locator('.ds-grip[data-show=true]')
  await expect(grip).toBeVisible()
  await grip.click()
  await page.getByRole('menuitem', { name: /^Move right/ }).click()
  await expect(body(page).locator('.layout-column')).toHaveCount(2)
  await body(page).locator('p', { hasText: 'Third' }).hover()
  await grip.click()
  await page.getByRole('menuitem', { name: /^Move to…/ }).click()
  await expect(page.locator('.layout-snap-picker')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.locator('.layout-snap-choice')).not.toBeEmpty()
  await page.keyboard.press('Escape')
  await expect(page.locator('.layout-snap-picker')).toBeHidden()
  await expect(body(page)).toContainText('Third')
  await body(page).click()
  await page.keyboard.press(`${mod}+z`)
  await expect(body(page).locator('.layout-column')).toHaveCount(0)
  await expect(body(page)).toContainText('First')
  await expect(body(page)).toContainText('Second')
})

test('table toolbar, editor context menu and formula live preview use the reference controls', async ({ page }) => {
  await start(page)
  await slash(page, 'table')
  await body(page).locator('th p').first().click()
  const tools = page.locator('.table-bubble')
  await expect(tools).toBeVisible()
  await tools.getByRole('button', { name: 'Insert row below', exact: true }).click()
  await expect(body(page).locator('tr')).toHaveCount(4)
  await body(page).locator('th p').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: /^Find in page/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem', { name: /^Find in page/ })).toHaveCount(0)
  await page.evaluate(() => { const e = (window as unknown as W).__editor; e.commands.focus('end'); e.chain().insertContentAt(e.state.doc.content.size, { type: 'paragraph' }).focus('end').run() })
  await page.keyboard.type('/latex')
  await page.locator('.slash-menu').getByRole('menuitem', { name: /Formula \(block\)/ }).click()
  await expect(page.locator('.math-field')).toBeVisible()
  await page.locator('.math-field').fill('x^2')
  await expect(page.locator('.math-live .katex')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(body(page).locator('.math-block .katex')).toBeVisible()
})

test.describe('startup animation', () => {
  test.use({ reducedMotion: 'no-preference' })
  test('draws the logo in the saved theme and removes the overlay when ready', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nevis.device', JSON.stringify({ theme: 'dark' })))
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#splash svg')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('#splash')).toHaveCount(0, { timeout: 10_000 })
    expect(await page.evaluate(() => document.documentElement.style.background)).toBe('')
    await expect(page.getByTestId('auth-submit')).toBeVisible()
  })
  test('respects the app preference to reduce motion', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nevis.device', JSON.stringify({ reduceMotion: true })))
    await page.goto('/')
    await expect(page.locator('#splash')).toHaveCount(0)
    await expect(page.getByTestId('auth-submit')).toBeVisible()
  })
})

test('table borders resize in RTL and LTR, survive reopening, undo and reset by double-click', async ({ page }) => {
  await start(page)
  await slash(page, 'table')
  const table = body(page).locator('table')
  const widths = () => table.locator('tr').first().locator('th, td').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().width)))
  for (const dir of ['rtl', 'ltr']) {
    await page.evaluate(direction => {
      const editor = (window as unknown as W).__editor
      let pos = 0
      editor.state.doc.descendants((node, at) => { if (node.type.name === 'table') pos = at })
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...editor.state.doc.nodeAt(pos)!.attrs, dir: direction }))
    }, dir)
    const before = await widths()
    const first = (await table.locator('tr').first().locator('th, td').first().boundingBox())!
    const x = dir === 'rtl' ? first.x : first.x + first.width
    await page.mouse.move(x, first.y + first.height / 2)
    await expect(body(page)).toHaveClass(/resize-cursor/)
    await page.mouse.down()
    await page.mouse.move(x + (dir === 'rtl' ? -45 : 45), first.y + first.height / 2, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await widths())[0]! - before[0]!).toBeGreaterThan(30)
    const after = await widths()
    expect(Math.abs(after.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0))).toBeLessThan(4)
    await page.evaluate(() => (window as unknown as W).__editor.commands.undo())
    await expect.poll(widths).toEqual(before)
    await page.evaluate(() => (window as unknown as W).__editor.commands.redo())
    await expect.poll(widths).toEqual(after)
    const source = await json(page)
    expect(JSON.stringify(source)).toContain('colwidthJson')
    const href = page.url()
    await page.getByTestId('nav-home').click()
    await page.goto(href)
    await expect(table).toBeVisible()
    await expect.poll(widths).toEqual(after)
    const box = (await table.locator('tr').first().locator('th, td').first().boundingBox())!
    await page.mouse.dblclick(dir === 'rtl' ? box.x : box.x + box.width, box.y + box.height / 2)
    await expect.poll(async () => JSON.stringify(await json(page))).not.toContain('colwidthJson":"[')
  }
})

test('images resize once to the selected percentage, align and open the reference zoom viewer; task boxes remain usable', async ({ page }) => {
  await start(page)
  await page.evaluate(async () => {
    const { __ws: ws, __editor: editor } = window as unknown as W
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), c => c.charCodeAt(0))
    const ref = await ws.rt.attachments.add(new Blob([bytes], { type: 'image/png' }), 'pixel.png', 'image/png')
    editor.commands.setContent({ type: 'doc', content: [
      { type: 'image', attrs: { blob: ref.blob, mime: 'image/png', alt: 'Test picture', width: 100 } },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A task' }] }] }] },
    ] })
  })
  const img = body(page).locator('.img-fig img')
  await expect(img).toBeVisible()
  await img.click()
  await page.getByRole('toolbar', { name: 'Image', exact: true }).getByRole('button', { name: 'Width 50%' }).click()
  const frame = body(page).locator('.img-fig')
  await expect.poll(async () => {
    const [picture, figure] = await Promise.all([img.boundingBox(), frame.boundingBox()])
    return Math.abs(picture!.width - figure!.width)
  }).toBeLessThan(2)
  const editorWidth = (await body(page).boundingBox())!.width
  expect((await frame.boundingBox())!.width / editorWidth).toBeCloseTo(.5, 1)
  await page.getByRole('toolbar', { name: 'Image', exact: true }).getByRole('button', { name: 'Center', exact: true }).click()
  await expect(frame).toHaveAttribute('data-align', 'center')
  await img.dblclick()
  await expect(page.locator('.lightbox:modal')).toBeVisible()
  await expect(page.locator('.image-bubble')).toBeHidden()
  await page.locator('.lightbox img').click()
  await expect(page.locator('.lightbox')).toBeVisible()
  await page.keyboard.press('Escape')
  const checkbox = body(page).locator('input[type=checkbox]')
  await expect(checkbox).toHaveCSS('appearance', 'none')
  await checkbox.check()
  await expect(checkbox).toBeChecked()
  await expect(checkbox).toHaveCSS('background-image', /data:image\/svg/)
  await expect(body(page).locator('li[data-checked=true]')).toContainText('A task')
})

test('the image URL command uses the shared dialog and validates addresses before inserting', async ({ page }) => {
  await start(page)
  await slash(page, 'url')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox').fill('javascript:alert(1)')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toContainText('This address is not allowed')
  await dialog.getByRole('button', { name: 'OK', exact: true }).click()
  expect(JSON.stringify(await json(page))).not.toContain('"type":"image"')
  await slash(page, 'url')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('sidebar keeps each panel visibility independently and closes an expanded icon rail only outside its controls', async ({ page }) => {
  await start(page)
  const aside = page.locator('#workspace-context')
  await expect(aside).toBeVisible()
  await page.getByTestId('panel-toggle').click()
  await expect(aside).toBeHidden()
  await page.getByTestId('nav-tasks').click()
  await expect(aside).toBeVisible()
  await page.getByTestId('nav-home').click()
  await expect(aside).toBeHidden()
  await page.reload()
  await reopenWorkspace(page)
  await expect(aside).toBeHidden()
  await page.getByTestId('nav-settings').click()
  await expect(aside).toBeVisible()
  const rail = page.locator('nav.side')
  await rail.getByRole('button', { name: 'Pin sidebar', exact: true }).click()
  await expect(rail).toHaveAttribute('data-expanded', '')
  await page.getByTestId('new-menu').click()
  await expect(page.getByTestId('new-page')).toBeVisible()
  await expect(rail).toHaveAttribute('data-expanded', '')
  await page.keyboard.press('Escape')
  await page.locator('.main .topbar').click({ position: { x: 100, y: 15 } })
  await expect(rail).not.toHaveAttribute('data-expanded', '')
})

test('either outside table edge resizes its nearest column in LTR and RTL', async ({ page }) => {
  await start(page)
  await slash(page, 'table')
  const table = body(page).locator('table')
  for (const dir of ['ltr', 'rtl']) {
    for (const side of ['left', 'right']) {
      await page.evaluate(direction => {
        const editor = (window as unknown as W).__editor
        const tableNode = editor.state.doc.firstChild!
        const tr = editor.state.tr.setNodeMarkup(0, undefined, { ...tableNode.attrs, dir: direction, tableWidth: 75, tableAlign: 'center' })
        tableNode.descendants((node, pos) => {
          if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') tr.setNodeMarkup(pos + 1, undefined, { ...node.attrs, colwidthJson: '' })
        })
        editor.view.dispatch(tr)
      }, dir)
      const before = (await table.boundingBox())!
      const x = side === 'left' ? before.x + 1 : before.x + before.width - 1
      const y = before.y + before.height / 2
      await page.mouse.move(x, y)
      await expect(body(page)).toHaveClass(/resize-cursor/)
      await page.mouse.down()
      await page.mouse.move(x + (side === 'left' ? 40 : -40), y, { steps: 5 })
      await page.mouse.up()
      await expect.poll(async () => before.width - (await table.boundingBox())!.width).toBeGreaterThan(30)
      const sized = await page.evaluate(() => {
        const cells = (window as unknown as W).__editor.state.doc.firstChild!.firstChild!
        return Array.from({ length: cells.childCount }, (_, i) => Number(JSON.parse(String(cells.child(i).attrs.colwidthJson))[0]))
      })
      const nearest = (side === 'left') === (dir === 'ltr') ? 0 : sized.length - 1
      expect(sized[nearest]).toBeLessThan(Math.max(...sized) - 30)
    }
  }
})

test('clicking a pending page link creates the page and saves the resolved link', async ({ page }) => {
  await start(page)
  const source = page.url()
  await body(page).click()
  await page.keyboard.type('[[Second note]]')
  const link = body(page).getByRole('link', { name: 'Second note' })
  await expect(link).toHaveClass(/missing/)
  await link.click()
  await expect(page.getByTestId('title')).toHaveValue('Second note')
  expect(page.url()).not.toBe(source)
  const target = page.url()
  await page.goto(source)
  await expect(link).not.toHaveClass(/missing/)
  await link.click()
  await expect(page).toHaveURL(target)
  await expect(page.getByTestId('page-row').filter({ hasText: 'Second note' })).toHaveCount(1)
})

test('table cells can be selected by dragging and a paragraph follows the last table', async ({ page }) => {
  await start(page)
  await slash(page, 'table')
  const table = body(page).locator('table')
  const cells = table.locator('th, td')
  const a = (await cells.nth(0).boundingBox())!
  const b = (await cells.nth(4).boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(table.locator('.selectedCell')).toHaveCount(4)
  await expect(page.locator('.table-bubble').getByRole('button', { name: 'Merge cells' })).toBeEnabled()
  await expect.poll(async () => new Set(await table.locator('.selectedCell').evaluateAll(cells => cells.map(cell => getComputedStyle(cell).backgroundColor))).size).toBe(1)
  await cells.first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Table', exact: true }).hover()
  await expect(page.getByRole('menuitem', { name: 'Merge cells', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(body(page).locator(':scope > p').last()).toBeVisible()
  await body(page).locator(':scope > p').last().click()
  await page.keyboard.type('Below the table')
  await expect(body(page).locator(':scope > p').last()).toHaveText('Below the table')
})
