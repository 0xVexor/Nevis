import type { DocNode } from '../docNode'
import type { Deck } from './model'
import { deckStyle } from './model'

export async function printDeck(title: string, deck: Deck, render: (content: DocNode) => string) {
  if (document.querySelector('.deck-print')) return
  const print = document.createElement('section')
  print.className = 'deck-print'
  const { width, height } = deck.size
  // Use a conventional physical page height and retain the deck's exact aspect ratio.
  const pageHeight = 8
  const pageWidth = (pageHeight * width) / height
  const rule = document.createElement('style')
  rule.textContent = `@page { size: ${pageWidth}in ${pageHeight}in; margin: 0 } .deck-print-slide { inline-size: ${pageWidth}in; block-size: ${pageHeight}in; }`
  for (const slide of deck.slides) {
    const page = document.createElement('article')
    page.className = 'deck-print-slide deck-slide-content tiptap'
    for (const [name, value] of Object.entries(deckStyle(deck, slide))) page.style.setProperty(name, value)
    page.dir = 'auto'
    page.innerHTML = render(slide.content)
    print.append(page)
  }

  const previousTitle = document.title
  const cleanup = () => {
    window.removeEventListener('afterprint', cleanup)
    print.remove()
    rule.remove()
    document.documentElement.removeAttribute('data-printing-deck')
    document.title = previousTitle
  }
  document.head.append(rule)
  document.body.append(print)
  document.documentElement.setAttribute('data-printing-deck', '')
  if (title.trim()) document.title = title
  window.addEventListener('afterprint', cleanup, { once: true })
  try {
    await document.fonts.ready
    const overflow = [...print.children].findIndex((page) => page.scrollHeight > page.clientHeight + 1 || page.scrollWidth > page.clientWidth + 1)
    if (overflow !== -1) throw new RangeError(String(overflow + 1))
    window.print()
  } catch (error) {
    cleanup()
    throw error
  }
}
