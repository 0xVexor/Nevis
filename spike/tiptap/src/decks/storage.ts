import type { DocNode } from '../docNode.ts'
import type { Deck, DeckComponent } from './model.ts'

const FORMAT = 2

// Keep slide bodies in the content tree so vault link and asset scans can reach them.
export function encodeDeck(deck: Deck): DocNode {
  return {
    type: 'nevisDeck',
    attrs: { format: FORMAT, ...deck.size, ...(deck.accent === undefined ? {} : { accent: deck.accent }), ...(deck.components === undefined ? {} : { components: deck.components }) },
    content: deck.slides.map((slide) => ({ type: 'deckSlide', attrs: { id: slide.id }, content: [slide.content] })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function decodeDeck(content: unknown): Deck | null {
  if (!isRecord(content) || content.type !== 'nevisDeck' || !isRecord(content.attrs) || !Array.isArray(content.content) || !content.content.length) return null
  const { format, width, height, accent, components } = content.attrs
  if ((format !== 1 && format !== FORMAT) || !isDimension(width) || !isDimension(height)) return null
  if (accent !== undefined && (typeof accent !== 'string' || !/^#[a-f\d]{6}$/i.test(accent))) return null
  if (components !== undefined && !validComponents(components)) return null

  const seen = new Set<string>()
  const slides = []
  for (const entry of content.content) {
    if (!isRecord(entry) || entry.type !== 'deckSlide' || !isRecord(entry.attrs) || !Array.isArray(entry.content) || entry.content.length !== 1) return null
    const { id } = entry.attrs
    const [body] = entry.content
    if (typeof id !== 'string' || !id || seen.has(id) || !isRecord(body) || body.type !== 'doc') return null
    seen.add(id)
    slides.push({ id, content: body as Record<string, unknown> & DocNode })
  }
  return { size: { width, height }, slides, ...(accent === undefined ? {} : { accent }), ...(components === undefined ? {} : { components }) }
}

function validComponents(value: unknown): value is DeckComponent[] {
  if (!Array.isArray(value) || value.length > 50) return false
  const ids = new Set(['callout'])
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !/^[a-f\d-]{36}$/i.test(item.id) ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 80 ||
      typeof item.emphasis !== 'boolean'
    )
      return false
    ids.add(item.id)
  }
  return true
}
