import { Node } from '@tiptap/core'

export const DeckComponentNode = Node.create({
  name: 'deckComponent',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  addAttributes() {
    return {
      componentId: { default: 'callout', parseHTML: (element) => element.getAttribute('data-deck-component') },
      variant: { default: 'regular', parseHTML: (element) => element.getAttribute('data-variant') },
    }
  },
  parseHTML: () => [{ tag: 'aside[data-deck-component]' }],
  renderHTML({ node }) {
    const rawId = node.attrs.componentId
    const id = typeof rawId === 'string' && /^[a-z\d-]{1,36}$/i.test(rawId) ? rawId : 'callout'
    const variant = node.attrs.variant === 'compact' ? 'compact' : 'regular'
    return ['aside', { 'data-deck-component': id, 'data-variant': variant, class: 'deck-component', style: `--component-line: var(--deck-component-${id}, var(--ds-line))` }, 0]
  },
})
