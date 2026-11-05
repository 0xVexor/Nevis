import type { DocNode } from '../docNode.ts'
import type { Deck } from './model.ts'

export const deckTemplates = [
  {
    id: 'deck-carousel',
    title: 'Technical carousel',
    hint: 'A portrait deck for a technical explanation.',
    size: { width: 1080, height: 1350 },
    sections: ['The question', 'How it works', 'Takeaway'],
  },
  { id: 'deck-lesson', title: 'Short lesson', hint: 'A widescreen deck for teaching one idea.', size: { width: 1600, height: 900 }, sections: ['Learning goal', 'Worked example', 'Try it yourself'] },
  {
    id: 'deck-brief',
    title: 'Project briefing',
    hint: 'A widescreen deck for sharing a project update.',
    size: { width: 1600, height: 900 },
    sections: ['Project overview', 'Progress', 'Next steps'],
  },
] as const

export function deckFromTemplate(template: (typeof deckTemplates)[number], translate: (text: string) => string, createId: () => string): Deck {
  return {
    size: { ...template.size },
    ...(template.id === 'deck-carousel' ? { accent: '#49621e' } : {}),
    slides: template.sections.map((section) => ({
      id: createId(),
      content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: translate(section) }] }, { type: 'paragraph' }] } satisfies DocNode,
    })),
  }
}
