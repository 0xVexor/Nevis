import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

// ROADMAP M1 criterion 8: an IME composition in A while a bot types in B (remote updates every ~200 ms).
// Chrome's DevTools protocol drives a real composition (Input.imeSetComposition), the way a Persian/CJK keyboard does.
const results: Record<string, unknown> = {}

// The composed word contains "ژ", which no bot word contains: so any "ژ" left over is a stray fragment of a broken composition.
const WORD = 'ژاژ'
const steps = ['ژ', 'ژا', 'ژاژ']

const cases = [
  { name: 'queue OFF, 2.7 s composition', hold: false, stepMs: 900, holdMax: 0, clean: false },
  { name: 'queue ON (cap 2 s), 1.5 s composition', hold: true, stepMs: 500, holdMax: 0, clean: true },
  { name: 'queue ON (cap 2 s), 2.7 s composition', hold: true, stepMs: 900, holdMax: 0, clean: false },
  { name: 'queue ON (cap 10 s), 2.7 s composition', hold: true, stepMs: 900, holdMax: 10000, clean: true },
]
for (const { name, hold, stepMs, holdMax, clean } of cases) {
  test(`IME composition in A while the bot types in the SAME paragraph of B: ${name}`, async ({ page }) => {
    await page.goto(`/?botFirst=1${holdMax ? `&holdMax=${holdMax}` : ''}`)
    const holdBox = page.getByLabel('صف composition')
    if ((await holdBox.isChecked()) !== hold) await holdBox.click()
    await page.getByLabel('ربات تایپ در B').check()

    const paragraph = page.locator('[data-testid="editor-A"] .ProseMirror p').first()
    await paragraph.click()
    await page.keyboard.press('End')

    await page.evaluate(() => {
      const w = window as unknown as { __ime: { starts: number; ends: number }; __demo: { editors: { A: { view: { dom: HTMLElement } } } } }
      w.__ime = { starts: 0, ends: 0 }
      const dom = w.__demo.editors.A.view.dom
      dom.addEventListener('compositionstart', () => w.__ime.starts++)
      dom.addEventListener('compositionend', () => w.__ime.ends++)
    })

    const cdp = await page.context().newCDPSession(page)
    for (const text of steps) {
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
      await page.waitForTimeout(stepMs) // remote updates from the bot arrive during every step
    }
    const during = await page.evaluate(() => {
      const w = window as unknown as { __ime: { starts: number; ends: number }; __demo: { editors: { A: { view: { composing: boolean } } } } }
      return { ...w.__ime, composing: w.__demo.editors.A.view.composing }
    })
    await cdp.send('Input.insertText', { text: WORD }) // commit
    await page.waitForTimeout(400)
    await page.getByLabel('ربات تایپ در B').uncheck()
    await expect(page.getByTestId('converged')).toHaveAttribute('data-ok', 'true', { timeout: 10000 })
    const after = await paragraph.innerText()
    const strays = (after.match(/ژ/g) ?? []).length

    const r = { name, hold, stepMs, holdMax, after, committedOnce: (after.match(new RegExp(WORD, 'g')) ?? []).length, zheCount: strays, endedBeforeCommit: during.ends, startedBeforeCommit: during.starts, stillComposingBeforeCommit: during.composing }
    results[name] = r
    mkdirSync('results', { recursive: true })
    writeFileSync('results/ime.json', JSON.stringify(results, null, 2))
    console.log(JSON.stringify(r))

    if (clean) {
      expect(strays, 'exactly the committed word, no stray fragment').toBe(2)
      expect(after).toContain(WORD)
      expect(during.ends, 'the composition was cut short by a remote update').toBe(0)
      expect(during.composing).toBe(true)
      expect(await page.getByTestId('proj-A').innerText()).toEqual(await page.getByTestId('proj-B').innerText())
    }
  })
}

test('B receives what A committed and both converge once the bot stops', async ({ page }) => {
  await page.goto('/')
  const paragraph = page.locator('[data-testid="editor-A"] .ProseMirror p').first()
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' کلمهٔ-آزمون')
  await expect(page.getByTestId('converged')).toHaveAttribute('data-ok', 'true', { timeout: 5000 })
  await expect(page.locator('[data-testid="editor-B"] .ProseMirror p').first()).toContainText('کلمهٔ-آزمون')
})

test('offline: type on both sides, reconnect, converge; direction and table survive', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('A آفلاین').check()
  await page.getByLabel('B آفلاین').check()
  const a = page.locator('[data-testid="editor-A"] .ProseMirror p').first()
  const b = page.locator('[data-testid="editor-B"] .ProseMirror p').nth(1)
  await a.click(); await page.keyboard.press('End'); await page.keyboard.type(' ALPHA')
  await b.click(); await page.keyboard.press('End'); await page.keyboard.type(' بتا')
  await page.locator('[data-side="A"] button', { hasText: 'rtl' }).click()
  await page.locator('[data-side="B"] button', { hasText: 'جدول' }).click()
  await expect(page.getByTestId('converged')).toHaveAttribute('data-ok', 'false')
  await page.getByLabel('A آفلاین').uncheck()
  await page.getByLabel('B آفلاین').uncheck()
  await expect(page.getByTestId('converged')).toHaveAttribute('data-ok', 'true', { timeout: 8000 })
  const text = await page.getByTestId('proj-A').innerText()
  expect(text).toContain('ALPHA')
  expect(text).toContain('بتا')
  expect(text).toContain('"type": "table"')
  expect(await page.getByTestId('proj-A').innerText()).toEqual(await page.getByTestId('proj-B').innerText())
})
