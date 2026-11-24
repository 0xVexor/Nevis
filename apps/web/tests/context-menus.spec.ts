import { expect, test } from '@playwright/test'
import { appReady } from './shell-helpers'
import type { Workspace } from '../src/workspace'

test.use({ reducedMotion: 'no-preference' })

test('the template menu creates a page with the preview icon and page actions work outside the tree', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('auth-switch').click()
  await page.locator('input[name=username]').fill(`menu${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`)
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').click()
  await page.getByTestId('ws-new').click()
  await appReady(page)

  const quickNote = page.getByTestId('home-note-editor').locator('.ProseMirror')
  await quickNote.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: /افزودن بلوک/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  await page.getByTestId('nav-templates').click()
  const lecture = page.getByTestId('template-lecture')
  await lecture.click({ button: 'right' })
  const icon = await lecture.locator('svg').innerHTML()
  await expect(page.locator('.tpl-paper-icon svg')).toHaveCount(1)
  await page.getByRole('menuitem').click()
  await expect(page.getByTestId('page-icon').locator('svg')).toHaveCount(1)
  expect(await page.getByTestId('page-icon').locator('svg').innerHTML()).toBe(icon)
  const storedIcon = await page.evaluate(() => {
    const ws = (window as unknown as { __ws: Workspace }).__ws
    return ws.data.pages.find(p => location.hash.endsWith(p.id))?.icon
  })
  expect(storedIcon).toBe('i:graduation')

  await page.locator('.crumb-t').click({ button: 'right' })
  await expect(page.getByTestId('menu-copy-link')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('menu-copy-link')).toHaveCount(0)
  await page.getByTestId('nav-all').click()
  await page.getByTestId('all-pages-row').click({ button: 'right' })
  await page.getByTestId('menu-rename').click()
  await page.getByRole('dialog').locator('input').fill('Context menu renamed this')
  await page.getByRole('dialog').getByRole('button', { name: 'ذخیره', exact: true }).click()
  await expect(page.getByTestId('all-pages-row')).toContainText('Context menu renamed this')
})
