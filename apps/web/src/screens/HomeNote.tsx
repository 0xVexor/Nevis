// The quick note of Home, drawn as the old app drew it (a card with a toolbar, a title, the writing area and a footer). It is a DRAFT: the page
// is created on the first words, then every pause in typing saves the whole note into it. Same classes as the old HomeNote.
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { Extension, type Editor } from '@tiptap/core'
import { createEditor } from '@nevis/editor'
import type { PMJson } from '@nevis/schema'
import { Button, Icon, SaveStatus } from '../ds'
import { CommandPalette, closeCommandPalette, openCommandPalette } from '../editor/commandPalette'
import { SlashCommand } from '../editor/slash'
import { t } from '../i18n'
import type { Workspace } from '../workspace'

const NOTE_COMMANDS = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list', 'Checklist', 'Quote', 'Code block', 'Divider']

export function HomeNote({ ws, onOpen, autoFocus }: { ws: Workspace; onOpen: (id: string) => void; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  const page = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const title = useRef('')
  const [titleText, setTitleText] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [pageId, setPageId] = useState<string | null>(null)
  const mounted = useRef(false)
  const pending = useRef<Promise<void>>(Promise.resolve())
  const revision = useRef(0)
  const latest = useRef<{ title: string; body: PMJson; text: string; revision: number } | null>(null)
  const report = (state: typeof status) => { if (mounted.current) setStatus(state) }

  const save = (): Promise<void> => {
    clearTimeout(timer.current)
    timer.current = undefined
    const draft = latest.current
    if (!draft) return pending.current
    latest.current = null
    pending.current = pending.current.catch(() => undefined).then(async () => {
      if (!page.current && !draft.title && !draft.text) return
      const name = draft.title || (draft.text.split('\n')[0] ?? '').slice(0, 80)
      try {
        if (!page.current) {
          page.current = await ws.newPage('', name)
          if (mounted.current) setPageId(page.current)
        } else await ws.rename(page.current, name)
        await ws.writeBody(page.current, draft.body)
        if (draft.revision === revision.current) report('saved')
      } catch (error) {
        if (draft.revision === revision.current) {
          latest.current = draft
          report('error')
        }
        throw error
      }
    })
    return pending.current
  }
  const saveQuietly = () => { void save().catch(() => undefined) }
  const later = () => {
    const ed = editor.current
    if (!ed) return
    const text = ed.getText().trim()
    const name = title.current.trim()
    if (!page.current && !name && !text && !latest.current) return
    latest.current = { title: name, body: ed.getJSON() as PMJson, text, revision: ++revision.current }
    report('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(saveQuietly, 400)
  }

  useEffect(() => {
    mounted.current = true
    const ydoc = new Y.Doc()
    const ed = createEditor(ydoc, host.current!, {
      notify: message => ws.notify(message),
      placeholder: () => t('Start writing, or press / for commands.'),
      uiExtensions: [
        SlashCommand.configure({ allowedCommands: NOTE_COMMANDS }),
        CommandPalette.configure({ allowedCommands: NOTE_COMMANDS }),
        Extension.create({ name: 'dragHandle' }),
        Extension.create({ name: 'floatingBars' }),
      ],
    })
    ed.view.dom.setAttribute('aria-label', t('Note content'))
    editor.current = ed
    ed.on('update', later)
    window.addEventListener('pagehide', saveQuietly)
    if (autoFocus) ed.commands.focus('start')
    return () => {
      mounted.current = false
      window.removeEventListener('pagehide', saveQuietly)
      saveQuietly()
      closeCommandPalette(ed)
      ed.destroy()
      ydoc.destroy()
      editor.current = null
    }
  }, [ws]) // eslint-disable-line react-hooks/exhaustive-deps
  const openPage = async () => {
    try { await save(); if (page.current) onOpen(page.current) }
    catch { report('error') }
  }

  return (
    <div className="ds-card home-note-paper">
      <div className="home-note-toolbar">
        <span><Icon name="file" size={16} />{t('New note')}</span>
        <Button variant="ghost" size="sm" onMouseDown={e => e.preventDefault()} onClick={() => { const ed = editor.current; if (ed) openCommandPalette(ed, NOTE_COMMANDS) }}><kbd>/</kbd>{t('Commands')}</Button>
      </div>
      <div className="home-note-writing" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) saveQuietly() }}>
        <input className="home-note-title" aria-label={t('Note title')} placeholder={t('Title (optional)')} dir="auto" value={titleText} onChange={e => { title.current = e.target.value; setTitleText(e.target.value); later() }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); editor.current?.commands.focus('start') } }} />
        <div><div className="home-note-editor" ref={host} data-testid="home-note-editor" /></div>
      </div>
      <footer className="home-note-footer">
        <SaveStatus state={status} label={t(status === 'idle' ? 'Saved automatically as you write' : status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved to your pages' : 'Could not save. Your note is still here.')} />
        {status === 'error' ? <Button size="sm" onClick={saveQuietly}>{t('Retry')}</Button> : pageId && <Button size="sm" variant="ghost" onClick={() => void openPage()}>{t('Open page')}<Icon name="arrow-right" size={14} className="ds-flip" /></Button>}
      </footer>
    </div>
  )
}
