// Side peek / center peek of a row. The body is the app's normal page editor (or the drawing board for drawing pages), so every
// editor feature works here; the database properties are rendered above the body by PageView through RowProperties.
import { Suspense, useEffect, useRef, useState } from 'react'
import type { Id } from '../model/types.ts'
import type { DatabaseService } from '../service.ts'
import { repo } from '../../store'
import { BoardView } from '../../BoardView'
import { PageView, type SaveState } from '../../PageView'
import { t } from '../../i18n'
import * as Ic from '../../icons'

export function RowPeek({ svc, pageId, mode, onClose, onOpenFull, onSwitch, notify }: {
  svc: DatabaseService
  pageId: Id
  mode: 'side' | 'center'
  onClose: () => void
  onOpenFull: (id: Id) => void
  onSwitch: (m: 'side' | 'center') => void
  onNavigate: (id: Id) => void
  notify: (msg: string) => void
}) {
  const page = repo.getRaw(pageId)
  const [save, setSave] = useState<SaveState>('saved')
  const [, tick] = useState(0)
  const prev = useRef<Element | null>(null)
  useEffect(() => {
    prev.current = document.activeElement
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('[role="dialog"], .popover, .slash-menu, .db-pop') && onClose()
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      ;(prev.current as HTMLElement | null)?.focus?.() // selection and scroll of the table behind are untouched; focus returns to it
    }
  }, [onClose])
  useEffect(() => {
    const f = () => tick((x) => x + 1)
    window.addEventListener('external-change', f)
    return () => window.removeEventListener('external-change', f)
  }, [])
  if (!page || page.deletedAt) {
    return (
      <div className={'db-peek ' + mode} role="dialog" aria-modal="true" aria-label={t('Item')}>
        <div className="db-peek-bar"><button type="button" className="icon-btn" aria-label={t('Close')} onClick={onClose}><Ic.Close size={14} /></button></div>
        <div className="db-error-box">{t('This item is no longer here.')}</div>
      </div>
    )
  }
  void svc
  void notify
  return (
    <div className={'db-peek-wrap ' + mode} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'db-peek ' + mode} role="dialog" aria-modal="true" aria-label={page.title || t('Untitled')}>
        <div className="db-peek-bar">
          <button type="button" className="icon-btn" aria-label={t('Close')} title={t('Close  Esc')} onClick={onClose}><Ic.Close size={14} /></button>
          <button type="button" className="icon-btn" aria-label={t('Open as full page')} title={t('Open as full page')} onClick={() => onOpenFull(pageId)}><Ic.Enlarge size={14} /></button>
          <button type="button" className="icon-btn" aria-label={mode === 'side' ? t('Open in the center') : t('Open on the side')} title={mode === 'side' ? t('Open in the center') : t('Open on the side')} onClick={() => onSwitch(mode === 'side' ? 'center' : 'side')}><Ic.Panel size={14} /></button>
          <span className="spacer" />
          <span className={'status' + (save === 'saving' ? ' busy' : '')}><i className="dot" />{save === 'saving' ? t('Saving…') : t('Saved')}</span>
        </div>
        <div className="db-peek-body">
          <Suspense fallback={<div className="page-skeleton" aria-busy="true" />}>
            {page.kind === 'board' ? (
              <BoardView key={page.id} page={page} onSave={setSave} onMeta={() => tick((x) => x + 1)} />
            ) : (
              <PageView key={page.id} page={page} onSave={setSave} onMeta={() => tick((x) => x + 1)} onCover={() => {}} />
            )}
          </Suspense>
        </div>
      </div>
    </div>
  )
}
