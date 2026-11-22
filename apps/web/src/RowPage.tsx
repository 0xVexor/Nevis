// One row of a database opened as a page: its title (the title property), its properties, and its body (a document of its own: the row id
// is the document id, ADR-0002). The frame and classes are the page's, as the old app showed a row.
import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { createWorkspaceEditor } from './editor/createWorkspaceEditor'
import { closeCommandPalette } from './editor/commandPalette'
import { LayoutControls } from './LayoutControls'
import { TableBubble } from './TableBubble'
import { ImageBubble } from './ImageBubble'
import { EditorMenus } from './editor/EditorMenus'
import { setCell, titleProperty, type DocHandle } from '@nevis/core'
import { Cell } from './DatabaseView'
import { Icon, IconButton, PropertyList, PropertyRow } from './ds'
import { t } from './i18n'
import { go } from './router'
import { Toolbar } from './shell/Toolbar'
import type { Workspace } from './workspace'

const KIND_ICON: Record<string, string> = { text: 'type', number: 'hash', date: 'calendar', select: 'list', multiSelect: 'list', relation: 'link', checkbox: 'check', url: 'link' }

export function RowPage({ ws, dbId, id, peek = false }: { ws: Workspace; dbId: string; id: string; peek?: boolean }) {
  const db = ws.data.databases.get(dbId)
  const row = db?.rows.find(r => r.id === id && !r.trashed)
  const host = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const tp = db ? titleProperty(db.properties) : undefined
  const [title, setTitle] = useState(row?.title ?? '')
  const ready = !!(db && row && tp) // the body's host exists only once the row is known
  const titleBox = useRef<HTMLTextAreaElement>(null)
  // the stored title follows the data (a write still arriving, or another device) unless the person is typing in it
  useEffect(() => { if (document.activeElement !== titleBox.current) setTitle(row?.title ?? '') }, [id, row?.title]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let ed: Editor | null = null, handle: DocHandle | null = null, dead = false
    setEditor(null)
    void ws.openDoc(id).then(h => {
      if (dead) return
      handle = h
      if (h.needsUpdate || !host.current) return
      ed = createWorkspaceEditor(ws, h.ydoc, host.current, false)
      setEditor(ed)
    })
    return () => { dead = true; if (ed) { closeCommandPalette(ed); ed.destroy() }; if (handle) void ws.closeDoc(id) }
  }, [ws, id, ready])
  if (!db || !row || !tp) return <p className="small screen">{t('Page not found')}</p>
  const props = db.properties.filter(p => !p.trashed && !p.isTitle)
  return (
    <div className="page-cols" data-testid="row-page">
      <div className="page">
        <header className="pg-head">
          {!peek && <div className="pg-add"><IconButton label={t('Back to the database')} data-testid="row-back" onClick={() => go({ name: 'page', id: db.id })}><Icon name="arrow-right" size={16} className="ds-flip" /></IconButton></div>}
          <div className="pg-title-row">
            <textarea ref={titleBox} className="pg-title" data-testid="row-title" rows={1} dir={title.trim() ? 'auto' : undefined} aria-label={t('Page title')} placeholder={t('Untitled')} value={title}
              onInput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }}
              onChange={e => { const v = e.target.value.replace(/\n/g, ' '); setTitle(v); void ws.mutate([row.id], c => setCell(c, row.id, tp, v)) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); editor?.commands.focus('start') } }} />
          </div>
        </header>
        <PropertyList className="pg-props" label={t('Page properties')}>
          {props.map(p => (
            <PropertyRow key={p.id} icon={<Icon name={KIND_ICON[p.type] ?? 'type'} size={16} />} label={p.name}>
              <Cell ws={ws} db={db} p={p} row={row} />
            </PropertyRow>
          ))}
        </PropertyList>
        {editor && <Toolbar editor={editor} />}
        {editor && <><LayoutControls editor={editor} /><TableBubble editor={editor} /><ImageBubble editor={editor} /><EditorMenus editor={editor} ws={ws} id={id} row /></>}
        <div className="ec editor" data-testid="row-editor" ref={host} />
      </div>
    </div>
  )
}
