import { expect, test, type Page } from '@playwright/test'
import { createNew, appReady } from './shell-helpers'

// ROADMAP M10 in the real app: the index in a Worker, the three ways to write «می‌خواهم», two digit systems, ي/ی, backlinks that follow a
// rename, the graph, the task list, and a rebuild when the stored index was made under another NORM_VERSION.
const pw = 'correct horse battery'
test.setTimeout(180_000)

type Ws = { search: { search: (q: string, n?: number) => Promise<{ id: string }[]>; ready: boolean; rebuilt: boolean; save: () => Promise<void> }; data: { pages: { id: string; title: string }[] }; ws: string }
const W = (p: Page) => p
const hits = (page: Page, q: string) => page.evaluate(async q => ((await (window as unknown as { __ws: Ws }).__ws.search.search(q, 20)).length), q)
const body = (page: Page) => page.getByTestId('editor').locator('.ProseMirror')

async function start(page: Page) {
  const name = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await page.goto('/')
  await page.getByRole('button', { name: 'حساب ندارم' }).click()
  await page.locator('input[name=username]').fill(name)
  await page.locator('input[name=password]').fill(pw)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await appReady(page)
}
async function newPage(page: Page, title: string, text: string) {
  const before = await page.evaluate(() => location.hash)
  await createNew(page, 'new-page')
  await page.waitForFunction(h => location.hash !== h && location.hash.startsWith('#/page/'), before) // the NEW page is open
  await expect(body(page)).toBeVisible()
  await expect(page.getByTestId('title')).toHaveValue('')
  await page.getByTestId('title').fill(title)
  await page.waitForTimeout(700) // the title is written after a short pause
  await body(page).click()
  await page.keyboard.type(text)
}
const idOf = (page: Page, title: string) => page.evaluate(t => (window as unknown as { __ws: Ws }).__ws.data.pages.find(p => p.title === t)!.id, title)

test('search finds every spelling, both digit systems and ي/ی; links, backlinks after a rename, graph, tasks; rebuild on another NORM_VERSION', async ({ page }) => {
  await start(page)
  await newPage(page, 'برنامه', 'من می‌خواهم کتاب بخوانم. سال ۱۴۰۳ يك روز')
  await newPage(page, 'Notes', 'میخواهم بروم. year 1403')
  await newPage(page, 'یادداشت', 'من می خواهم بنویسم')
  for (const q of ['میخواهم', 'می خواهم', 'می‌خواهم']) await expect.poll(() => hits(page, q), { timeout: 30_000, message: q }).toBeGreaterThan(0)
  await expect.poll(() => hits(page, '۱۴۰۳')).toBe(2)
  expect(await hits(page, '1403')).toBe(2)
  expect(await hits(page, 'يك')).toBe(await hits(page, 'یک'))
  expect(await hits(page, 'يك')).toBe(1)
  expect(await hits(page, 'zzzzqq')).toBe(0)

  await expect.poll(() => hits(page, 'بنویسم'), { timeout: 30_000 }).toBe(1) // typed in the last page: indexed about a second later
  // the palette uses the index (a word from a BODY, not a title)
  await page.getByTestId('nav-home').click()
  await page.keyboard.press('Control+k')
  await page.locator('.ds-command-dialog input').first().fill('بنویسم')
  await expect(page.locator('.ds-command-dialog')).toContainText('یادداشت', { timeout: 10_000 })
  await page.keyboard.press('Escape')

  // a link from «یادداشت» to «برنامه», a task, then the backlink, the rename, the graph and the task list
  const target = await idOf(page, 'برنامه')
  const source = await idOf(page, 'یادداشت')
  await page.evaluate(id => { location.hash = `#/page/${id}` }, source)
  await expect(body(page)).toBeVisible()
  await body(page).click(); await page.keyboard.press('Control+End')
  await page.evaluate(id => (window as unknown as { __editor: { commands: { insertContent: (c: unknown) => void } } }).__editor.commands.insertContent([{ type: 'pageLink', attrs: { dstId: id, label: 'برنامه' } }, { type: 'text', text: ' ' }]), target)
  await page.evaluate(() => (window as unknown as { __editor: { chain: () => { focus: () => { toggleTaskList: () => { run: () => void } } } } }).__editor.chain().focus().toggleTaskList().run())
  await page.keyboard.type('خرید نان')
  await page.getByTestId('nav-all').click()
  await page.getByTestId('page-row').filter({ hasText: 'برنامه' }).first().click().catch(() => undefined)
  await page.evaluate(id => { location.hash = `#/page/${id}` }, target)
  await expect(page.getByTestId('backlink')).toHaveText('یادداشت', { timeout: 30_000 })
  await page.getByTestId('title').fill('برنامهٔ تازه')
  await expect(page.getByTestId('backlink')).toHaveText('یادداشت') // by id: the rename changes nothing about the link
  await page.evaluate(() => { location.hash = '#/graph' })
  await expect(page.getByTestId('graph-node')).toHaveCount(2)
  await page.getByTestId('nav-tasks').click()
  await expect(page.getByTestId('task-row')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId('task-row')).toContainText('خرید نان')

  // another NORM_VERSION in the stored index: the next start rebuilds it by itself
  await page.evaluate(() => (window as unknown as { __ws: Ws }).__ws.search.save())
  const ws = await page.evaluate(() => (window as unknown as { __ws: Ws }).__ws.ws)
  await page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((ok, bad) => { const r = indexedDB.open(`nevis-${id}`); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error) })
    await new Promise<void>((ok, bad) => {
      const tx = db.transaction('meta', 'readwrite')
      const s = tx.objectStore('meta'); const g = s.get('derived_pages')
      g.onsuccess = () => { const j = JSON.parse(g.result as string); j.norm = 0; s.put(JSON.stringify(j), 'derived_pages') }
      tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error)
    })
    db.close()
  }, ws)
  await page.reload()
  await page.getByTestId('ws-list').getByRole('button').first().click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ws: Ws }).__ws.search.rebuilt)).toBe(true)
  await expect.poll(() => hits(page, 'میخواهم'), { timeout: 30_000 }).toBeGreaterThan(0)
  W(page)
})
