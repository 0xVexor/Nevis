import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { normalizeFa } from '../normalize'

interface FindState {
  query: string
  matches: { from: number; to: number }[]
  index: number
}

const findKey = new PluginKey<FindState>('findInPage')
const EMPTY: FindState = { query: '', matches: [], index: 0 }

/**
 * Finds `query` in every text block. Matching uses the same Persian normalisation as the page search
 * (ي/ك, ZWNJ, digits, diacritics), so «كلاس» finds «کلاس» and «می‌روم» finds «می روم».
 * Normalisation is done per character so offsets in the normalised text map 1:1 back to document positions.
 */
function search(doc: any, query: string): { from: number; to: number }[] {
  const q = normalizeFa(query).trim()
  if (!q) return []
  const out: { from: number; to: number }[] = []
  doc.descendants((node: any, pos: number) => {
    if (!node.isTextblock) return true
    let norm = ''
    const at: number[] = []
    node.forEach((child: any, offset: number) => {
      const start = pos + 1 + offset
      if (child.isText) {
        const s: string = child.text
        for (let i = 0; i < s.length; i++) {
          for (const ch of normalizeFa(s[i])) (norm += ch, at.push(start + i)) // '' for diacritics: skipped
        }
      } else (norm += '￼', at.push(start)) // inline atom (math, page link, image): can never match
    })
    for (let i = norm.indexOf(q); i >= 0; i = norm.indexOf(q, i + q.length)) out.push({ from: at[i], to: at[i + q.length - 1] + 1 })
    return false
  })
  return out
}

function scrollTo(view: any, from: number) {
  try {
    const { node } = view.domAtPos(from)
    const el: HTMLElement | null = node.nodeType === 1 ? node : node.parentElement
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch {
    /* position no longer in the DOM */
  }
}

export const FindInPage = Extension.create({
  name: 'findInPage',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(findKey)
            if (meta?.clear) return EMPTY
            if (meta?.query !== undefined) {
              const matches = search(state.doc, meta.query)
              return { query: meta.query, matches, index: 0 }
            }
            if (meta?.index !== undefined) return { ...value, index: meta.index }
            if (tr.docChanged && value.query) {
              const matches = search(state.doc, value.query)
              return { ...value, matches, index: Math.min(value.index, Math.max(0, matches.length - 1)) }
            }
            return value
          },
        },
        props: {
          decorations(state) {
            const s = findKey.getState(state)
            if (!s?.matches.length) return DecorationSet.empty
            return DecorationSet.create(
              state.doc,
              s.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === s.index ? 'find-hit find-cur' : 'find-hit' })),
            )
          },
        },
      }),
    ]
  },
  addCommands() {
    const meta = (m: object) => ({ tr, dispatch }: any) => (dispatch?.(tr.setMeta(findKey, m)), true)
    return {
      setFind: (query: string) => meta({ query }),
      clearFind: () => meta({ clear: true }),
      stepFind: (dir: 1 | -1) => ({ tr, state, dispatch, view }: any) => {
        const s = findKey.getState(state)
        if (!s?.matches.length) return false
        const index = (s.index + dir + s.matches.length) % s.matches.length
        dispatch?.(tr.setMeta(findKey, { index }))
        scrollTo(view, s.matches[index].from)
        return true
      },
    } as any
  },
})

export const getFind = (editor: any): FindState => findKey.getState(editor.state) ?? EMPTY
export const scrollToMatch = (editor: any) => {
  const s = getFind(editor)
  if (s.matches[s.index]) scrollTo(editor.view, s.matches[s.index].from)
}
