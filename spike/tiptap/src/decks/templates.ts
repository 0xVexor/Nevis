import type { DocNode } from '../docNode.ts'
import type { Deck, Slide } from './model.ts'

export const deckTemplates = [
  {
    id: 'deck-carousel',
    title: 'Technical carousel',
    hint: 'A portrait deck for a technical explanation.',
    size: { width: 1080, height: 1350 },
    sections: ['OpenAPI in legacy Spring', 'Follow the request', 'Register the configuration', 'Where does the bean belong?', 'Enable the docs', 'Takeaway'],
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

const text = (type: 'heading' | 'paragraph', value: string, level = 1): DocNode => ({
  type,
  ...(type === 'heading' ? { attrs: { level } } : {}),
  content: [{ type: 'text', text: value }],
})
const code = (language: string, value: string): DocNode => ({ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: value }] })
const callout = (value: string): DocNode => ({ type: 'deckComponent', attrs: { componentId: 'callout' }, content: [text('paragraph', value)] })
const columns = (...regions: DocNode[][]): DocNode => ({ type: 'layoutGroup', content: regions.map((content) => ({ type: 'layoutColumn', content })) })

function springSlides(translate: (text: string) => string): DocNode[][] {
  const p = (value: string) => text('paragraph', translate(value))
  return [
    [p('Add documentation to an existing orders API built with Spring MVC and XML.')],
    [
      p('Tomcat starts the web application. Its MVC servlet handles the request.'),
      columns([text('heading', 'Root context', 2), p('OrderService and the repository')], [text('heading', 'MVC context', 2), p('OrderController and the API documentation')]),
    ],
    [
      p('Register the documentation configuration in the servlet XML.'),
      code('xml', '<bean id="apiDocsConfiguration"\n      class="example.docs.ApiDocsConfiguration"/>'),
      callout(translate('The XML entry makes this class visible to the MVC context.')),
    ],
    [
      columns([text('heading', 'Root context', 2), p('Shared services')], [text('heading', 'MVC context', 2), p('Web configuration')]),
      p('Keep the API documentation with the controllers it describes.'),
    ],
    [p('The documentation flag is read at startup.'), code('properties', 'demo.api-docs.enabled=false'), code('bash', '-Ddemo.api-docs.enabled=true')],
    [callout(translate('Keep service wiring in the root context and register API documentation in the MVC context.'))],
  ]
}

export function deckFromTemplate(template: (typeof deckTemplates)[number], translate: (text: string) => string, createId: () => string, appearance?: Pick<Deck, 'theme' | 'accent'>): Deck {
  const carousel = template.id === 'deck-carousel'
  const example = carousel ? springSlides(translate) : undefined
  return {
    size: { ...template.size },
    ...(carousel ? { theme: 'forest-light' as const } : appearance),
    slides: template.sections.map((section, index): Slide => ({
      id: createId(),
      ...(carousel && (index === 0 || index === template.sections.length - 1) ? { tone: 'dark' as const } : {}),
      content: { type: 'doc', content: [text('heading', translate(section)), ...(example?.[index] ?? [{ type: 'paragraph' }])] },
    })),
  }
}
