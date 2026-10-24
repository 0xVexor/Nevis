import { Node } from '@tiptap/core'
import { GLYPHS } from '../iconSet'

/** The glyph as a CSS mask image, so the same icon renders from plain HTML (editor, flashcards, history) and takes any colour. */
const maskUrl = (name: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>${GLYPHS[name]?.[1] ?? ''}</svg>`)}")`

/** A small outline icon inside a sentence (from the "/" menu). Attributes: glyph name and an optional colour. */
export const InlineIcon = Node.create({
  name: 'inlineIcon',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      name: { default: 'star', parseHTML: (el: HTMLElement) => el.getAttribute('data-icon') },
      color: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-color') },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-icon]' }]
  },
  renderHTML({ node }) {
    const { name, color } = node.attrs
    return ['span', { class: 'inline-icon', 'data-icon': name, ...(color ? { 'data-color': color } : {}), style: `--ic:${maskUrl(name)};${color ? `color:${color};` : ''}` }]
  },
  renderText: () => '',
})
