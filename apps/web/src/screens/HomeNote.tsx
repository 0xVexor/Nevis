// The quick note of Home, drawn as the old app drew it (a card with a toolbar, a title, the writing area and a footer). It is a DRAFT: the page
// is created on the first words, then every pause in typing saves the whole note into it. Same classes as the old HomeNote.
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { Editor } from '@tiptap/core'
import { createEditor } from '@nevis/editor'
import { project, type PMJson } from '@nevis/schema'
import { Button, Icon, SaveStatus } from '../ds'
import { t } from '../i18n'
import type { Workspace } from '../workspace'

export function HomeNote({ ws, onOpen, autoFocus }: { ws: Workspace; onOpen: (id: string) => void; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  const page = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const title = useRef('')
  const [titleText, setTitleText] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [pageId, setPageId] = useState<string | null>(null)
  const ydoc = useRef(new Y.Doc())

  const save = async () => {
    const ed = editor.current
    if (!ed) return
    const body = project(ydoc.current)
    const text = ed.getText().trim()
    if (!page.current && !text && !title.current.trim()) return
    try {
      if (!page.current) { page.current = await ws.newPage('', title.current.trim() || text.split('\n')[0]!.slice(0, 80)); setPageId(page.current) }
      else ws.setTitle(page.current, title.current.trim() || text.split('\n')[0]!.slice(0, 80))
      await ws.writeBody(page.current, body as PMJson)
      setStatus('saved')
    } catch { setStatus('error') }
  }
  const later = () => { setStatus('saving'); clearTimeout(timer.current); timer.current = setTimeout(() => void save(), 600) }

  useEffect(() => {
    const ed = createEditor(ydoc.current, host.current!, { notify: m => ws.notify(m) })
    editor.current = ed
    ed.on('update', later)
    if (autoFocus) ed.commands.focus('start')
    return () => { clearTimeout(timer.current); ed.destroy(); editor.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ds-card home-note-paper">
      <div className="home-note-toolbar">
        <span><Icon name="file" size={16} />{t('New note')}</span>
        <Button variant="ghost" size="sm" onMouseDown={e => e.preventDefault()} onClick={() => { editor.current?.commands.focus(); editor.current?.chain().focus().insertContent('/').run() }}><kbd>/</kbd>{t('Commands')}</Button>
      </div>
      <div className="home-note-writing">
        <input className="home-note-title" aria-label={t('Note title')} placeholder={t('Title (optional)')} dir="auto" value={titleText} onChange={e => { title.current = e.target.value; setTitleText(e.target.value); later() }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); editor.current?.commands.focus('start') } }} />
        <div><div className="home-note-editor" ref={host} data-testid="home-note-editor" /></div>
      </div>
      <footer className="home-note-footer">
        <SaveStatus state={status} label={t(status === 'idle' ? 'Saved automatically as you write' : status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved to your pages' : 'Could not save. Your note is still here.')} />
        {pageId && <Button size="sm" variant="ghost" onClick={() => onOpen(pageId)}>{t('Open page')}<Icon name="arrow-right" size={14} className="ds-flip" /></Button>}
      </footer>
    </div>
  )
}
