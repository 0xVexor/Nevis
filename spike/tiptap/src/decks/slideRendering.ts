import { generateHTML, getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { DocNode } from '../docNode'
import { CodeBlock, highlightCodeElement } from '../editor/codeBlock'
import { contentProblem } from '../editor/contentSafety'
import { HeadingDir } from '../editor/headingDir'
import { AttImage } from '../editor/image'
import { MermaidBlock, renderDiagram } from '../editor/mermaid'
import { urlFor } from '../attachments'
import { LayoutColumn, LayoutGroup, LayoutSafety } from '../editor/layout'
import { DeckComponentNode } from './componentNode'

const SlideCode = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      slideStyle: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-slide-code-style'),
        renderHTML: (attrs: Record<string, unknown>) => attrs.slideStyle === 'compact' ? { 'data-slide-code-style': 'compact' } : {},
      },
    }
  },
})

export const slideExtensions = [StarterKit.configure({ codeBlock: false }), SlideCode, HeadingDir, LayoutGroup, LayoutColumn, LayoutSafety, DeckComponentNode, MermaidBlock, AttImage]
const schema = getSchema(slideExtensions)

export const slideContentProblem = (content: DocNode) => contentProblem(content, schema)

export function renderSlide(content: DocNode) {
  if (slideContentProblem(content)) throw new Error('Unsupported slide content')
  const container = document.createElement('div')
  container.innerHTML = generateHTML(content, slideExtensions)
  for (const code of container.querySelectorAll('pre > code')) highlightCodeElement(code)
  return container.innerHTML
}

export async function prepareSlideMedia(page: HTMLElement, dark: boolean) {
  await Promise.all([
    ...Array.from(page.querySelectorAll<HTMLElement>('[data-type="mermaid"][data-code]'), async (element) => {
      const source = element.dataset.code?.trim()
      if (!source) return
      const diagram = await renderDiagram(source, dark)
      if (!('svg' in diagram)) throw new Error('Invalid Mermaid diagram')
      const image = new Image()
      image.alt = 'Mermaid diagram'
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagram.svg)}`
      await image.decode()
      element.replaceChildren(image)
    }),
    ...Array.from(page.querySelectorAll<HTMLImageElement>('img[src]'), async (image) => {
      const source = image.getAttribute('src')!
      const url = await urlFor(source)
      if (!url) throw new Error('Slide image is unavailable')
      const width = Number(image.dataset.w)
      if (width >= 10 && width <= 100) image.style.inlineSize = `${width}%`
      image.src = url
      await image.decode()
    }),
  ])
}
