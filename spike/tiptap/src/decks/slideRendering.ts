import { generateHTML, getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { DocNode } from '../docNode'
import { CodeBlock, highlightCodeElement } from '../editor/codeBlock'
import { contentProblem } from '../editor/contentSafety'
import { HeadingDir } from '../editor/headingDir'
import { LayoutColumn, LayoutGroup, LayoutSafety } from '../editor/layout'
import { DeckComponentNode } from './componentNode'

export const slideExtensions = [StarterKit.configure({ codeBlock: false }), CodeBlock, HeadingDir, LayoutGroup, LayoutColumn, LayoutSafety, DeckComponentNode]
const schema = getSchema(slideExtensions)

export const slideContentProblem = (content: DocNode) => contentProblem(content, schema)

export function renderSlide(content: DocNode) {
  if (slideContentProblem(content)) throw new Error('Unsupported slide content')
  const container = document.createElement('div')
  container.innerHTML = generateHTML(content, slideExtensions)
  for (const code of container.querySelectorAll('pre > code')) highlightCodeElement(code)
  return container.innerHTML
}
