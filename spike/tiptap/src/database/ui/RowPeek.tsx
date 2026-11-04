// Side peek / center peek of a row. The body is the app's normal page editor (or the drawing board for drawing pages), so every
// editor feature works here; the database properties are rendered above the body by PageView through RowProperties.
import { Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import type { Id } from '../model/types.ts'
import { repo } from '../../store'
import { BoardView } from '../../BoardView'
import { PageView, type SaveState } from '../../PageView'
import { Icon, IconButton, SaveStatus, useUIMotion } from '../../design-system'
import { t } from '../../i18n'
import { ViewMessage } from './common'

export function RowPeek({
  pageId,
  mode,
  onClose,
  onOpenFull,
  onSwitch,
}: {
  pageId: Id
  mode: 'side' | 'center'
  onClose: () => void
  onOpenFull: (id: Id) => void
  onSwitch: (m: 'side' | 'center') => void
}) {
  const page = repo.getRaw(pageId)
  const [save, setSave] = useState<SaveState>('saved')
  const [, tick] = useState(0)
  const uiMotion = useUIMotion()
  const prev = useRef<Element | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])
  useEffect(() => {
    prev.current = document.activeElement
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.ds-pop, .ds-modal, .slash-menu')) return
      if ((e.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return
      closeRef.current()
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      ;(prev.current as HTMLElement | null)?.focus?.({ preventScroll: true }) // selection and scroll of the view behind are untouched; focus returns to it
    }
  }, [])
  useEffect(() => {
    const f = () => tick((x) => x + 1)
    window.addEventListener('external-change', f)
    return () => window.removeEventListener('external-change', f)
  }, [])
  const gone = !page || page.deletedAt
  const enter = mode === 'side' ? { opacity: 0, x: document.documentElement.dir === 'rtl' ? -24 : 24 } : { opacity: 0, y: 12, scale: 0.985 }
  // portalled to <body>: inside the page, an ancestor with a transform or filter would make "fixed" relative to it and the peek would open inside the page frame
  return createPortal(
    <div className="dv-peek-layer" data-mode={mode} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div
        className="dv-peek"
        data-mode={mode}
        role="dialog"
        aria-modal="true"
        aria-label={gone ? t('Item') : page.title || t('Untitled')}
        initial={uiMotion.reduced ? false : enter}
        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
        transition={uiMotion.transition}
      >
        <div className="dv-peek-bar">
          <IconButton label={t('Close (Esc)')} onClick={onClose}>
            <Icon name="x" size={16} />
          </IconButton>
          {!gone && (
            <>
              <IconButton label={t('Open as full page')} onClick={() => onOpenFull(pageId)}>
                <Icon name="maximize" size={16} />
              </IconButton>
              <IconButton label={mode === 'side' ? t('Open in the center') : t('Open on the side')} onClick={() => onSwitch(mode === 'side' ? 'center' : 'side')}>
                <Icon name={mode === 'side' ? 'minimize' : 'panel-right'} size={16} />
              </IconButton>
              <span className="dv-peek-status">
                <SaveStatus state={save} label={save === 'saving' ? t('Saving…') : t('Saved')} />
              </span>
            </>
          )}
        </div>
        {gone ? (
          <div className="dv-peek-body">
            <ViewMessage title={t('This item is no longer here.')} />
          </div>
        ) : (
          <div className="dv-peek-body scroller">
            <Suspense fallback={<div className="page-skeleton" aria-busy="true" />}>
              {page.kind === 'board' ? (
                <BoardView key={page.id} page={page} onSave={setSave} onMeta={() => tick((x) => x + 1)} />
              ) : (
                <PageView key={page.id} page={page} onSave={setSave} onMeta={() => tick((x) => x + 1)} onCover={() => {}} />
              )}
            </Suspense>
          </div>
        )}
      </motion.div>
    </div>,
    document.body,
  )
}
