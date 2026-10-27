import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import { insertionAnchor } from './insertionAnchor'
import { t } from '../i18n'
import { OPEN_PAGE } from './pageLink'

/**
 * A database shown inside a page. The page stores only the container id; the database itself (rows, views, schema) lives in the database
 * records, and its React UI is loaded the first time one is shown.
 */
export const DatabaseEmbed = Node.create({
  name: 'databaseEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      containerId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-container') ?? '',
        renderHTML: (a) => ({ 'data-container': a.containerId }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="database-embed"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'database-embed' }, HTMLAttributes)],
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'db-embed'
      dom.contentEditable = 'false'
      let unmount: (() => void) | null = null
      let destroyed = false
      const id = node.attrs.containerId as string
      if (!id) {
        dom.textContent = t('This database is not available.')
      } else {
        void Promise.all([import('react-dom/client'), import('react'), import('../database/ui/DatabaseContainer')]).then(([{ createRoot }, React, { DatabaseContainer }]) => {
          if (destroyed) return
          const root = createRoot(dom)
          root.render(React.createElement(DatabaseContainer, { containerId: id, inline: true, onOpenPage: (pageId: string) => window.dispatchEvent(new CustomEvent(OPEN_PAGE, { detail: pageId })) }))
          unmount = () => root.unmount()
        }).catch(() => { if (!destroyed) dom.textContent = t('This database is not available.') })
      }
      return {
        dom,
        stopEvent: () => true,
        ignoreMutation: () => true,
        destroy: () => { destroyed = true; const u = unmount; unmount = null; if (u) queueMicrotask(u) },
      }
    }
  },
})

/** Slash command: create an inline database on the page being edited and put it at the cursor. */
export async function insertDatabase(editor: Editor) {
  const pageId = (editor.storage as { currentPageId?: string }).currentPageId
  if (!pageId || editor.isDestroyed || !editor.isEditable) return
  const anchor = insertionAnchor(editor)
  try {
    const { getDatabase } = await import('../database/runtime')
    const svc = await getDatabase()
    if (!anchor.isValid()) return
    const made = await svc.one<{ containerId: string }>('database.create', { hostPageId: pageId, presentation: 'inline', title: t('Untitled database') })
    if (!anchor.insert({ type: 'databaseEmbed', attrs: { containerId: made.containerId } })) {
      window.dispatchEvent(new CustomEvent('layout-message', { detail: t('The database was created. Open it from Databases.') }))
    }
  } catch {
    window.dispatchEvent(new CustomEvent('layout-message', { detail: t('The database could not be inserted. Please try again.') }))
  } finally { anchor.release() }
}
