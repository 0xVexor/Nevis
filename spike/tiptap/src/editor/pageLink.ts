import { Extension, InputRule, Node, mergeAttributes } from '@tiptap/core'
import { plainIcon } from '../iconSet'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { repo } from '../store'
import { normalizeFa } from '../normalize'
import { menuRender } from './menu'
import { t as tr } from '../i18n'

export const PAGES_CHANGED = 'pages-changed'
export const OPEN_PAGE = 'open-page'

/** A link is followed by a space so typing can continue, unless punctuation or a space already follows. */
const gap = (doc: any, pos: number) => (/^[\s.,;:!?)\]}،؛؟]/.test(doc.textBetween(pos, Math.min(pos + 1, doc.content.size), undefined, '￼')) ? [] : [{ type: 'text', text: ' ' }])

const byTitle = (name: string) => repo.pagesOnly().find((p) => normalizeFa(p.title).trim() === normalizeFa(name).trim())

/** Inline reference to another page. Stores only the id, so renames show up wherever it is used. */
export const PageLink = Node.create({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  // `label`: text the link shows instead of the page title (set when selected text is turned into a link)
  addAttributes: () => ({ id: { default: '' }, label: { default: null } }),
  parseHTML: () => [{ tag: 'a[data-type="page-link"]', getAttrs: (el) => ({ id: (el as HTMLElement).getAttribute('data-id') ?? '', label: (el as HTMLElement).getAttribute('data-label') }) }],
  renderHTML: ({ node }) => ['a', mergeAttributes({ 'data-type': 'page-link', 'data-id': node.attrs.id }, node.attrs.label ? { 'data-label': node.attrs.label } : {}), node.attrs.label || repo.get(node.attrs.id)?.title || tr('Page')],

  /**
   * Typing a complete `[[Title]]` (or `[[Title|alias]]`) by hand turns it into a link when the closing `]]` is typed:
   * to the page with that title, or to a new page of that name. Backspace right after undoes the conversion.
   */
  addInputRules() {
    const type = this.type
    return [
      new InputRule({
        find: /\[\[([^[\]|\n]+)(?:\|[^[\]\n]*)?\]\]$/,
        handler: ({ state, range, match }) => {
          const name = match[1].trim()
          if (!name) return null
          let page = byTitle(name)
          if (!page) {
            page = repo.create(null)
            repo.update(page.id, { title: name })
            setTimeout(() => window.dispatchEvent(new Event(PAGES_CHANGED)))
          }
          state.tr.replaceWith(range.from, range.to, [type.create({ id: page.id }), ...(gap(state.doc, range.to).length ? [state.schema.text(' ')] : [])])
        },
      }),
    ]
  },

  addNodeView() {
    return ({ node }) => {
      const id: string = node.attrs.id
      const label: string | null = node.attrs.label
      const a = document.createElement('a')
      a.className = 'page-link'
      a.contentEditable = 'false'
      a.setAttribute('data-id', id)
      const paint = () => {
        const p = repo.get(id)
        a.classList.toggle('missing', !p)
        a.replaceChildren()
        const ic = document.createElement('span')
        ic.className = 'page-link-ic'
        ic.textContent = p ? plainIcon(p.icon) : '⛔'
        const t = document.createElement('span')
        t.className = 'page-link-title'
        t.setAttribute('dir', 'auto')
        t.textContent = p ? label || p.title || tr('Untitled') : tr('Deleted page')
        if (p && label) a.title = p.title || tr('Untitled')
        a.append(ic, t)
      }
      paint()
      window.addEventListener(PAGES_CHANGED, paint)
      a.onclick = (e) => {
        e.preventDefault()
        if (repo.get(id)) window.dispatchEvent(new CustomEvent(OPEN_PAGE, { detail: id }))
      }
      return { dom: a, ignoreMutation: () => true, destroy: () => window.removeEventListener(PAGES_CHANGED, paint) }
    }
  },
})

type Item = { id: string | null; title: string; icon: string; desc: string }

/**
 * What follows the caret inside the same brackets: with the caret in «[[abc|def]]» this is "def" (+ the `]]`).
 * The picker must treat the WHOLE bracket content as the page name, not only the part before the caret.
 */
const restOfBrackets = (editor: any): { text: string; length: number } | null => {
  const { $from } = editor.state.selection
  const after: string = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, undefined, '￼')
  const m = after.match(/^([^[\]\n]*)\]\]/)
  return m ? { text: m[1], length: m[0].length } : null
}

/** exact title first, then "starts with", then "contains"; ties by most recently edited */
const rank = (title: string, q: string) => {
  const t = normalizeFa(title).trim()
  return t === q ? 0 : t.startsWith(q) ? 1 : 2
}

/** Never offer the picker inside code (`a / b`, `x[[0]]`) or inline code. */
const notInCode = ({ state }: any) => {
  const $from = state.selection.$from
  return $from.parent.type.name !== 'codeBlock' && !$from.marks().some((m: any) => m.type.name === 'code')
}

/**
 * Two ways to open the page picker:
 *  - `[[`  (spaces allowed in the query, so «[[قضایای حد» works)
 *  - `@`   for keyboards where `[` is a letter — the standard Persian layout has no bracket keys (ج چ instead)
 * The last entry of the list creates a new page. The page you are on is never offered.
 */
export const PageLinkSuggest = Extension.create({
  name: 'pageLinkSuggest',
  addStorage: () => ({}),
  addProseMirrorPlugins() {
    const editor = this.editor
    const make = (key: string, char: string, extra: object) =>
      Suggestion<Item>({
        editor,
        pluginKey: new PluginKey(key),
        char,
        startOfLine: false,
        allow: notInCode,
        items: ({ query }) => {
          const here = (editor.storage as any).currentPageId
          // the caret may be in the middle of an already written «[[full name]]»: use all of it
          const full = (query + (char === '[[' ? (restOfBrackets(editor)?.text ?? '') : '')).replace(/\|.*$/, '') // [[Title|alias]]: search by Title
          const q = normalizeFa(full).trim()
          const pages = repo.pagesOnly().filter((p) => p.id !== here)
          const hits: Item[] = pages
            .filter((p) => !q || normalizeFa(p.title).includes(q))
            .sort((a, b) => rank(a.title, q) - rank(b.title, q) || b.updatedAt - a.updatedAt)
            .slice(0, 8)
            .map((p) => ({ id: p.id, title: p.title || tr('Untitled'), icon: plainIcon(p.icon), desc: tr('Link to this page') }))
          const exact = repo.pagesOnly().some((p) => normalizeFa(p.title).trim() === q)
          if (full.trim() && !exact) hits.push({ id: null, title: full.trim(), icon: 'i:plus', desc: tr('Create a new page and link to it') })
          return hits
        },
        command: ({ editor: ed, range, props }) => {
          let id = props.id
          if (!id) {
            id = repo.create(null).id
            repo.update(id, { title: props.title })
            window.dispatchEvent(new Event(PAGES_CHANGED))
          }
          // replace «[[…» up to and including the closing «]]» when it is there, so nothing of the name stays behind as text
          const rest = char === '[[' ? restOfBrackets(ed) : null
          const to = range.to + (rest?.length ?? 0)
          ed.chain().focus().insertContentAt({ from: range.from, to }, [{ type: 'pageLink', attrs: { id } }, ...gap(ed.state.doc, to)]).run()
        },
        render: menuRender<Item>({ label: tr('Link to a page'), view: (i) => i, empty: tr('No page found') }),
        ...extra,
      })
    return [
      make('pageLinkSuggest', '[[', { allowSpaces: true, allowedPrefixes: null }),
      make('pageAtSuggest', '@', { allowSpaces: false }), // only after a space or at line start, so e-mail addresses are safe
    ]
  },
})
