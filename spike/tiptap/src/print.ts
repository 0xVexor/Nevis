import { getLang, locale, t } from './i18n'
import { drawAllDiagrams } from './editor/mermaid'

// Paper is always light: while printing, the whole app takes the light theme (every colour token, not only the few the print
// styles name), and diagrams, which carry their colours in their SVG, are drawn again in it before the print dialog opens.
let printing = false
let savedTheme: string | undefined
const takeLightTheme = () => {
  if (printing) return
  printing = true
  savedTheme = document.documentElement.dataset.theme
  document.documentElement.dataset.theme = 'light'
}
const restoreTheme = () => {
  if (!printing) return
  printing = false
  if (savedTheme === undefined) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = savedTheme
}

// The running head and foot of every sheet: the note's title and the date above, the page number below. The first sheet opens
// with the title itself, so it has no head. They live in the page's margin boxes, filled when printing starts (in the light theme,
// so the colours are its tokens) in the document's typeface; their sides and digits follow the app's language.
const quote = (text: string) => JSON.stringify(text.replace(/\s+/g, ' ').trim())
/** A token as a plain colour: the margin boxes are outside the document, where light-dark() has no colour scheme to follow. */
function tokenColour(token: string) {
  const probe = document.createElement('i')
  probe.style.cssText = `position: absolute; visibility: hidden; color-scheme: light; color: var(${token})`
  document.body.append(probe)
  const colour = getComputedStyle(probe).color
  probe.remove()
  return colour
}
function setPaperMarks(title: string) {
  const font = getComputedStyle(document.querySelector('.tiptap') ?? document.body).fontFamily
  const muted = tokenColour('--ds-text-3')
  const line = tokenColour('--ds-line')
  const rtl = getLang() === 'fa'
  const [start, end] = rtl ? ['right', 'left'] : ['left', 'right']
  const digits = rtl ? 'persian' : 'decimal'
  const date = new Date().toLocaleDateString(locale(), { year: 'numeric', month: 'long', day: 'numeric' })
  const text = `font-family: ${font}; font-size: 8.5pt; color: ${muted};`
  const head = `${text} vertical-align: bottom; margin-block-end: 6mm; padding-block-end: 2.5mm; border-block-end: 0.5pt solid ${line};`
  let style = document.getElementById('print-marks')
  if (!style) {
    style = document.createElement('style')
    style.id = 'print-marks'
    document.head.append(style)
  }
  style.textContent = `@page {
  @top-${start} { content: ${quote(title || t('Note'))}; ${head} }
  @top-${end} { content: ${quote(date)}; ${head} }
  @bottom-center { content: counter(page, ${digits}) " / " counter(pages, ${digits}); ${text} vertical-align: top; padding-block-start: 3mm; }
}
@page :first {
  @top-left { content: none; border: 0; }
  @top-right { content: none; border: 0; }
}`
}

// printing started some other way (the browser's own Ctrl+P): the theme still turns light and the marks carry the window's
// title; diagrams keep what they have
window.addEventListener('beforeprint', () => {
  if (printing) return
  takeLightTheme()
  setPaperMarks(document.title)
})
window.addEventListener('afterprint', restoreTheme)

/** Opens the browser's print dialog ("Save as PDF" is one of its printers); the tab title becomes the PDF's file name. */
export async function printPage(title: string) {
  const prev = document.title
  document.title = title.trim() || t('Note')
  takeLightTheme()
  setPaperMarks(document.title)
  try {
    await drawAllDiagrams()
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))) // let the new colours paint
  } catch {
    /* a diagram that cannot be drawn still prints as it is */
  }
  const restore = () => {
    document.title = prev
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)
  window.print()
}
