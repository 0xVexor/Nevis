import { useEffect, useMemo, useRef, useState } from 'react'
import { isTauri, listConflicts, openConflictFiles, type Version } from './db'
import { repo } from './store'
import { docToHtml, hydrate } from './render'
import { t } from './i18n'
import * as Ic from './icons'

function VersionPreview({ content }: { content: unknown }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => docToHtml(content), [content])
  useEffect(() => { if (ref.current) void hydrate(ref.current).catch(() => {}) }, [html])
  return <div ref={ref} className="tiptap" onClick={e => { if ((e.target as Element).closest('a')) e.preventDefault() }} dangerouslySetInnerHTML={{ __html: html }} />
}

/** A workspace-wide entry point, including versions belonging to deleted pages. */
export function Conflicts({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Version[] | null>(null)
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const dialog = useRef<HTMLDivElement>(null)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => () => {
    if (dialog.current?.isConnected) return
    const target = previousFocus.current?.isConnected ? previousFocus.current : document.querySelector<HTMLElement>('.conflicts-trigger')
    target?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    let active = true
    setError('')
    void listConflicts().then(versions => {
      if (active) { setRows(versions); setSelected(0) }
    }, e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [reload])
  const saved = rows?.[selected]
  const current = saved ? repo.get(saved.pageId) : undefined
  return <div className="overlay" onMouseDown={onClose}>
    <div ref={dialog} className="modal conflicts-modal" role="dialog" aria-modal="true" aria-label={t('Saved conflicts')} onMouseDown={e => e.stopPropagation()} onKeyDown={e => {
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab') {
        const controls = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length)
        const first = controls[0], last = controls[controls.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}>
      <div className="modal-head">
        <div><b>{t('Saved conflicts')}</b><small>{t('Compare the current page with each version kept during a sync conflict. Nothing is overwritten here.')}</small></div>
        <button className="icon-btn" onClick={onClose} title={t('Close')} autoFocus><Ic.Close size={16} /></button>
      </div>
      <div className="conflicts-actions">
        <button className="ghost-btn" onClick={() => setReload(n => n + 1)}>{t('Refresh')}</button>
        {isTauri && <button className="ghost-btn" onClick={() => { void openConflictFiles().catch(e => setError(t(String(e)))) }}>{t('Open recovered files')}</button>}
        <small>{t('Saved page conflicts also appear in each page’s Version history.')}</small>
      </div>
      {error && <p className="conflicts-error" role="alert" dir="auto">{error}</p>}
      <div className="conflicts-body">
        <div className="hist-list">
          {rows === null ? !error && <p>{t('Loading…')}</p> : !rows.length ? <p>{t('No saved page conflicts in this workspace. Recovered non-page files can be opened separately.')}</p> : rows.map((version, i) => <button key={`${version.pageId}:${version.ts}:${i}`} className={'hist-row' + (selected === i ? ' sel' : '')} onClick={() => setSelected(i)}>
            <b dir="auto">{version.title || t('Untitled')}</b>
            <small>{t('Saved conflict')} · {new Date(version.ts).toLocaleString()}</small>
          </button>)}
        </div>
        {saved && <div className="conflicts-comparison">
          <section><h3>{t('Current version')}</h3>
            {current ? <><h4 dir="auto">{current.title || t('Untitled')}</h4><VersionPreview content={current.content} /><details><summary>{t('Page properties')}</summary><pre dir="ltr">{JSON.stringify(current, null, 2)}</pre></details>
              {!current.deletedAt && current.kind !== 'folder' && <button className="ghost-btn" onClick={() => { onOpen(current.id); onClose() }}>{t('Open page')}</button>}</>
              : <p>{t('The current page is no longer present. The saved conflict below is still available.')}</p>}
          </section>
          <section><h3>{t('Saved conflict')}</h3><h4 dir="auto">{saved.title || t('Untitled')}</h4><VersionPreview content={saved.content} />
            <details><summary>{t('Page properties')}</summary><pre dir="ltr">{JSON.stringify(saved.page ?? saved, null, 2)}</pre></details>
          </section>
        </div>}
      </div>
    </div>
  </div>
}
