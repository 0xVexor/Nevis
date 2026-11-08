import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MOTION, prefersReducedMotion } from './motion'

/** Fixed-position popover anchored to a rect; closes on outside click / Escape. Arrow keys / Home / End move through its items. */
export function Popover({ anchor, onClose, children, align = 'start' }: { anchor: DOMRect; onClose: () => void; children: ReactNode; align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [leaving, setLeaving] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; maxH?: number }>({ top: anchor.bottom + 6, left: anchor.left })

  // Placed under the anchor (above it when there is no room) and kept in view while its content grows or shrinks:
  // a tall popover scrolls inside itself instead of running off the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const w = el.offsetWidth
      const h = el.scrollHeight + 2
      const below = window.innerHeight - anchor.bottom - 14
      const above = anchor.top - 14
      let left = align === 'end' ? anchor.right - w : anchor.left
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      let top: number
      let maxH: number | undefined
      if (h <= below) top = anchor.bottom + 6
      else if (h <= above) top = anchor.top - h - 6
      else if (Math.max(below, above) < 200) ((top = 8), (maxH = window.innerHeight - 16))
      else if (below >= above) ((top = anchor.bottom + 6), (maxH = below))
      else ((top = anchor.top - 6 - above), (maxH = above))
      setPos((p) => (p.top === top && p.left === left && p.maxH === maxH ? p : { top, left, maxH }))
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => (ro.disconnect(), window.removeEventListener('resize', place))
  }, [anchor, align])

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    // closing by outside click or Escape plays a short exit first; picking an item closes at once
    let exit = 0
    const dismiss = () => {
      if (prefersReducedMotion()) return close.current()
      setLeaving(true)
      exit = window.setTimeout(() => close.current(), MOTION.fast * 1000)
    }
    // a menu opened from inside this popover (a dropdown in a panel) is a popover of its own: using it keeps this one open,
    // and Escape or the arrow keys belong to the popover on top
    const onTop = () => { const all = document.querySelectorAll('.ds-pop'); return all[all.length - 1] === ref.current }
    const down = (e: MouseEvent) => {
      const target = e.target as Element
      if (ref.current?.contains(target)) return
      const layer = target.closest?.('.ds-pop, .ds-modal-layer, .ds-scrim')
      if (layer && ref.current && ref.current.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) return
      dismiss()
    }
    const key = (e: KeyboardEvent) => {
      if (!onTop()) return
      if (e.key === 'Escape') return dismiss()
      // items of a closed submenu are hidden, so only what is on screen is reachable by the arrow keys
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('.ds-menu-item:not(:disabled), [data-menu-item]') ?? [])].filter((item) => item.offsetParent !== null)
      if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1
      items[n].focus()
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      window.clearTimeout(exit)
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      className="ds-pop"
      data-leaving={leaving ? '' : undefined}
      style={{ position: 'fixed', zIndex: 'var(--ds-z-float)', top: pos.top, left: pos.left, ...(pos.maxH ? { maxHeight: pos.maxH, overflowY: 'auto' } : null) }}
    >
      {children}
    </div>,
    document.body,
  )
}
