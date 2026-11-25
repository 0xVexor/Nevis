import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PageChrome } from './shell/pageChrome'
import { Toolbar } from './shell/Toolbar'
import { ResponsiveProperties } from './shell/ResponsiveProperties'
import { createWorkspaceEditor } from './editor/createWorkspaceEditor'
import { LayoutControls } from './LayoutControls'
import { TableBubble } from './TableBubble'
import { ImageBubble } from './ImageBubble'
import { closeCommandPalette } from './editor/commandPalette'
import { EditorMenus } from './editor/EditorMenus'
import { getTemplates, templateDoc, type Template } from './shell/oldTemplates'
import { Glyph } from './ds/iconSet'
import type { Editor } from '@tiptap/core'
import { usePageFind } from './editor/usePageFind'
import { IconButton } from './ds'
import { Backlinks } from './views/Backlinks'
import { Button, ChipButton, Icon, PageIconPicker, Popover, PropertyList, PropertyRow, Tag, dirOf } from './ds'
import { ago } from './shell/ago'
import { toneOf } from './shell/PageIcon'
import { isGlyph, parseIcon } from './ds/iconSet'
import { CoverBanner, CoverPicker } from './shell/Cover'
import { PageStatusChip } from './shell/PageStatusChip'
import { iconNode } from './ds/iconSet'
import { legacyPages } from './shell/adapt'
import type { Cover } from './shell/model'
import { t } from './i18n'
import type { DocHandle } from '@nevis/core'
import type { Workspace } from './workspace'

const TEMPLATE_GLYPH: Record<string, string> = { lecture: 'graduation', chapter: 'book', exercise: 'target', meeting: 'users', todo: 'list' }

/** One open page: title + body. The body is the Yjs document of the page; the title is a register. */
export function EditorPane({ ws, id, title }: { ws: Workspace; id: string; title: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'needs-update'>('loading')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [name, setName] = useState(title)
  const titleInput = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    // Preserve typing in progress; a rename from the tree or another device updates an unfocused title.
    if (document.activeElement !== titleInput.current) setName(title)
  }, [id, title])

  useEffect(() => {
    let ed: Editor | null = null
    let handle: DocHandle | null = null
    let dead = false
    setState('loading'); setEditor(null)
    void ws.openDoc(id).then(h => {
      if (dead) return
      handle = h
      if (h.needsUpdate) { setState('needs-update'); return } // ADR-0003 §6: a newer schema is not edited by an older client
      ed = createWorkspaceEditor(ws, h.ydoc, host.current!)
      const tpl = ws.takeTemplate(id)
      if (tpl && ed.isEmpty) ed.commands.setContent(tpl as never)
      ;(window as unknown as { __editor?: Editor }).__editor = ed
      setEditor(ed); setState('ready')
    })
    return () => { dead = true; if (ed) { closeCommandPalette(ed); ed.destroy() }; if (handle) void ws.closeDoc(id) }
  }, [ws, id])

  const meta = legacyPages(ws).find(p => p.id === id)
  const [picker, setPicker] = useState<DOMRect | null>(null)
  const [coverMenu, setCoverMenu] = useState<DOMRect | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const setCover = (c: Cover | undefined) => void ws.setMeta(id, { cover: c ? JSON.stringify(c) : null })
  const q = tagDraft.trim().replace(/^#+/, '').toLowerCase()
  const suggestions = q ? ws.data.tags.map(x => x.name).filter(n => n.toLowerCase().includes(q) && !(meta?.tags ?? []).includes(n)).slice(0, 6) : []
  const { reader } = useContext(PageChrome)
  const { open: findOpen, bar: findBar } = usePageFind(editor)
  const diverged = ws.diverged.has(id)
  useEffect(() => { editor?.setEditable(!diverged && !reader) }, [editor, diverged, reader])
  useEffect(() => { const f = (e: Event) => setCoverMenu((e as CustomEvent<DOMRect>).detail); window.addEventListener('nevis:page-cover', f); return () => window.removeEventListener('nevis:page-cover', f) }, [])
  useEffect(() => {
    const notify = (event: Event) => ws.notify(String((event as CustomEvent<string>).detail))
    window.addEventListener('layout-message', notify)
    return () => window.removeEventListener('layout-message', notify)
  }, [ws])
  // the page's headings, for the outline in the page drawer
  const [heads, setHeads] = useState<{ pos: number; level: number; text: string }[]>([])
  useEffect(() => {
    if (!editor) return
    const read = () => { const out: { pos: number; level: number; text: string }[] = []; editor.state.doc.descendants((n, pos) => { if (n.type.name === 'heading' && n.attrs.level <= 3 && n.textContent.trim()) out.push({ pos, level: n.attrs.level, text: n.textContent }) }); setHeads(out) }
    read(); editor.on('update', read); return () => { editor.off('update', read) }
  }, [editor])
  const slot = document.getElementById('outline-slot')
  const outline = useMemo(() => slot && createPortal(<>
    <h4>{t('Outline')}</h4>
    {heads.length === 0 && <p className="pp-note">{t('Add headings (H1–H3) and the outline will appear here.')}</p>}
    {heads.length > 0 && <nav className="pp-outline" aria-label={t('Outline')}>{heads.map(h => (
      <button key={h.pos} type="button" className="pp-outline-item" style={{ ['--lv' as string]: h.level - 1 } as React.CSSProperties} onClick={() => { editor?.chain().focus().setTextSelection(h.pos + 1).scrollIntoView().run() }}><span dir="auto">{h.text}</span></button>
    ))}</nav>}
  </>, slot), [slot, heads, editor])
  if (state === 'needs-update') return <div className="page-cols"><div className="page"><p role="alert" className="pg-note" data-testid="needs-update">{t('This page was made with a newer version of the app; an update is needed.')}</p></div></div>
  return (
    <div className={'page-cols' + (meta?.cover ? ' has-cover' : '')}>
      <div className={'page' + (findOpen ? ' finding' : '')}>
        {findBar}
        {meta?.cover && <CoverBanner cover={meta.cover} onChange={setCoverMenu} onRemove={() => setCover(undefined)} />}
        <header className="pg-head">
          {(!meta?.icon || !meta.cover) && (
            <div className="pg-add">
              {!meta?.icon && <Button size="sm" variant="ghost" data-testid="add-icon" icon={<Icon name="sparkles" size={14} />} onClick={e => setPicker(e.currentTarget.getBoundingClientRect())}>{t('Add icon')}</Button>}
              {!meta?.cover && <Button size="sm" variant="ghost" data-testid="add-cover" icon={<Icon name="image" size={14} />} onClick={e => setCoverMenu(e.currentTarget.getBoundingClientRect())}>{t('Add cover')}</Button>}
            </div>
          )}
          {picker && <Popover anchor={picker} onClose={() => setPicker(null)}><PageIconPicker current={meta?.icon} onPick={(e, close = true) => { void ws.setMeta(id, { icon: e }); if (close) setPicker(null) }} onClear={() => { void ws.setMeta(id, { icon: '' }); setPicker(null) }} /></Popover>}
          {coverMenu && <Popover anchor={coverMenu} onClose={() => setCoverMenu(null)}><CoverPicker page={meta!} onPick={setCover} onClose={() => setCoverMenu(null)} /></Popover>}
          <div className="pg-title-row" dir={dirOf(name)}>
            {meta?.icon && <button type="button" className="pg-icon" data-testid="page-icon" aria-label={t('Change icon')} title={t('Change icon')} onClick={e => setPicker(e.currentTarget.getBoundingClientRect())}><span className="pg-icon-glyph" style={isGlyph(meta.icon) ? { color: parseIcon(meta.icon).color ?? toneOf(id) } : undefined}>{iconNode(meta.icon, 40)}</span></button>}
            <h1 className="pg-print-title" dir={name.trim() ? 'auto' : undefined}>{name.trim() || t('Untitled')}</h1>
            <textarea
              className="pg-title" data-testid="title" rows={1} dir={name.trim() ? 'auto' : undefined} aria-label={t('Page title')} placeholder={t('Untitled')} value={name}
              ref={el => { titleInput.current = el; if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
              onChange={e => { const v = e.target.value.replace(/\n/g, ' '); setName(v); ws.setTitle(id, v) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); editor?.commands.focus('start') } }}
            />
          </div>
        </header>
        <ResponsiveProperties><PropertyList className="pg-props" label={t('Page properties')}>
          <PropertyRow icon={<Icon name="flag" size={16} />} label={t('Status')}><PageStatusChip status={meta?.status} onChange={st => void ws.setMeta(id, { status: st ?? '' })} /></PropertyRow>
          <PropertyRow icon={<Icon name="tag" size={16} />} label={t('Tags')}>
            {(meta?.tags ?? []).map(tag => <Tag key={tag} label={tag} onOpen={() => window.dispatchEvent(new CustomEvent('nevis:show-tag', { detail: tag }))} openLabel={t('Show pages with this tag')} onRemove={() => void ws.tagPageByName(id, tag, false)} removeLabel={t('Remove tag')} />)}
            {addingTag ? (
              <span className="ds-chip-field">
                <Icon name="tag" size={14} />
                <input
                  className="pg-tag-input" data-testid="tag-input" dir={tagDraft.trim() ? 'auto' : undefined} autoFocus value={tagDraft} aria-label={t('Tag name…')} placeholder={t('Tag name…')}
                  onChange={e => setTagDraft(e.target.value)}
                  onKeyDown={e => {
                    if ((e.key === 'Enter' || e.key === ',' || e.key === '،') && tagDraft.trim()) { e.preventDefault(); void ws.tagPageByName(id, tagDraft.replace(/^#+/, '').trim(), true); setTagDraft('') }
                    else if (e.key === 'Escape') { e.preventDefault(); setTagDraft(''); setAddingTag(false) }
                    else if (e.key === 'Backspace' && !tagDraft && (meta?.tags ?? []).length) void ws.tagPageByName(id, meta!.tags![meta!.tags!.length - 1]!, false)
                  }}
                  onBlur={() => { if (tagDraft.trim()) void ws.tagPageByName(id, tagDraft.replace(/^#+/, '').trim(), true); setTagDraft(''); setAddingTag(false) }}
                />
                {suggestions.length > 0 && (
                  <div className="ds-pop ds-menu ds-chip-field-list" role="listbox" aria-label={t('Tags')}>
                    {suggestions.map(x => (
                      <button key={x} type="button" role="option" aria-selected={false} className="ds-menu-item" onMouseDown={e => { e.preventDefault(); void ws.tagPageByName(id, x, true); setTagDraft('') }}>
                        <Icon name="tag" size={14} /><span className="ds-menu-label" dir="auto">{x}</span>
                      </button>
                    ))}
                  </div>
                )}
              </span>
            ) : (
              <ChipButton empty icon={<Icon name="plus" size={14} />} data-testid="add-tag" onClick={() => setAddingTag(true)}>{t('Add tag…')}</ChipButton>
            )}
          </PropertyRow>
          <PropertyRow icon={<Icon name="clock" size={16} />} label={t('Last edited')}>{ago(meta?.updatedAt ?? Date.now())}</PropertyRow>
        </PropertyList></ResponsiveProperties>
        {diverged && (
          <p role="alert" className="err" data-testid="too-large">
            {t('The last edit was too large and was not saved; nothing written after it is saved either.')} <button onClick={() => void ws.reopenDoc(id)}>{t('Reopen from the last saved version')}</button>
          </p>
        )}
        {outline}
        {editor && !reader && !diverged && editor.isEmpty && !editor.isFocused && (
          <div className="pg-starts" role="group" aria-label={t('Quick start with a template')}>
            <span>{t('Quick start with a template')}</span>
            {getTemplates().map((tp: Template) => (
              <Button key={tp.id} size="sm" variant="ghost" title={tp.desc} icon={<Glyph name={TEMPLATE_GLYPH[tp.id] ?? 'page'} size={14} />}
                onClick={() => { editor.commands.setContent(templateDoc(tp) as never); if (!name.trim()) { const v = tp.pageTitle.replace(/[\s—–-]+$/, ''); setName(v); ws.setTitle(id, v) } editor.commands.focus('start') }}>{tp.title}</Button>
            ))}
          </div>
        )}
        {editor && !reader && !diverged && <Toolbar editor={editor} />}
        {editor && !reader && !diverged && <LayoutControls editor={editor} />}
        {editor && <EditorMenus editor={editor} ws={ws} id={id} />}
        <div className="ec editor" data-testid="editor" ref={host} />
        {editor && !reader && !diverged && <><TableBubble editor={editor} /><ImageBubble editor={editor} /></>}
        <Backlinks ws={ws} id={id} />
      </div>
    </div>
  )
}
