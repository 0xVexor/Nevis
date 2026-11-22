// Compare the editor controls that a whole-screen inventory misses.
// NEW=http://localhost:5184 node tools/uiparity/widgets.mjs /tmp/nevis-widgets
import { mkdirSync } from 'node:fs'
import { browser, openOld, openNew } from './lib.mjs'
import { SCREENS } from './screens.mjs'

const out = process.argv[2]
if (!out) throw new Error('Provide an output directory')
mkdirSync(out, { recursive: true })
try {
  const apps = { old: await openOld(), new: await openNew() }
  for (const [kind, { page, ids }] of Object.entries(apps)) {
    await SCREENS.page[kind](page, ids)
    await page.locator('.ProseMirror p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/')
    await page.locator('.slash-menu').waitFor()
    await page.screenshot({ path: `${out}/slash.${kind}.png` })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    for (const [name, selector] of [['two-columns', '.ProseMirror > h1'], ['three-columns', '.ProseMirror > h2']]) {
      await page.locator(selector).first().hover()
      await page.locator('.ds-grip[data-show=true]').click()
      await page.getByRole('menuitem', { name: /انتقال به راست|Move right/ }).click()
      await page.waitForTimeout(350)
      await page.locator('.layout-group').first().hover()
      await page.screenshot({ path: `${out}/${name}.${kind}.png` })
    }
  }
} finally { await browser.close() }
