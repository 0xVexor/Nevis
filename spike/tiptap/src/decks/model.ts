import type { DocNode } from '../docNode.ts'
import { syntaxColors, themeColors, type DeckTheme } from '../appearancePresets.ts'

export interface Slide {
  readonly id: string
  readonly content: DocNode
  readonly tone?: 'dark'
}

export interface Deck {
  readonly size: { readonly width: number; readonly height: number }
  readonly slides: readonly Slide[]
  readonly accent?: string
  readonly theme?: DeckTheme
  readonly components?: readonly DeckComponent[]
}

export interface DeckComponent {
  readonly id: string
  readonly name: string
  readonly emphasis: boolean
}

export const defaultDeckAccent = '#087f74'
export const calloutComponent: DeckComponent = { id: 'callout', name: 'Callout', emphasis: true }

export function deckStyle(deck: Deck, slide?: Slide): Record<string, string> {
  const theme = deck.theme ?? 'calm-light'
  const colors = themeColors(slide?.tone === 'dark' ? (theme.startsWith('forest-') ? 'forest-dark' : 'calm-dark') : theme)
  const components = Object.fromEntries([calloutComponent, ...(deck.components ?? [])].map(({ id, emphasis }) => [`--deck-component-${id}`, emphasis ? 'var(--deck-accent)' : 'var(--deck-border)']))
  return {
    '--deck-accent': deck.accent ?? colors.accent,
    '--deck-paper': colors.paper,
    '--deck-ink': colors.ink,
    '--deck-border': colors.border,
    '--deck-callout': colors.callout,
    '--deck-code-paper': colors.code.paper,
    '--deck-code-ink': colors.code.ink,
    ...syntaxColors(colors.code),
    ...components,
  }
}

export function createPortraitDeck(createId: () => string): Deck {
  return addSlide({ size: { width: 1080, height: 1350 }, slides: [] }, createId)
}

export function addSlide(deck: Deck, createId: () => string): Deck {
  const id = createId()
  if (!id || deck.slides.some((slide) => slide.id === id)) throw new Error('Slide ID must be unique within the deck')
  const slide: Slide = {
    id,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  }
  return { ...deck, slides: [...deck.slides, slide] }
}

// Address both ends by ID so edits and reorder requests can share the same targets.
export function moveSlide(deck: Deck, slideId: string, beforeId: string | null): Deck {
  const slide = deck.slides.find(({ id }) => id === slideId)
  if (!slide) throw new RangeError('Slide to move does not exist')
  if (beforeId === slideId) return deck

  const slides = deck.slides.filter(({ id }) => id !== slideId)
  const index = beforeId === null ? slides.length : slides.findIndex(({ id }) => id === beforeId)
  if (index === -1) throw new RangeError('Destination slide does not exist')
  slides.splice(index, 0, slide)
  return { ...deck, slides }
}
