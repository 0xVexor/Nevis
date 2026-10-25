import { useEffect, useMemo, useState } from 'react'
import { allDrawings, type DrawingInfo } from './drawingData'
import { urlFor } from './attachments'
import { warmDrawing } from './editor/excalidraw'
import { t } from './i18n'
import * as Ic from './icons'

type Filter = 'all' | 'board' | 'inline'

function Thumb({ preview }: { preview: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (preview) void urlFor('att:' + preview).then((u) => live && setUrl(u))
    return () => void (live = false)
  }, [preview])
  return url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span className="dw-blank"><Ic.Pencil size={28} /></span>
}

/** Every drawing in one place: whole-page boards and drawing blocks inside pages. */
export function Drawings({ onOpen, onNew, onDelete }: { onOpen: (id: string) => void; onNew: () => void; onDelete: (d: DrawingInfo) => void }) {
  const [tick, setTick] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    window.addEventListener('data-changed', bump)
    window.addEventListener('external-change', bump)
    return () => (window.removeEventListener('data-changed', bump), window.removeEventListener('external-change', bump))
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(allDrawings, [tick])
  const q = query.trim().toLowerCase()
  const shown = all.filter((d: DrawingInfo) => (filter === 'all' || d.source === filter) && (!q || (d.title || t('Untitled')).toLowerCase().includes(q)))
  const boards = all.filter((d) => d.source === 'board').length

  return (
    <div className="tk dw">
      <header className="tk-head">
        <h1><Ic.Pencil size={26} />{t('Drawings')}</h1>
        <p>{all.length ? t('{n} drawings · {b} boards', { n: all.length, b: boards }) : t('Boards and drawings from your pages appear here.')}</p>
      </header>

      <div className="dw-tools">
        <div className="tk-tabs" role="tablist">
          {(['all', 'board', 'inline'] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? t('All') : f === 'board' ? t('Boards') : t('In pages')}
            </button>
          ))}
        </div>
        <input className="dw-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search drawings…')} dir="auto" />
        <button className="primary" onPointerEnter={warmDrawing} onFocus={warmDrawing} onClick={onNew}><Ic.Plus size={15} />{t('New board')}</button>
      </div>

      {shown.length === 0 ? (
        <div className="hm-empty">
          {all.length ? t('No drawings match') : t('No drawings yet')}
          {!all.length && <div><button className="primary" onClick={onNew}>{t('New board')}</button></div>}
        </div>
      ) : (
        <div className="dw-grid">
          {shown.map((d) => (
            <div key={d.key} className="dw-item">
              <button className="dw-card" onClick={() => onOpen(d.pageId)}>
                <span className="dw-thumb"><Thumb preview={d.preview} /></span>
                <span className="dw-meta">
                  <b dir="auto">{d.title || t('Untitled')}</b>
                  <small>{d.source === 'board' ? t('Board') : t('In page')} · {new Date(d.updatedAt).toLocaleDateString()}</small>
                </span>
              </button>
              <button className="dw-del" title={t('Delete')} aria-label={t('Delete')} onClick={() => onDelete(d)}><Ic.Trash size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
