import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Keeps a fixed-position bar centered on top of an element of the page (a table, an image), pinned under the top of the scroll area
 * while that element scrolls past, and hidden once it is out of view. `deps` re-run the placement when the content changes shape.
 */
export function useAnchor(editor: any, open: boolean, getEl: () => HTMLElement | null, deps: unknown[] = []) {
  const box = useRef<HTMLDivElement>(null)
  const [, tick] = useState(0)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const el = box.current
      const target = getEl()
      const sc = document.querySelector('.scroller') as HTMLElement | null
      if (!el || !target || !sc) return
      const tr = target.getBoundingClientRect()
      const cr = sc.getBoundingClientRect()
      const w = el.offsetWidth
      const h = el.offsetHeight
      let top = tr.top - h - 12
      const minTop = cr.top + 8
      if (top < minTop) top = Math.min(minTop, tr.bottom - h - 8)
      const left = Math.min(Math.max(tr.left + tr.width / 2 - w / 2, cr.left + 8), Math.max(cr.left + 8, cr.right - w - 8))
      el.style.top = `${Math.round(top)}px`
      el.style.left = `${Math.round(left)}px`
      el.style.visibility = tr.bottom < cr.top || tr.top > cr.bottom ? 'hidden' : 'visible'
    }
    place()
    const sc = document.querySelector('.scroller')
    sc?.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    editor.on('transaction', place)
    const id = requestAnimationFrame(place)
    return () => {
      cancelAnimationFrame(id)
      sc?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
      editor.off('transaction', place)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editor, ...deps])
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => tick((n) => n + 1), 60) // second pass once the bar has its real size
    return () => window.clearTimeout(id)
  }, [open])
  return box
}
