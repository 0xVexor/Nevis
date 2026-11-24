import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { getFind, scrollToMatch } from '@nevis/editor'
import { Icon, IconButton } from '../ds'
import { t } from '../i18n'
import { matches } from '../shortcutBindings'
import { commandMatches } from '../shortcutCommands'

/** Shared find bar for ordinary pages and database row documents. */
export function usePageFind(editor: Editor | null) {
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const [, redraw] = useState(0)
  const find = editor ? getFind(editor) : { query: '', matches: [], index: 0 }
  const step = (direction: 1 | -1) => { editor?.commands.findNext(direction); if (editor) scrollToMatch(editor) }
  const close = () => { editor?.commands.setFindQuery(''); setOpen(false); editor?.commands.focus() }
  useEffect(() => {
    if (!editor) return
    const show = () => {
      const { from, to } = editor.state.selection
      const picked = from !== to ? editor.state.doc.textBetween(from, to, ' ') : ''
      setOpen(true)
      requestAnimationFrame(() => { const el = input.current; if (!el) return; if (picked && !picked.includes('\n')) { el.value = picked; editor.commands.setFindQuery(picked); scrollToMatch(editor) } el.focus(); el.select() })
    }
    const blocked = () => [...document.querySelectorAll('.dv-peek-layer, [role="dialog"], .ds-pop, .slash-menu, .lightbox[open]')].some(layer => !layer.contains(editor.view.dom) && layer.getClientRects().length > 0)
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || blocked()) return
      if (matches(event, 'find')) { event.preventDefault(); show(); return }
      if (!open) return
      if (commandMatches(event, 'Close find')) { event.preventDefault(); close(); return }
      if (event.key === 'Enter' && event.target !== input.current) return
      const direction = commandMatches(event, 'Previous match') ? -1 : commandMatches(event, 'Next match') ? 1 : 0
      if (direction) { event.preventDefault(); step(direction) }
    }
    const dom = editor.view.dom
    const update = () => redraw(n => n + 1)
    editor.on('transaction', update); editor.on('focus', update); editor.on('blur', update)
    window.addEventListener('keydown', key); window.addEventListener('open-find', show); dom.addEventListener('nevis:find-open', show)
    return () => { editor.off('transaction', update); editor.off('focus', update); editor.off('blur', update); window.removeEventListener('keydown', key); window.removeEventListener('open-find', show); dom.removeEventListener('nevis:find-open', show) }
  }, [editor, open])
  const bar = open && editor && <div className="pg-find-slot"><div className="pg-find" role="search" data-testid="find">
    <Icon name="search" size={16} />
    <input ref={input} dir="auto" aria-label={t('Search in this page…')} placeholder={t('Search in this page…')} onChange={event => { editor.commands.setFindQuery(event.target.value); scrollToMatch(editor) }} />
    <span className="pg-find-count" aria-live="polite">{find.matches.length ? t('{i} of {n}', { i: find.index + 1, n: find.matches.length }) : find.query ? t('Not found') : ''}</span>
    <IconButton label={t('Previous')} disabled={!find.matches.length} onClick={() => step(-1)}><Icon name="chevron-up" size={16} /></IconButton>
    <IconButton label={t('Next')} disabled={!find.matches.length} onClick={() => step(1)}><Icon name="chevron-down" size={16} /></IconButton>
    <IconButton label={t('Close')} onClick={close}><Icon name="x" size={16} /></IconButton>
  </div></div>
  return { open, bar }
}
