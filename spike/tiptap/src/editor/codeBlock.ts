import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { TextSelection } from '@tiptap/pm/state'
import { common, createLowlight } from 'lowlight'
import { detectLanguage } from './detect'
import { looksLikeMermaid } from './mermaid'
import { t } from '../i18n'
import { svgIcon } from './svgIcons'
import { openLangMenu } from './langMenu'
import { createSectionDragSurface } from './snapSurface'

const lowlight = createLowlight(common)

/** Languages offered in the picker and the slash menu (all ship with lowlight's `common` set). */
export const LANGS: { id: string; name: string; alias: string }[] = [
  { id: 'java', name: 'Java', alias: '' },
  { id: 'python', name: 'Python', alias: 'py' },
  { id: 'javascript', name: 'JavaScript', alias: 'js node' },
  { id: 'typescript', name: 'TypeScript', alias: 'ts' },
  { id: 'c', name: 'C', alias: '' },
  { id: 'cpp', name: 'C++', alias: 'cplusplus' },
  { id: 'csharp', name: 'C#', alias: 'cs dotnet' },
  { id: 'go', name: 'Go', alias: 'golang' },
  { id: 'rust', name: 'Rust', alias: 'rs' },
  { id: 'kotlin', name: 'Kotlin', alias: 'kt' },
  { id: 'swift', name: 'Swift', alias: '' },
  { id: 'php', name: 'PHP', alias: '' },
  { id: 'ruby', name: 'Ruby', alias: 'rb' },
  { id: 'sql', name: 'SQL', alias: 'mysql postgres' },
  { id: 'bash', name: 'Bash', alias: 'sh shell terminal' },
  { id: 'json', name: 'JSON', alias: '' },
  { id: 'xml', name: 'HTML / XML', alias: 'html' },
  { id: 'css', name: 'CSS', alias: 'scss' },
  { id: 'yaml', name: 'YAML', alias: 'yml' },
  { id: 'markdown', name: 'Markdown', alias: 'md' },
  { id: 'r', name: 'R', alias: '' },
  { id: 'lua', name: 'Lua', alias: '' },
  { id: 'diff', name: 'Diff', alias: 'patch' },
  { id: 'plaintext', name: 'Plain text', alias: 'text txt' },
]
const nameOf = (id: string) => LANGS.find((l) => l.id === id)?.name ?? id

/**
 * highlight.js' own auto-detection is weak on short snippets (Java -> C#, JS -> CSS, HTML -> CSS, ...).
 * Our signature-based detector goes first; hljs is only a fallback, limited to the languages we offer
 * and only when it is reasonably sure, otherwise the block stays plain.
 */
const hljsAuto = lowlight.highlightAuto.bind(lowlight)
const SUBSET = LANGS.map((l) => l.id).filter((id) => id !== 'plaintext')
lowlight.highlightAuto = ((value: string, options?: any) => {
  const lang = detectLanguage(value)
  if (lang && lowlight.registered(lang)) return lowlight.highlight(lang, value)
  const r = hljsAuto(value, { ...options, subset: SUBSET })
  return (r.data?.relevance ?? 0) >= 8 ? r : lowlight.highlight('plaintext', value)
}) as typeof lowlight.highlightAuto

/** Maps what the user typed after ``` (e.g. "py", "html") to a picker id, or null. */
function canonLang(lang: string | null | undefined): string | null {
  if (!lang) return null
  const l = lang.toLowerCase()
  if (l === 'mermaid') return 'mermaid' // not a highlighted language, but a valid label (code that "Show as diagram" can draw)
  const hit = LANGS.find((x) => x.id === l || x.alias.split(' ').includes(l))
  return hit ? hit.id : lowlight.registered(l) ? l : null
}

// ───────────── IDE-like editing inside a code block ─────────────

const INDENT = '    '
const CLOSER: Record<string, string> = { '{': '}', '(': ')', '[': ']' }

/** [start, end) of the line containing offset `off` in `text`. */
const lineStart = (text: string, off: number) => text.lastIndexOf('\n', off - 1) + 1

/** Offsets (within the block text) of the first character of every line touched by [a, b]. */
function touchedLineStarts(text: string, a: number, b: number): number[] {
  const starts: number[] = []
  for (let p = lineStart(text, a); p <= b; ) {
    starts.push(p)
    const nl = text.indexOf('\n', p)
    if (nl < 0) break
    p = nl + 1
  }
  if (starts.length > 1 && starts[starts.length - 1] === b && b > a) starts.pop() // selection ends at a line start: that line is untouched
  return starts
}

function inCode(editor: any) {
  const { $from, $to } = editor.state.selection
  return $from.parent.type.name === 'codeBlock' && $from.sameParent($to)
}

function indent(editor: any) {
  const { state, view } = editor
  const { $from, $to } = state.selection
  const text: string = $from.parent.textContent
  const a = $from.parentOffset
  const b = $to.parentOffset
  const base = $from.start()
  let tr = state.tr
  if (!text.slice(a, b).includes('\n')) {
    const col = a - lineStart(text, a)
    tr = tr.insertText(' '.repeat(INDENT.length - (col % INDENT.length)), $from.pos, $to.pos) // jump to the next 4-column stop
  } else {
    for (const s of touchedLineStarts(text, a, b).reverse()) tr = tr.insertText(INDENT, base + s)
  }
  view.dispatch(tr.scrollIntoView())
  return true
}

function outdent(editor: any) {
  const { state, view } = editor
  const { $from, $to } = state.selection
  const text: string = $from.parent.textContent
  const base = $from.start()
  let tr = state.tr
  for (const s of touchedLineStarts(text, $from.parentOffset, $to.parentOffset).reverse()) {
    let n = 0
    if (text[s] === '\t') n = 1
    else while (n < INDENT.length && text[s + n] === ' ') n++
    if (n) tr = tr.delete(base + s, base + s + n)
  }
  view.dispatch(tr.scrollIntoView())
  return true
}

function smartEnter(editor: any) {
  const { state, view } = editor
  const { $from, $to } = state.selection
  if (!inCode(editor)) return false
  const text: string = $from.parent.textContent
  const a = $from.parentOffset
  const before = text.slice(lineStart(text, a), a)
  const lead = /^[ \t]*/.exec(before)![0]
  const trimmed = before.trimEnd()
  const last = trimmed.slice(-1)
  const lang = $from.parent.attrs.language
  const opens = last in CLOSER || ((lang === 'python' || lang === 'yaml') && last === ':')
  const next = text[$to.parentOffset]
  const from = $from.pos

  // caret between a pair like {|}: open a block and keep the closer on its own line
  if (last in CLOSER && next === CLOSER[last]) {
    const tr = state.tr.insertText(`\n${lead}${INDENT}\n${lead}`, from, $to.pos)
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1 + lead.length + INDENT.length)).scrollIntoView())
    return true
  }
  view.dispatch(state.tr.insertText('\n' + lead + (opens ? INDENT : ''), from, $to.pos).scrollIntoView())
  return true
}

function smartBackspace(editor: any) {
  const { state, view } = editor
  const { $from, empty } = state.selection
  if (!empty || !inCode(editor)) return false
  const text: string = $from.parent.textContent
  const a = $from.parentOffset
  const before = text.slice(lineStart(text, a), a)
  if (!before || !/^ +$/.test(before)) return false
  const n = Math.min(before.length, before.length % INDENT.length || INDENT.length) // back to the previous 4-column stop
  view.dispatch(state.tr.delete($from.pos - n, $from.pos))
  return true
}

export const CodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // text alignment inside the block (left / center / right), set from the bar on the block or the toolbar's align buttons
      textAlign: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.querySelector('pre') ?? el).style.textAlign || el.getAttribute('data-align') || null,
        renderHTML: (a: any) => (a.textAlign ? { 'data-align': a.textAlign } : {}),
      },
    }
  },
  addKeyboardShortcuts() {
    const parent = (this.parent?.() ?? {}) as Record<string, (ctx: any) => boolean>
    return {
      ...parent,
      Tab: ({ editor }) => inCode(editor) && indent(editor),
      'Shift-Tab': ({ editor }) => inCode(editor) && outdent(editor),
      // keep TipTap's own behaviours first (triple Enter / Backspace at the start leave the block)
      Enter: (ctx) => parent.Enter?.(ctx) || smartEnter(ctx.editor),
      Backspace: (ctx) => parent.Backspace?.(ctx) || smartBackspace(ctx.editor),
    }
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'code-wrap'
      const surface = createSectionDragSurface(t('Move code block'), t('Drag this area to move the whole block.'))

      const bar = document.createElement('div')
      bar.className = 'code-bar'
      bar.contentEditable = 'false'

      const select = document.createElement('select')
      select.className = 'code-lang'
      select.setAttribute('aria-label', t('Programming language'))
      const auto = new Option(t('Auto-detect'), '')
      select.append(auto, ...LANGS.map((l) => new Option(t(l.name), l.id)))
      select.hidden = true // the native list is replaced by the app's own dropdown below; the <select> stays as the data holder
      const trigger = document.createElement('button')
      trigger.type = 'button'
      trigger.className = 'code-lang code-lang-btn'
      trigger.setAttribute('aria-haspopup', 'listbox')
      trigger.setAttribute('aria-label', t('Programming language'))
      trigger.onmousedown = (e) => e.preventDefault()
      trigger.onclick = () => {
        if (!editor.isEditable) return
        openLangMenu(trigger, [...select.options].map((o) => ({ value: o.value, label: o.text })), select.value, (v) => {
          select.value = v
          select.onchange?.(new Event('change'))
        })
      }

      const copy = document.createElement('button')
      copy.className = 'code-copy'
      copy.type = 'button'
      copy.textContent = t('Copy')
      let destroyed = false, copyTimer = 0
      copy.onclick = async () => {
        clearTimeout(copyTimer)
        try {
          if (!navigator.clipboard) throw new Error('Clipboard unavailable')
          await navigator.clipboard.writeText(current.textContent)
          if (!destroyed) copy.textContent = t('Copied ✓')
        } catch {
          if (!destroyed) copy.textContent = t('Copy failed')
        }
        if (!destroyed) copyTimer = window.setTimeout(() => { copy.textContent = t('Copy') }, 1200)
      }
      // code that is really a diagram (language "mermaid", or Mermaid source in a block with no language): offer to draw it
      const diag = document.createElement('button')
      diag.className = 'code-copy code-diagram'
      diag.type = 'button'
      diag.hidden = true
      diag.textContent = t('Show as diagram')
      diag.onclick = () => {
        const pos = getPos()
        const mer = editor.schema.nodes.mermaid
        if (pos == null || !mer || !editor.isEditable) return
        editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + current.nodeSize, mer.create({ code: current.textContent })))
      }
      // alignment of the code text: left / center / right
      const aligns: [string, string, string][] = [['left', svgIcon.left, t('Align left')], ['center', svgIcon.center, t('Center')], ['right', svgIcon.right, t('Align right')]]
      const alignBtns = aligns.map(([a, icon, title]) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'code-copy code-al'
        b.innerHTML = icon
        b.title = title
        b.onmousedown = (e) => e.preventDefault()
        b.onclick = () => {
          const pos = getPos()
          if (pos == null || !editor.isEditable) return
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, textAlign: current.attrs.textAlign === a ? null : a }))
        }
        return b
      })
      bar.append(trigger, select, diag, ...alignBtns, copy)

      const pre = document.createElement('pre')
      const code = document.createElement('code')
      pre.append(code)
      dom.append(surface, bar, pre)

      const sync = (n: typeof node) => {
        const id = canonLang(n.attrs.language)
        if (id && ![...select.options].some((o) => o.value === id)) select.append(new Option(id, id)) // unknown but registered
        select.value = id ?? ''
        // while no language is chosen, show what the detector currently sees
        const seen = id ? null : detectLanguage(n.textContent)
        auto.text = seen ? `${t('Auto-detect')} · ${t(nameOf(seen))}` : t('Auto-detect')
        diag.hidden = !(n.attrs.language === 'mermaid' || looksLikeMermaid(n.textContent))
        trigger.innerHTML = '<span class="cl-t"></span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
        ;(trigger.querySelector('.cl-t') as HTMLElement).textContent = select.selectedOptions[0]?.text ?? ''
        pre.style.textAlign = n.attrs.textAlign ?? ''
        alignBtns.forEach((b, i) => b.classList.toggle('on', n.attrs.textAlign === aligns[i][0]))
      }
      sync(node)

      select.onchange = () => {
        const pos = getPos()
        if (pos == null || !editor.isEditable) return
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: select.value || null }))
        editor.view.focus()
      }

      return {
        dom,
        contentDOM: code,
        update: (n) => {
          if (n.type !== current.type) return false
          current = n
          sync(n)
          return true
        },
        stopEvent: (e) => bar.contains(e.target as any) || surface.contains(e.target as any),
        ignoreMutation: (m) => bar.contains(m.target) || surface.contains(m.target),
        destroy: () => { destroyed = true; clearTimeout(copyTimer) },
      }
    }
  },
}).configure({ lowlight })
