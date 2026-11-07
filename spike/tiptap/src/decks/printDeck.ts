import { SLIDES_ENABLED, requireSlides } from '../releaseFeatures'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '../db'
import type { Deck } from './model'
import { deckStyle, slideTheme } from './model'
import { prepareSlideMedia, renderSlide } from './slideRendering'

let cleanupPrevious: (() => void) | undefined
let preparing = false

export const deckPdfAvailable = () => SLIDES_ENABLED && isTauri ? invoke<boolean>('deck_pdf_available') : Promise.resolve(false)

export async function printDeck(title: string, deck: Deck, save = false): Promise<string | null> {
  requireSlides()
  if (preparing) throw new Error('Deck print is already in progress')
  preparing = true
  cleanupPrevious?.()
  const print = document.createElement('section')
  print.className = 'deck-print'
  const { width, height } = deck.size
  // Use a conventional physical page height and retain the deck's exact aspect ratio.
  const pageHeight = 8
  const pageWidth = (pageHeight * width) / height
  const rule = document.createElement('style')
  // WebKit fits to the exact paper width, but its rounded page height can spill a
  // nominal-height slide onto a second sheet.
  rule.textContent = `@page { size: ${pageWidth}in ${pageHeight}in; margin: 0 } .deck-print-slide { inline-size: ${pageWidth}in; block-size: calc(${pageHeight}in - 2px); }`
  const previousTitle = document.title
  const cleanup = () => {
    cleanupPrevious = undefined
    window.removeEventListener('afterprint', cleanup)
    print.remove()
    rule.remove()
    document.documentElement.removeAttribute('data-printing-deck')
    document.title = previousTitle
  }
  cleanupPrevious = cleanup
  try {
    for (const slide of deck.slides) {
      const page = document.createElement('article')
      page.className = 'deck-print-slide deck-slide-content tiptap'
      for (const [name, value] of Object.entries(deckStyle(deck, slide))) page.style.setProperty(name, value)
      page.dir = 'auto'
      page.innerHTML = renderSlide(slide.content)
      await prepareSlideMedia(page, slideTheme(deck, slide).endsWith('-dark'))
      print.append(page)
    }
    document.head.append(rule)
    document.body.append(print)
    await document.fonts.ready
    const overflow = [...print.children].findIndex((page) => page.scrollHeight > page.clientHeight + 1 || page.scrollWidth > page.clientWidth + 1)
    if (overflow !== -1) throw new RangeError(String(overflow + 1))
    document.documentElement.setAttribute('data-printing-deck', '')
    if (title.trim()) document.title = title
    window.addEventListener('afterprint', cleanup, { once: true })
    if (isTauri) {
      const direct = await deckPdfAvailable()
      const file = await invoke<string | null>('print_deck', { title, width: pageWidth * 72, height: pageHeight * 72, save, pages: deck.slides.length })
      if (direct) cleanup()
      return file
    }
    if (save) throw new Error('Direct deck export is unavailable')
    window.print()
    return null
  } catch (error) {
    cleanup()
    throw error
  } finally {
    preparing = false
  }
}
