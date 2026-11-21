// Code blocks with syntax highlighting (lowlight) and a language picker. The schema's `codeBlock` (language: string) is the same node;
// this extension only adds the highlighting plugin and a node view.
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import type { NodeViewRendererProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { common, createLowlight } from 'lowlight'
import { codeLanguage } from '@nevis/schema'

export const lowlight = createLowlight(common)
export const LANGS: [string, string][] = [
  ['', 'متن ساده'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python'], ['java', 'Java'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['go', 'Go'], ['rust', 'Rust'],
  ['kotlin', 'Kotlin'], ['swift', 'Swift'], ['php', 'PHP'], ['ruby', 'Ruby'], ['sql', 'SQL'], ['bash', 'Bash'], ['json', 'JSON'], ['xml', 'HTML / XML'], ['css', 'CSS'], ['yaml', 'YAML'], ['markdown', 'Markdown'], ['diff', 'Diff'],
]

export const CodeBlock = CodeBlockLowlight.extend({
  addAttributes: () => ({ language: codeLanguage }), // the schema's own definition: a non-null string, parsed from class="language-x"
  addNodeView() {
    return ({ node, editor, getPos }: NodeViewRendererProps) => {
      let cur = node
      const dom = document.createElement('div')
      dom.className = 'code-block'
      const sel = document.createElement('select')
      sel.className = 'code-lang'; sel.contentEditable = 'false'; sel.setAttribute('aria-label', 'زبان'); sel.setAttribute('dir', 'ltr')
      for (const [v, label] of LANGS) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.append(o) }
      const set = () => { const known = LANGS.some(([v]) => v === cur.attrs.language); if (!known && cur.attrs.language) { const o = document.createElement('option'); o.value = String(cur.attrs.language); o.textContent = String(cur.attrs.language); sel.append(o) } sel.value = String(cur.attrs.language) }
      set()
      sel.onchange = () => { const pos = getPos(); if (pos != null && editor.isEditable) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, language: sel.value })) }
      sel.onmousedown = e => e.stopPropagation()
      const pre = document.createElement('pre')
      pre.setAttribute('dir', 'ltr')
      const code = document.createElement('code')
      pre.append(code)
      dom.append(sel, pre)
      const textAlign = (n: PMNode) => { dom.style.textAlign = String(n.attrs.textAlign || '') }
      textAlign(node)
      return {
        dom, contentDOM: code,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; set(); textAlign(n); return true },
        stopEvent: (e: Event) => e.target === sel,
        ignoreMutation: (m: { target: Node }) => m.target === sel || sel.contains(m.target),
      }
    }
  },
}).configure({ lowlight, defaultLanguage: null })
