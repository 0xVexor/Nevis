import test from 'node:test'
import assert from 'node:assert/strict'
import { composeFonts, LATIN_RANGE } from '../src/fontStack.ts'

const face = (id, group, stack) => ({ id, group, stack })
const estedad = face('estedad', 'persian', "'Estedad', 'Vazirmatn', 'Segoe UI', Tahoma, sans-serif")
const vazir = face('vazir', 'persian', "'Vazirmatn', 'Segoe UI', Tahoma, system-ui, sans-serif")
const inter = face('inter', 'english', "'Inter', 'Vazirmatn', 'Segoe UI', Tahoma, sans-serif")
const system = face('system', 'system', "system-ui, 'Segoe UI', Tahoma, sans-serif")
const serif = face('serif', 'system', "Georgia, 'Times New Roman', 'Vazirmatn', serif")

test('the English face always comes before the Persian one, so a Persian face never restyles English words', () => {
  assert.equal(composeFonts(estedad, undefined).sans, `'Instrument Sans', ${estedad.stack}`)
  assert.equal(composeFonts(estedad, inter).sans, `'Inter', ${estedad.stack}`)
})

test('with nothing chosen the stylesheet defaults stay in charge', () => {
  assert.deepEqual(composeFonts(vazir, undefined), { sans: null, serif: null, css: '' })
})

test('a system English face is limited to Latin letters, so the Persian face still gets every Persian word', () => {
  const { sans, css } = composeFonts(estedad, system)
  assert.ok(sans.startsWith("'Nevis Latin', 'Estedad'"))
  assert.doesNotMatch(sans.split(',')[0], /system-ui/)
  assert.match(css, /unicode-range:/)
  assert.ok(css.includes(LATIN_RANGE))
  assert.doesNotMatch(LATIN_RANGE, /0600|06FF|200C|200D/i) // no Arabic-script block, no ZWNJ
  assert.match(composeFonts(estedad, serif).css, /local\('Georgia'\)/)
})

test('a bundled English face needs no alias, and an explicit English face also covers the display serif', () => {
  assert.equal(composeFonts(estedad, inter).css, '')
  assert.equal(composeFonts(estedad, inter).serif, composeFonts(estedad, inter).sans)
  assert.equal(composeFonts(estedad, undefined).serif, `'Newsreader', ${estedad.stack}`)
})
