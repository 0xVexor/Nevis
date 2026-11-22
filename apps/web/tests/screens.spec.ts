import { expect, test } from '@playwright/test'
import { createNew, appReady } from './shell-helpers'

const pw = 'correct horse battery'
async function signUpAndOpen(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(`s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await appReady(page)
}

// The screens the old app has beyond the page itself (inbox tasks, lists, files, drawings, databases, find in page, the toolbar), in the real app.
test.setTimeout(120_000)
const body = (p: import('@playwright/test').Page) => p.getByTestId('editor').locator('.ProseMirror')

test('Tasks: a task typed into the inbox shows at once, can be ticked, and survives a reload; a new list is a page', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('nav-tasks').click()
  await page.getByTestId('task-add').fill('خرید نان')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('task-row')).toContainText('خرید نان', { timeout: 15_000 })
  await page.getByTestId('task-row').locator('.ds-check').first().click()
  await expect(page.locator('.tk-done-toggle .ds-badge')).toHaveText('۱', { timeout: 15_000 }) // a ticked task moves to Completed
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('nav-tasks').click()
  await expect(page.locator('.tk-done-toggle .ds-badge')).toHaveText('۱', { timeout: 15_000 }) // still done after the reload
  // the inbox is a page the tree does not show; a new list is one it does
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('page-row')).toHaveCount(0)
  await page.getByTestId('nav-tasks').click()
  await page.getByTestId('new-list').click()
  await expect(page.getByTestId('title')).toBeVisible()
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('page-row')).toHaveCount(1)
})

test('Files, Drawings and Databases open in the old frames and act on the real pages', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await page.getByTestId('title').fill('برگه')
  await page.waitForTimeout(700)
  await page.getByTestId('nav-files').click()
  await expect(page.getByTestId('files')).toContainText('برگه')
  await page.getByTestId('nav-drawings').click()
  await expect(page.getByTestId('drawings')).toBeVisible()
  await page.getByTestId('nav-databases').click()
  await expect(page.getByTestId('databases')).toBeVisible()
  await createNew(page, 'new-database')
  await expect(page.getByTestId('db-view')).toBeVisible()
  await page.getByTestId('nav-databases').click()
  await expect(page.getByTestId('databases')).toContainText('پایگاه')
})

test('find in page (Ctrl+F) highlights every match and steps through them; the toolbar bolds the selection', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-page')
  await body(page).click()
  await page.keyboard.type('سلام دنیا. سلام دوباره. وداع')
  await page.keyboard.press('Control+f')
  await expect(page.getByTestId('find')).toBeVisible()
  await page.getByTestId('find').locator('input').fill('سلام')
  await expect(page.getByTestId('find')).toContainText('1 از 2')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('find')).toContainText('2 از 2')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('find')).toHaveCount(0)
  await body(page).click()
  await page.evaluate(() => (window as unknown as { __editor: { commands: { selectAll: () => void } } }).__editor.commands.selectAll())
  await page.getByRole('toolbar').getByRole('button', { name: /^درشت/ }).click()
  await expect(body(page).locator('strong, b').first()).toBeVisible()
})

test('a small drawing is shown at its own size, not stretched to the page width', async ({ page }) => {
  await signUpAndOpen(page)
  const scene = JSON.stringify({ type: 'excalidraw', version: 2, source: 'nevis', elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 160, height: 90, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, roughness: 1, opacity: 100, seed: 1, version: 1, versionNonce: 1, isDeleted: false, groupIds: [], boundElements: null, updated: 1, link: null, locked: false, roundness: null, frameId: null }], appState: { viewBackgroundColor: '#ffffff' }, files: {} })
  await page.evaluate(async s => {
    const ws = (window as unknown as { __ws: { newTemplatePage: (t: string, c: unknown) => Promise<string> } }).__ws
    const id = await ws.newTemplatePage('نقاشی', { type: 'doc', content: [{ type: 'drawing', attrs: { scene: s } }] }); location.hash = '#/page/' + id
  }, scene)
  const svg = page.locator('.drawing-block svg').first()
  await expect(svg).toBeVisible({ timeout: 60_000 })
  const box = (await svg.boundingBox())!
  expect(box.width).toBeLessThan(400) // the picture is 160 x 90 plus its margin; stretched it would be as wide as the page (about 820)
  expect(box.height).toBeLessThan(300)
})

test('database: the column header opens its menu (sort, hide, delete) and the filter panel narrows the rows', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-database')
  for (const name of ['الف', 'ب', 'ج']) { await page.getByTestId('db-add-row').click(); await expect(page.getByTestId('db-row')).toHaveCount(['الف', 'ب', 'ج'].indexOf(name) + 1) }
  const names = ['سیب', 'موز', 'سیر']
  for (let i = 0; i < 3; i++) { await page.locator(`[data-testid=cell][data-prop="نام"][data-row="${i}"] input`).fill(names[i]!); await page.locator(`[data-testid=cell][data-prop="نام"][data-row="${i}"] input`).blur() }
  await page.getByTestId('col-head').first().click()
  await page.getByRole('menuitem', { name: /نزولی/ }).click()
  await expect(page.locator('.dv-conditions')).toContainText('نزولی')
  await page.getByTestId('chip-filter').click()
  await page.getByTestId('add-rule').click()
  await page.getByTestId('rule-value').fill('سی')
  await expect(page.getByTestId('db-row')).toHaveCount(2) // سیب and سیر
})

test('the Drawings list shows the picture of each drawing, not an empty pencil', async ({ page }) => {
  await signUpAndOpen(page)
  const scene = JSON.stringify({ type: 'excalidraw', version: 2, source: 'nevis', elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 160, height: 90, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, roughness: 1, opacity: 100, seed: 1, version: 1, versionNonce: 1, isDeleted: false, groupIds: [], boundElements: null, updated: 1, link: null, locked: false, roundness: null, frameId: null }], appState: { viewBackgroundColor: '#ffffff' }, files: {} })
  await page.evaluate(async s => {
    const ws = (window as unknown as { __ws: { newTemplatePage: (t: string, c: unknown) => Promise<string> } }).__ws
    const id = await ws.newTemplatePage('نقاشی من', { type: 'doc', content: [{ type: 'drawing', attrs: { scene: s } }] }); location.hash = '#/page/' + id // the page takes its template when it is opened
  }, scene)
  await expect(page.locator('.drawing-block svg').first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ws: { search: { drawings: () => unknown[] } } }).__ws.search.drawings().length), { timeout: 30_000 }).toBeGreaterThan(0) // saved, then indexed
  await page.getByTestId('nav-drawings').click()
  await expect(page.locator('.dr-pic svg').first()).toBeVisible({ timeout: 60_000 })
  // the picture sits whole inside its box (never larger than it, never cropped)
  const fits = await page.locator('.dr-pic').first().evaluate(el => { const box = el.parentElement!.getBoundingClientRect(), svg = el.querySelector('svg')!.getBoundingClientRect(); return svg.width <= box.width && svg.height <= box.height && svg.top >= box.top && svg.bottom <= box.bottom + 1 })
  expect(fits).toBe(true)
})

test('Home: ticking a task there ticks it in its page; the trash says when a page was deleted and never promises to delete by itself', async ({ page }) => {
  await signUpAndOpen(page)
  const id = await page.evaluate(async () => {
    const ws = (window as unknown as { __ws: { newPage: (p: string, t: string) => Promise<string>; writeBody: (id: string, j: unknown) => Promise<void> } }).__ws
    const id = await ws.newPage('', 'برنامه')
    await ws.writeBody(id, { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'شستن ظرف' }] }] }] }] })
    return id
  })
  await page.evaluate(i => { location.hash = '#/page/' + i }, id) // opening the page gives its blocks their ids
  await expect(body(page)).toContainText('شستن ظرف')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ws: { search: { tasks: () => unknown[] } } }).__ws.search.tasks().length), { timeout: 30_000 }).toBe(1)
  await page.getByTestId('nav-tasks').click(); await page.getByTestId('nav-home').click()
  await page.getByTestId('home').locator('.ds-check').first().click()
  await page.getByTestId('nav-tasks').click()
  await expect(page.locator('.tk-done-toggle .ds-badge')).toHaveText('۱', { timeout: 15_000 }) // it is in the page, not only on Home
  // the trash
  await page.evaluate(async i => { await (window as unknown as { __ws: { trash: (id: string) => Promise<void> } }).__ws.trash(i) }, id)
  await page.getByTestId('trash-toggle').click()
  await expect(page.getByTestId('trash')).toContainText('حذف‌شده')
  await expect(page.getByTestId('trash')).not.toContainText('روز')
})

test('database: a row opens as a page with its properties and a body of its own that survives a reload', async ({ page }) => {
  await signUpAndOpen(page)
  await createNew(page, 'new-database')
  await page.getByTestId('db-add-row').click()
  await expect(page.getByTestId('db-row')).toHaveCount(1)
  await page.locator('[data-testid=cell][data-prop="نام"][data-row="0"] input').fill('کتاب اول')
  await page.locator('[data-testid=cell][data-prop="نام"][data-row="0"] input').blur()
  await page.getByTestId('row-open').first().click({ force: true })
  await expect(page.getByTestId('row-title')).toHaveValue('کتاب اول')
  await page.getByTestId('row-editor').locator('.ProseMirror').click()
  await page.keyboard.type('خلاصهٔ کتاب')
  await expect.poll(() => page.evaluate(async () => { const st = await (window as unknown as { __ws: { status: () => Promise<{ outbox: number; unsaved: number }> } }).__ws.status(); return st.outbox === 0 && st.unsaved === 0 }), { timeout: 30_000 }).toBe(true) // written, then reload
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await expect(page.getByTestId('row-title')).toHaveValue('کتاب اول', { timeout: 15_000 })
  await expect(page.getByTestId('row-editor')).toContainText('خلاصهٔ کتاب', { timeout: 15_000 })
  await page.getByTestId('row-back').click()
  await expect(page.getByTestId('db-view')).toBeVisible()
})

test('a new board opens as a whole-page drawing (not a text page), saves by itself, and comes back after a reload with its picture in the list', async ({ page }) => {
  await signUpAndOpen(page)
  await page.getByTestId('nav-drawings').click()
  await page.getByRole('button', { name: /بوم جدید/ }).first().click()
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(page.locator('.excalidraw')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('editor')).toHaveCount(0) // not a text page
  await page.getByTestId('board-title').fill('طرح من')
  // draw a rectangle with our own tool bar
  await page.getByRole('toolbar').getByRole('button', { name: /مستطیل/ }).click()
  const stage = (await page.locator('.board-stage').boundingBox())!
  await page.mouse.move(stage.x + 320, stage.y + 280); await page.mouse.down(); await page.mouse.move(stage.x + 540, stage.y + 420, { steps: 8 }); await page.mouse.up() // clear of the style panel on the left
  await expect(page.locator('.board-save')).toHaveText(/ذخیره شد|همه تغییرات/, { timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ws: { search: { drawings: () => { drawing: { filled: boolean } }[] } } }).__ws.search.drawings().filter(d => d.drawing.filled).length), { timeout: 30_000 }).toBeGreaterThan(0) // saved, then indexed with its picture
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await page.getByTestId('nav-drawings').click()
  await expect(page.locator('.dr-pic svg').first()).toBeVisible({ timeout: 60_000 }) // the picture is in the list
  await page.locator('.dr-latest .dr-latest-board, .dr-card .dr-open').first().click()
  await expect(page.getByTestId('board-title')).toHaveValue('طرح من')
  await page.getByTestId('board-back').click()
  await expect(page.getByTestId('drawings')).toBeVisible()
})
