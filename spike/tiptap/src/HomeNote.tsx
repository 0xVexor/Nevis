import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { BlockIdentity } from './editor/blockIdentity'
import { HeadingDir } from './editor/headingDir'
import { Button, Icon, SaveStatus, useMenu } from './design-system'
import { SlashCommand } from './editor/slash'
import { CommandPalette, openCommandPalette } from './editor/commandPalette'
import { registerUpdateSave } from './updateSave'
import type { DocNode } from './docNode'
import { t } from './i18n'

export interface HomeNoteDraft { title: string; content: DocNode; text: string }
export interface HomeNoteProps {
  onChange: (draft: HomeNoteDraft) => string
  onPersist: () => Promise<void>
  onDirty?: (id: string, dirty: boolean) => void
  onOpen: (id: string) => void
  /** The first visit to an empty workspace: the caret waits in the note. */
  autoFocus?: boolean
  /** Replaces the note with a starting point; a new `key` applies it again. */
  starter?: { key: string; title: string; content: DocNode }
  onStatus?: (status: 'idle' | 'saving' | 'saved' | 'error') => void
  /** The caller offers its own way onward instead of "Open page". */
  hideOpen?: boolean
  /** Only the title and the text: the caller draws the sheet, save feedback and commands. The caret starts in the title. */
  bare?: boolean
}

// Offer the blocks supported by this new-note schema; rich documents open in PageView.
const NOTE_COMMANDS = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list', 'Checklist', 'Quote', 'Code block', 'Divider']

/** A new document only. Existing rich documents always open in PageView. */
export function HomeNote(props: HomeNoteProps) {
  const callbacks = useRef(props)
  callbacks.current = props
  const [title, setTitle] = useState('')
  const [pageId, setPageId] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const currentTitle = useRef('')
  const id = useRef<string | null>(null)
  const revision = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  const failed = useRef(false)
  const latest = useRef<HomeNoteDraft | null>(null)
  const { open, menu } = useMenu()
  const persist = useCallback(async () => {
    clearTimeout(timer.current)
    if (failed.current && latest.current) {
      id.current = callbacks.current.onChange(latest.current)
      failed.current = false
      if (mounted.current) setPageId(id.current)
    }
    if (!id.current) return
    const at = revision.current
    await callbacks.current.onPersist()
    if (at === revision.current) {
      if (mounted.current) {
        callbacks.current.onDirty?.(id.current, false)
        setStatus('saved')
      }
    }
  }, [])
  const persistQuietly = useCallback(() => { void persist().catch(() => { if (mounted.current) setStatus('error') }) }, [persist])
  const publish = useRef<(draft: HomeNoteDraft) => void>(() => undefined)
  publish.current = draft => {
    latest.current = draft
    if (!id.current && !draft.title.trim() && !draft.text.trim()) return
    revision.current++
    setStatus('saving')
    try {
      id.current = callbacks.current.onChange(draft)
      failed.current = false
      setPageId(id.current)
      callbacks.current.onDirty?.(id.current, true)
      clearTimeout(timer.current)
      timer.current = setTimeout(persistQuietly, 400)
    } catch {
      failed.current = true
      setStatus('error')
    }
  }
  const editor = useEditor({
    extensions: [StarterKit.configure({ dropcursor: { color: 'var(--ds-accent)', width: 2 } }), TaskList, TaskItem.configure({ nested: true }), BlockIdentity, HeadingDir, SlashCommand.configure({ allowedCommands: NOTE_COMMANDS }), CommandPalette.configure({ allowedCommands: NOTE_COMMANDS }), Placeholder.configure({ placeholder: () => t('Start writing, or press / for commands.') })],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    autofocus: props.autoFocus && !props.bare ? 'start' : false,
    shouldRerenderOnTransaction: true,
    editorProps: { attributes: { 'aria-label': t('Note content'), spellcheck: 'false' } },
    onUpdate: ({ editor }) => publish.current({ title: currentTitle.current, content: editor.getJSON() as DocNode, text: editor.getText() }),
    onBlur: persistQuietly,
  })
  useEffect(() => {
    mounted.current = true
    const unregister = registerUpdateSave(persist)
    const flush = () => persistQuietly()
    window.addEventListener('pagehide', flush)
    return () => {
      mounted.current = false
      if (id.current) callbacks.current.onDirty?.(id.current, false)
      unregister()
      window.removeEventListener('pagehide', flush)
      persistQuietly()
    }
  }, [persist, persistQuietly])
  useEffect(() => callbacks.current.onStatus?.(status), [status])
  const starterKey = props.starter?.key
  useEffect(() => {
    const starter = callbacks.current.starter
    if (!editor || !starter) return
    currentTitle.current = starter.title
    setTitle(starter.title)
    editor.commands.setContent(starter.content, { emitUpdate: true })
    // the caret waits in the first empty line of the starting point
    let empty: number | null = null
    editor.state.doc.descendants((node, pos) => {
      if (empty !== null) return false
      if (node.isTextblock && node.content.size === 0) empty = pos + 1
    })
    editor.commands.focus(empty ?? 'end')
  }, [editor, starterKey])
  const retry = () => {
    if (!editor) return
    publish.current({ title: currentTitle.current, content: editor.getJSON() as DocNode, text: editor.getText() })
    persistQuietly()
  }
  const openPage = async () => {
    try { await persist(); if (id.current) callbacks.current.onOpen(id.current) }
    catch { setStatus('error') }
  }
  const titleField = <input className="home-note-title" aria-label={t('Note title')} placeholder={t(props.bare ? 'Untitled' : 'Title (optional)')} dir="auto" value={title} autoFocus={props.bare && props.autoFocus} onBlur={persistQuietly} onKeyDown={event => {
    if (props.bare && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); editor?.commands.focus('start') }
  }} onChange={event => {
    currentTitle.current = event.target.value
    setTitle(event.target.value)
    if (editor) publish.current({ title: event.target.value, content: editor.getJSON() as DocNode, text: editor.getText() })
  }} />
  const body = <div onContextMenu={event => {
    event.preventDefault()
    open([
      { label: 'Undo', icon: <Icon name="undo" />, onSelect: () => { editor?.chain().focus().undo().run() } },
      { label: 'Redo', icon: <Icon name="redo" />, onSelect: () => { editor?.chain().focus().redo().run() } },
      { label: 'Select all', onSelect: () => { editor?.chain().focus().selectAll().run() } },
    ], event)
  }}><EditorContent editor={editor} className="home-note-editor" /></div>
  if (props.bare) return <div className="home-note-bare">
    {titleField}
    {body}
    {status === 'error' && <Button size="sm" onClick={retry}>{t('Retry')}</Button>}
    {menu}
  </div>
  return <div className="ds-card home-note-paper">
    <div className="home-note-toolbar">
      <span><Icon name="file" size={16} />{t('New note')}</span>
      <Button variant="ghost" size="sm" disabled={!editor} onMouseDown={event => event.preventDefault()} onClick={() => { if (editor) { editor.commands.focus(); openCommandPalette(editor, NOTE_COMMANDS) } }}><kbd>/</kbd>{t('Commands')}</Button>
    </div>
    <div className="home-note-writing">
      {titleField}
      {body}
    </div>
    <footer className="home-note-footer">
      <SaveStatus state={status} label={t(status === 'idle' ? 'Saved automatically as you write' : status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved to your pages' : 'Could not save. Your note is still here.')} />
      {status === 'error' ? <Button size="sm" onClick={retry}>{t('Retry')}</Button> : pageId && !props.hideOpen && <Button size="sm" variant="ghost" onClick={() => void openPage()}>{t('Open page')}<Icon name="arrow-right" size={14} className="ds-flip" /></Button>}
    </footer>
    {menu}
  </div>
}
