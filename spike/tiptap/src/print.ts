import { t } from './i18n'
/** Opens the browser's print dialog ("Save as PDF" is one of its printers); the tab title becomes the PDF's file name. */
export function printPage(title: string) {
  const prev = document.title
  document.title = title.trim() || t('Note')
  const restore = () => {
    document.title = prev
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)
  window.print()
}
