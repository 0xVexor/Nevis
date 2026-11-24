import { useRef } from 'react'
import { t } from './i18n'

const MIN_WIDTH = 120
const MAX_WIDTH = 1000
const clamp = (width: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)))

/** Resize from the inline end of a header, saving once when a drag finishes. */
export function ColumnResize({ name, width, onPreview, onCommit, onReset }: { name: string; width: number; onPreview: (width: number | null) => void; onCommit: (width: number) => void; onReset: () => void }) {
  const drag = useRef<{ x: number; width: number; direction: number; current: number } | null>(null)
  return <span className="dbtable-resize" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t('Resize column {name}', { name })} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={Math.round(width)} title={t('Drag to resize, double-click to reset')}
    onPointerDown={e => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.focus()
      const header = e.currentTarget.parentElement!
      const start = header.getBoundingClientRect().width
      drag.current = { x: e.clientX, width: start, direction: getComputedStyle(header).direction === 'rtl' ? -1 : 1, current: start }
      e.currentTarget.setPointerCapture(e.pointerId)
    }}
    onPointerMove={e => {
      if (!drag.current) return
      drag.current.current = clamp(drag.current.width + (e.clientX - drag.current.x) * drag.current.direction)
      onPreview(drag.current.current)
    }}
    onPointerUp={e => {
      if (!drag.current) return
      const current = drag.current.current
      const changed = current !== drag.current.width
      drag.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
      if (changed) onCommit(current); else onPreview(null)
    }}
    onPointerCancel={() => { drag.current = null; onPreview(null) }}
    onLostPointerCapture={() => { if (drag.current) { drag.current = null; onPreview(null) } }}
    onKeyDown={e => {
      if (e.key === 'Escape' && drag.current) { drag.current = null; onPreview(null); e.preventDefault(); return }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault(); e.stopPropagation()
      const direction = getComputedStyle(e.currentTarget).direction === 'rtl' ? -1 : 1
      onCommit(clamp(width + (e.key === 'ArrowRight' ? 1 : -1) * direction * (e.shiftKey ? 40 : 10)))
    }}
    onDoubleClick={e => { e.preventDefault(); onReset() }} />
}
