import { useRef } from 'react'
import { t } from './text'

export function ResizeHandle({ label, width, min, max, onResize }: {
  label: string
  width: number
  min: number
  max: number
  onResize: (width: number | null) => void
}) {
  const drag = useRef<{ edge: number; rtl: boolean } | null>(null)
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)))
  return (
    <div
      className="side-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      title={t('Drag to resize, double-click to reset')}
      tabIndex={0}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(event) => {
        if (event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        event.preventDefault()
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
        const grow = (event.key === 'ArrowRight') !== rtl
        onResize(clamp(width + (grow ? 16 : -16)))
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const region = event.currentTarget.parentElement!
        const rtl = getComputedStyle(region).direction === 'rtl'
        const bounds = region.getBoundingClientRect()
        drag.current = { rtl, edge: rtl ? bounds.right : bounds.left }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        const { edge, rtl } = drag.current
        onResize(clamp(rtl ? edge - event.clientX : event.clientX - edge))
      }}
      onLostPointerCapture={() => { drag.current = null }}
    />
  )
}
