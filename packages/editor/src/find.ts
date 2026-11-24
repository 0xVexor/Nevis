// Find in the page (ported from the old find.ts): Persian-aware (ي/ك, ZWNJ, digits, diacritics), highlights every match as decorations,
// `Mod-f` opens a small bar. The query lives in the plugin state; nothing is written to the page.
import { Extension, type CommandProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { normalizeChar, normalizeFa } from './findNormalize'
import { S } from './strings'
import { optionsOf } from './options'

interface FindState { query: string; matches: { from: number; to: number }[]; index: number }
const findKey = new PluginKey<FindState>('findInPage')
const EMPTY: FindState = { query: '', matches: [], index: 0 }

/** What the page's find has now: the query, every match and which one is current. */
export const getFind = (editor: { state: import('@tiptap/pm/state').EditorState }): FindState => findKey.getState(editor.state) ?? EMPTY
/** Scrolls the current match into view. */
export function scrollToMatch(editor: { state: import('@tiptap/pm/state').EditorState; view: import('@tiptap/pm/view').EditorView }) {
  const m = getFind(editor).matches[getFind(editor).index]
  if (m) editor.view.domAtPos(m.from).node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** Every match of `query` in every text block. Normalized per character so offsets map 1:1 back to document positions. */
export function search(doc: PMNode, query: string): { from: number; to: number }[] {
  const q = normalizeFa(query).trim()
  if (!q) return []
  const out: { from: number; to: number }[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let norm = ''
    const at: number[] = []
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      if (child.isText) {
        const s = child.text ?? ''
        for (let i = 0; i < s.length; i++) for (const ch of normalizeChar(s[i]!)) { norm += ch; at.push(start + i) }
      } else { norm += '￼'; at.push(start) } // an inline atom (math, page link): never matches
    })
    for (let i = norm.indexOf(q); i >= 0; i = norm.indexOf(q, i + q.length)) out.push({ from: at[i]!, to: at[i + q.length - 1]! + 1 })
    return false
  })
  return out
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> { findInPage: { setFindQuery: (q: string) => ReturnType; findNext: (step?: 1 | -1) => ReturnType } }
}

export const FindInPage = Extension.create({
  name: 'findInPage',
  addCommands() {
    return {
      setFindQuery: (q: string) => ({ tr, dispatch }: CommandProps) => { dispatch?.(tr.setMeta(findKey, { query: q })); return true },
      findNext: (step: 1 | -1 = 1) => ({ tr, dispatch }: CommandProps) => { dispatch?.(tr.setMeta(findKey, { step })); return true },
    }
  },
  addKeyboardShortcuts() { return { 'Mod-f': () => { if (optionsOf(this.editor).ownFindBar) return false; this.editor.view.dom.dispatchEvent(new CustomEvent('nevis:find-open', { bubbles: true })); return true } } },
  addProseMirrorPlugins() {
    return [new Plugin<FindState>({
      key: findKey,
      state: {
        init: () => EMPTY,
        apply(tr, prev) {
          const m = tr.getMeta(findKey) as { query?: string; step?: 1 | -1 } | undefined
          const query = m?.query ?? prev.query
          if (!m && !tr.docChanged) return prev
          const matches = search(tr.doc, query)
          let index = m?.query !== undefined ? 0 : Math.min(prev.index, Math.max(0, matches.length - 1))
          if (m?.step && matches.length) index = (index + m.step + matches.length) % matches.length
          return { query, matches, index }
        },
      },
      props: {
        decorations(state) {
          const s = findKey.getState(state)
          if (!s?.matches.length) return null
          return DecorationSet.create(state.doc, s.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === s.index ? 'find-match current' : 'find-match' })))
        },
      },
      view: view => {
        const editor = this.editor
        // the little bar: created on first use
        let bar: HTMLElement | null = null
        const open = () => {
          if (optionsOf(editor).ownFindBar) return
          if (bar) { (bar.querySelector('input') as HTMLInputElement).focus(); return }
          bar = document.createElement('div'); bar.className = 'find-bar'; bar.setAttribute('dir', 'rtl')
          const input = document.createElement('input'); input.placeholder = S.find.placeholder; input.setAttribute('dir', 'auto')
          const count = document.createElement('span'); count.className = 'find-count'
          const mk = (t: string, f: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.onclick = f; return b }
          const run = (step?: 1 | -1) => { const ed = (view as unknown as { dom: HTMLElement }).dom; void ed; if (step) view.dispatch(view.state.tr.setMeta(findKey, { step })); else view.dispatch(view.state.tr.setMeta(findKey, { query: input.value })); show() }
          const show = () => { const s = findKey.getState(view.state)!; count.textContent = s.matches.length ? S.find.count(s.index + 1, s.matches.length) : '' ; const m = s.matches[s.index]; if (m) { const c = view.coordsAtPos(m.from); const top = c.top; if (top < 80 || top > window.innerHeight - 80) view.dom.querySelector('.find-match.current')?.scrollIntoView({ block: 'center' }) } }
          input.oninput = () => run()
          input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? -1 : 1) } else if (e.key === 'Escape') close(); e.stopPropagation() }
          const close = () => { view.dispatch(view.state.tr.setMeta(findKey, { query: '' })); bar?.remove(); bar = null; view.focus() }
          bar.append(input, count, mk(S.find.prev, () => run(-1)), mk(S.find.next, () => run(1)), mk(S.find.close, close))
          document.body.append(bar); input.focus()
        }
        view.dom.addEventListener('nevis:find-open', open)
        return { destroy: () => { view.dom.removeEventListener('nevis:find-open', open); bar?.remove() } }
      },
    })]
  },
})
