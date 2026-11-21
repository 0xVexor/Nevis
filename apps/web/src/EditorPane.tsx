import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { createEditor } from '@nevis/editor'
import { Backlinks } from './views/Backlinks'
import { Button, Icon, PageIconPicker, Popover, PropertyList, PropertyRow, Tag, dirOf } from './ds'
import { CoverBanner, CoverPicker } from './shell/Cover'
import { PageStatusChip } from './shell/PageStatusChip'
import { iconNode } from './ds/iconSet'
import { legacyPages } from './shell/adapt'
import type { Cover } from './shell/model'
import { t } from './i18n'
import type { DocHandle } from '@nevis/core'
import type { Workspace } from './workspace'

/** One open page: title + body. The body is the Yjs document of the page; the title is a register. */
export function EditorPane({ ws, id, title }: { ws: Workspace; id: string; title: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'needs-update'>('loading')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [name, setName] = useState(title)
  useEffect(() => setName(title), [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let ed: Editor | null = null
    let handle: DocHandle | null = null
    let dead = false
    setState('loading'); setEditor(null)
    void ws.openDoc(id).then(h => {
      if (dead) return
      handle = h
      if (h.needsUpdate) { setState('needs-update'); return } // ADR-0003 §6: a newer schema is not edited by an older client
      ed = createEditor(h.ydoc, host.current!, { pages: () => ws.pageList(), onOpenPage: pid => ws.onOpenPage?.(pid), notify: m => ws.notify(m), attachments: ws.rt.attachments })
      const tpl = ws.takeTemplate(id)
      if (tpl && ed.isEmpty) ed.commands.setContent(tpl as never)
      ;(window as unknown as { __editor?: Editor }).__editor = ed
      setEditor(ed); setState('ready')
    })
    return () => { dead = true; ed?.destroy(); if (handle) void ws.closeDoc(id) }
  }, [ws, id])

  const meta = legacyPages(ws).find(p => p.id === id)
  const [picker, setPicker] = useState<DOMRect | null>(null)
  const [coverMenu, setCoverMenu] = useState<DOMRect | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const setCover = (c: Cover | undefined) => void ws.setMeta(id, { cover: c ? JSON.stringify(c) : null })
  const diverged = ws.diverged.has(id)
  useEffect(() => { editor?.setEditable(!diverged) }, [editor, diverged])
  if (state === 'needs-update') return <div className="page-cols"><div className="page"><p role="alert" className="pg-note" data-testid="needs-update">این صفحه با نسخهٔ تازه‌تری از برنامه ساخته شده؛ به‌روزرسانی لازم است.</p></div></div>
  return (
    <div className={'page-cols' + (meta?.cover ? ' has-cover' : '')}>
      <div className="page">
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
            {meta?.icon && <button type="button" className="pg-icon" data-testid="page-icon" aria-label={t('Change icon')} title={t('Change icon')} onClick={e => setPicker(e.currentTarget.getBoundingClientRect())}><span className="pg-icon-glyph">{iconNode(meta.icon, 40)}</span></button>}
            <textarea
              className="pg-title" data-testid="title" rows={1} dir={name.trim() ? 'auto' : undefined} aria-label={t('Page title')} placeholder={t('Untitled')} value={name}
              ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
              onChange={e => { const v = e.target.value.replace(/\n/g, ' '); setName(v); ws.setTitle(id, v) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); editor?.commands.focus('start') } }}
            />
          </div>
        </header>
        <PropertyList className="pg-props" label={t('Page properties')}>
          <PropertyRow icon={<Icon name="flag" size={16} />} label={t('Status')}><PageStatusChip status={meta?.status} onChange={st => void ws.setMeta(id, { status: st ?? '' })} /></PropertyRow>
          <PropertyRow icon={<Icon name="tag" size={16} />} label={t('Tags')}>
            {(meta?.tags ?? []).map(tag => <Tag key={tag} label={tag} onRemove={() => void ws.tagPageByName(id, tag, false)} removeLabel={t('Remove tag')} />)}
            <input className="pg-tag-input" data-testid="tag-input" dir="auto" value={tagDraft} placeholder={t('Add tag')} aria-label={t('Add tag')} onChange={e => setTagDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && tagDraft.trim()) { e.preventDefault(); void ws.tagPageByName(id, tagDraft.replace(/^#+/, ''), true); setTagDraft('') } }} />
          </PropertyRow>
        </PropertyList>
        {diverged && (
          <p role="alert" className="err" data-testid="too-large">
            آخرین ویرایش بیش از حد بزرگ بود و ذخیره نشد؛ هر چه بعد از آن نوشته شود هم ذخیره نمی‌شود. <button onClick={() => void ws.reopenDoc(id)}>باز کردن دوباره از آخرین نسخهٔ ذخیره‌شده</button>
          </p>
        )}
        <div className="ec editor" data-testid="editor" ref={host} />
        <Backlinks ws={ws} id={id} />
      </div>
    </div>
  )
}
