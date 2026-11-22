import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'
import { expect, test, type Page } from '@playwright/test'
import { appReady, createNew, reopenWorkspace } from './shell-helpers'
import type { Workspace } from '../src/workspace'

type W = { __ws: Workspace }
test.setTimeout(90_000)
const errors = new WeakMap<Page, string[]>()
const navigating = new WeakSet<Page>()
test.beforeEach(async ({ page }) => {
  const found: string[] = []; errors.set(page, found)
  page.on('pageerror', error => {
    // WebKit reports a native access-control error when navigation cancels this same-origin long poll.
    if (navigating.has(page) && /^\/localhost:\d+\/v1\/ws\/[\da-f-]+\/ops\?after=\d+&limit=1&wait=25 due to access control checks\.$/.test(error.message)) return
    found.push(error.message)
  })
})
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]) })

async function start(page: Page) {
  await page.goto('/')
  await page.getByTestId('auth-switch').click()
  await page.locator('input[name=username]').fill(`actions${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`)
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('recovery')).toBeVisible()
  await page.getByTestId('ws-new').click()
  await appReady(page)
  await createNew(page, 'new-page')
  await expect(page.locator('.ProseMirror')).toBeVisible()
  return page.url().split('/').pop()!
}
async function menu(page: Page, id: string, action: string) {
  await page.getByTestId('page-row').and(page.locator(`[data-id="${id}"]`)).click({ button: 'right' })
  await page.getByTestId(action).click()
}
async function reopen(page: Page) {
  navigating.add(page)
  try {
    await page.reload()
    await reopenWorkspace(page)
    await appReady(page)
  } finally { navigating.delete(page) }
}

test('tree rename updates the open title and breadcrumb, cancels cleanly and survives reload', async ({ page }) => {
  const id = await start(page)
  await page.getByTestId('title').fill('عنوان اولیه')
  await expect(page.getByTestId('page-row')).toContainText('عنوان اولیه')
  await menu(page, id, 'menu-rename')
  await page.getByRole('dialog').locator('input').fill('لغو شود')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('title')).toHaveValue('عنوان اولیه')
  await menu(page, id, 'menu-rename')
  await page.getByRole('dialog').locator('input').fill('نام تازه')
  await page.getByRole('dialog').getByRole('button', { name: 'ذخیره', exact: true }).click()
  await expect(page.getByTestId('title')).toHaveValue('نام تازه')
  await expect(page.locator('.crumb-t')).toHaveText('نام تازه')
  await reopen(page)
  await expect(page.getByTestId('title')).toHaveValue('نام تازه')
})

test('duplicate keeps content and metadata, and leaves the source editable and independently saved', async ({ page }) => {
  const id = await start(page)
  await page.getByTestId('title').fill('صفحه اصلی')
  await page.locator('.ProseMirror').fill('متن مشترک')
  await page.evaluate(async id => {
    const ws = (window as unknown as W).__ws
    await ws.setMeta(id, { icon: 'i:star', status: 'doing' })
    await ws.tagPageByName(id, 'پروژه', true)
  }, id)
  await menu(page, id, 'menu-duplicate')
  await expect(page.getByTestId('title')).toHaveValue(/صفحه اصلی.*کپی/)
  const copyId = page.url().split('/').pop()!
  expect(copyId).not.toBe(id)
  await expect(page.locator('.ProseMirror')).toContainText('متن مشترک')
  expect(await page.evaluate(id => {
    const ws = (window as unknown as W).__ws
    const p = ws.data.pages.find(p => p.id === id)!
    return { icon: p.icon, status: p.status, tags: ws.data.pageTags.get(id)?.length }
  }, copyId)).toEqual({ icon: 'i:star', status: 'doing', tags: 1 })
  await page.getByTestId('page-row').and(page.locator(`[data-id="${id}"]`)).dblclick()
  await expect(page.getByTestId('title')).toHaveValue('صفحه اصلی')
  await expect(page).toHaveURL(new RegExp(`${id}$`))
  await page.locator('.ProseMirror').fill('ویرایش مستقل منبع')
  await page.getByTestId('page-row').and(page.locator(`[data-id="${copyId}"]`)).dblclick()
  await expect(page).toHaveURL(new RegExp(`${copyId}$`))
  await expect(page.getByTestId('title')).toHaveValue(/کپی/)
  await expect(page.locator('.ProseMirror')).toContainText('متن مشترک')
  await page.getByTestId('page-row').and(page.locator(`[data-id="${id}"]`)).dblclick()
  await expect(page.locator('.ProseMirror')).toContainText('ویرایش مستقل منبع')
  await reopen(page)
  await expect(page.locator('.ProseMirror')).toContainText('ویرایش مستقل منبع')
})

test('move picker excludes the source and descendants, moves a subtree and returns it to the root', async ({ page }) => {
  const id = await start(page)
  const { child, target } = await page.evaluate(async id => {
    const ws = (window as unknown as W).__ws
    await ws.rename(id, 'والد')
    return { child: await ws.newPage(id, 'فرزند'), target: await ws.newPage('', 'مقصد') }
  }, id)
  await menu(page, id, 'menu-move')
  await expect(page.getByTestId('move-destination').and(page.locator(`[data-id="${id}"]`))).toHaveCount(0)
  await expect(page.getByTestId('move-destination').and(page.locator(`[data-id="${child}"]`))).toHaveCount(0)
  await page.getByTestId('move-destination').and(page.locator(`[data-id="${target}"]`)).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => page.evaluate(id => (window as unknown as W).__ws.data.pages.find(p => p.id === id)?.parent, id)).toBe(target)
  await reopen(page)
  await expect(page.getByTestId('page-row').and(page.locator(`[data-id="${id}"]`))).toBeVisible()
  await menu(page, id, 'menu-move-root')
  await expect.poll(() => page.evaluate(id => (window as unknown as W).__ws.data.pages.find(p => p.id === id)?.parent, id)).toBe('')
  expect(await page.evaluate(child => (window as unknown as W).__ws.data.pages.find(p => p.id === child)?.parent, child)).toBe(id)
})

test('header Markdown exports include the latest edits and workspace export contains other pages', async ({ page }) => {
  await start(page)
  await page.getByTestId('title').fill('آخرین عنوان')
  await page.locator('.ProseMirror').fill('آخرین متن ذخیره شود')
  await page.locator('.share-btn').click()
  const single = page.waitForEvent('download')
  await page.getByTestId('share-markdown').click()
  const md = await single
  const text = await readFile((await md.path())!, 'utf8')
  expect(text).toContain('آخرین عنوان')
  expect(text).toContain('آخرین متن ذخیره شود')
  await page.evaluate(async () => { await (window as unknown as W).__ws.newPage('', 'صفحه دوم') })
  await page.locator('.share-btn').click()
  const all = page.waitForEvent('download')
  await page.getByTestId('share-workspace').click()
  const zip = unzipSync(await readFile((await (await all).path())!))
  const files = Object.entries(zip).filter(([name]) => name.endsWith('.md')).map(([, data]) => strFromU8(data))
  expect(files).toHaveLength(2)
  expect(files.join('\n')).toContain('صفحه دوم')
  expect(files.join('\n')).toContain('آخرین متن ذخیره شود')
})

test('new menu opens templates and creates a board whose duplicate stays a board', async ({ page }) => {
  await start(page)
  await page.getByTestId('nav-templates').click()
  await expect(page).toHaveURL(/#\/templates$/)
  await page.getByTestId('new-menu').click()
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board')).toBeVisible()
  const id = page.url().split('/').pop()!
  await menu(page, id, 'menu-duplicate')
  await expect(page).not.toHaveURL(new RegExp(`${id}$`))
  await expect(page.getByTestId('board')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as W).__ws.isBoard(location.hash.split('/').pop()!))).toBe(true)
})

test('folders stay folders, accept moved pages and open their contents in Files', async ({ page }) => {
  const id = await start(page)
  await page.getByTestId('title').fill('یادداشت داخل پوشه')
  await page.getByTestId('new-menu').click()
  await page.getByTestId('new-folder').click()
  await page.getByRole('dialog').locator('input').fill('پوشهٔ پروژه')
  await page.getByRole('dialog').locator('input').press('Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__ws.data.pages.find(p => p.title === 'پوشهٔ پروژه')?.id)).toBeTruthy()
  const folder = await page.evaluate(() => (window as unknown as W).__ws.data.pages.find(p => p.title === 'پوشهٔ پروژه')!.id)
  await expect.poll(() => page.evaluate(folder => (window as unknown as W).__ws.isFolder(folder), folder)).toBe(true)
  await menu(page, id, 'menu-move')
  await page.getByTestId('move-destination').and(page.locator(`[data-id="${folder}"]`)).click()
  await page.getByTestId('nav-files').click()
  await page.locator(`.fx-item[data-id="${folder}"]`).dblclick()
  await expect(page.locator(`.fx-item[data-id="${id}"]`)).toBeVisible()
  await reopen(page)
  expect(await page.evaluate(folder => (window as unknown as W).__ws.isFolder(folder), folder)).toBe(true)
})
