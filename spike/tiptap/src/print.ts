import { t } from './i18n'
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
// printing started some other way (the browser's own Ctrl+P): the theme still turns light; diagrams keep what they have
window.addEventListener('beforeprint', takeLightTheme)
window.addEventListener('afterprint', restoreTheme)

/** Opens the browser's print dialog ("Save as PDF" is one of its printers); the tab title becomes the PDF's file name. */
export async function printPage(title: string) {
  const prev = document.title
  document.title = title.trim() || t('Note')
  takeLightTheme()
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
