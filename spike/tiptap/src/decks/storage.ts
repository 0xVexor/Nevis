import type { DocNode } from '../docNode.ts'
import type { Deck } from './model.ts'

const FORMAT = 1

// Keep slide bodies in the content tree so vault link and asset scans can reach them.
export function encodeDeck(deck: Deck): DocNode {
  return {
    type: 'nevisDeck',
    attrs: { format: FORMAT, ...deck.size },
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
  const { format, width, height } = content.attrs
  if (format !== FORMAT || !isDimension(width) || !isDimension(height)) return null

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
  return { size: { width, height }, slides }
}
