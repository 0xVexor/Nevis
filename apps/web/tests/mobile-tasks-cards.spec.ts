import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
test.skip(({ browserName }) => browserName === 'firefox', 'Firefox does not support the mobile browser context')

async function start(page: import('@playwright/test').Page, language: 'en' | 'fa') {
  await page.addInitScript(lang => localStorage.setItem('nevis.device', JSON.stringify({ lang, theme: lang === 'fa' ? 'dark' : 'light' })), language)
  await page.goto('/')
  await page.getByTestId('auth-switch').tap()
  await page.locator('input[name=username]').fill(`mobs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`)
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').tap()
  await page.getByTestId('ws-new').tap()
}

test('phone tasks preserve failed drafts, prevent duplicate submits and filter by source', async ({ page }) => {
  await start(page, 'en')
  await page.evaluate(() => { location.hash = '#/tasks' })
  const task = page.getByTestId('task-add')
  await expect(task).toBeVisible()
  await task.fill('A task with a fairly long title for a narrow screen')
  await page.evaluate(() => {
    const state = window as any
    state.__appendOriginal = state.__ws.appendTask.bind(state.__ws)
    state.__ws.appendTask = async () => { throw new Error('offline') }
  })
  await page.getByTestId('task-submit').tap()
  await expect(page.getByTestId('task-submit')).toBeEnabled()
  await expect(task).toHaveValue('A task with a fairly long title for a narrow screen')
  await page.evaluate(() => {
    const state = window as any
    state.__taskCalls = 0
    state.__ws.appendTask = async (...args: unknown[]) => {
      state.__taskCalls++
      await new Promise(resolve => setTimeout(resolve, 150))
      return state.__appendOriginal(...args)
    }
  })
  await page.getByTestId('task-submit').evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click() })
  await expect(page.getByTestId('task-row')).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).__taskCalls)).toBe(1)
  await page.getByTestId('task-sources').tap()
  await page.getByRole('menuitem', { name: 'Inbox', exact: true }).tap()
  await expect(page.getByTestId('task-row')).toHaveCount(1)
  await page.getByTestId('task-row').locator('.ds-check').tap()
  await expect(page.locator('.tk-done-toggle')).toBeVisible()
  await page.locator('.tk-done-toggle').tap()
  await expect(page.getByTestId('task-row').locator('input[type=checkbox]')).toBeChecked()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('phone review keeps card after error and handles rapid grade taps once', async ({ page }) => {
  await start(page, 'fa')
  await page.getByTestId('mobile-home-new').tap()
  await page.getByTestId('title').fill('جغرافیا')
  await expect(page.getByTestId('editor').locator('.ProseMirror')).toBeVisible()
  await page.evaluate(() => {
    const text = (value: string) => ({ type: 'paragraph', content: [{ type: 'text', text: value }] })
    const toggle = (q: string, a: string) => ({ type: 'toggle', attrs: { open: true }, content: [text(q), text(a)] })
    ;(window as any).__editor.commands.setContent({ type: 'doc', content: [toggle('پرسش اول', 'پاسخ اول'), toggle('پرسش دوم', 'پاسخ دوم')] })
  })
  await expect.poll(() => page.evaluate(() => (window as any).__ws.search.cards().length), { timeout: 30000 }).toBe(2)
  await page.evaluate(() => { location.hash = '#/cards' })
  await page.getByTestId('fc-start').tap()
  await expect(page.getByTestId('fc-question')).toHaveText('پرسش اول')
  await page.getByTestId('fc-show').tap()
  await expect(page.getByTestId('fc-answer')).toContainText('پاسخ اول')
  await expect(page.getByTestId('fc-grade-0').locator('small')).toContainText('دقیقه')
  await page.evaluate(() => {
    const state = window as any
    state.__rateOriginal = state.__ws.rateCard.bind(state.__ws)
    state.__ws.rateCard = async () => { throw new Error('offline') }
  })
  await page.getByTestId('fc-grade-2').tap()
  await expect(page.getByTestId('fc-grade-2')).toBeEnabled()
  await expect(page.getByTestId('fc-question')).toHaveText('پرسش اول')
  await page.evaluate(() => {
    const state = window as any
    state.__rates = 0
    state.__ws.rateCard = async (...args: unknown[]) => {
      state.__rates++
      await new Promise(resolve => setTimeout(resolve, 150))
      return state.__rateOriginal(...args)
    }
  })
  await page.getByTestId('fc-grade-2').evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click() })
  await expect(page.getByTestId('fc-question')).toHaveText('پرسش دوم')
  expect(await page.evaluate(() => (window as any).__rates)).toBe(1)
  await page.getByTestId('fc-show').tap()
  await page.getByTestId('fc-grade-2').tap()
  await expect(page.getByTestId('fc-done')).toBeVisible()
  await page.getByRole('button', { name: 'بازگشت به دسته‌ها' }).tap()
  await expect(page.getByTestId('fc-due')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('task rows use the correct page and ordinal when index order differs', async ({ page }) => {
  await start(page, 'en')
  const createTaskPage = async (title: string, taskText: string) => {
    await page.evaluate(() => { location.hash = '#/home' })
    await page.getByTestId('mobile-home-new').tap()
    await page.getByTestId('title').fill(title)
    await expect(page.getByTestId('editor').locator('.ProseMirror')).toBeVisible()
    await page.evaluate(text => {
      const paragraph = (value: string) => ({ type: 'paragraph', content: value ? [{ type: 'text', text: value }] : [] })
      ;(window as any).__editor.commands.setContent({ type: 'doc', content: [{ type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph('')] },
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph(text)] },
      ] }] })
    }, taskText)
    const id = page.url().split('/').pop()!
    await expect.poll(() => page.evaluate(text => (window as any).__ws.search.tasks().some((item: any) => item.task.text === text), taskText), { timeout: 30000 }).toBe(true)
    return id
  }
  const first = await createTaskPage('First page', 'First task')
  const second = await createTaskPage('Second page', 'Second task')
  await page.evaluate(({ first, second }) => {
    const search = (window as any).__ws.search
    const original = search.tasks.bind(search)
    search.tasks = () => {
      const tasks = original()
      return [...tasks.filter((task: any) => task.page === second), ...tasks.filter((task: any) => task.page === first), ...tasks.filter((task: any) => task.page !== first && task.page !== second)]
    }
    location.hash = '#/tasks'
  }, { first, second })
  await expect(page.getByTestId('task-row')).toHaveCount(2)
  await page.getByTestId('task-row').filter({ hasText: 'Second task' }).locator('.ds-check').tap()
  await page.evaluate(id => { location.hash = '#/page/' + id }, second)
  await expect(page.getByTestId('editor').locator('li[data-checked="true"]')).toHaveCount(1)
  await expect(page.getByTestId('editor').locator('li[data-checked="true"]')).toContainText('Second task')
  await expect(page.getByTestId('editor').locator('li[data-checked="false"]')).toHaveCount(1)
  await page.evaluate(id => { location.hash = '#/page/' + id }, first)
  await expect(page.getByTestId('editor').locator('li[data-checked="true"]')).toHaveCount(0)
  await expect(page.getByTestId('editor')).toContainText('First task')
})
