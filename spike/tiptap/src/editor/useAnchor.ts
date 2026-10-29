import { useLayoutEffect, useRef } from 'react'
import { LAYOUT_INTERACTION, layoutInteractionBusy } from './layoutInteraction'

/** Editor-local floating tools never cover block chrome or intercept a layout interaction. */
export function useAnchor(editor: any, open: boolean, getEl: () => HTMLElement | null, deps: unknown[] = []) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open || editor.isDestroyed) return
    const root: HTMLElement = editor.view.dom
    const sc = root.closest<HTMLElement>('.scroller')
    let frame = 0
    let observer: ResizeObserver | null = null
    let observed: HTMLElement | null = null
    const hide = () => {
      if (box.current) { box.current.style.visibility = 'hidden'; box.current.style.pointerEvents = 'none' }
    }
    const place = () => {
      frame = 0
      if (editor.isDestroyed) { hide(); return }
      const el = box.current, target = getEl()
      if (!el || !target || !sc || editor.isDestroyed || layoutInteractionBusy(root)) { hide(); return }
      if (observer && target !== observed) {
        if (observed) observer.unobserve(observed)
        observer.observe(target); observed = target
      }
      const r = target.getBoundingClientRect(), cr = sc.getBoundingClientRect()
      const viewportTop = Math.max(0, cr.top), viewportBottom = Math.min(innerHeight, cr.bottom)
      if (r.bottom <= viewportTop || r.top >= viewportBottom || !r.width || !r.height) { hide(); return }
      el.style.maxWidth = `${Math.max(120, Math.min(860, cr.width - 16))}px`
      const w = el.offsetWidth, h = el.offsetHeight
      const toolbar = root.closest('.page')?.querySelector<HTMLElement>('.toolbar')?.getBoundingClientRect()
      const minTop = Math.max(viewportTop + 8, (toolbar?.bottom ?? 0) + 8)
      const left = Math.max(cr.left + 8, Math.min(r.left + r.width / 2 - w / 2, cr.right - w - 8))
      const caps = Array.from(root.querySelectorAll<HTMLElement>('[data-layout-drag-surface]'))
        .map((surface) => surface.getBoundingClientRect())
        .filter((cap) => cap.width && cap.height && cap.bottom > viewportTop && cap.top < viewportBottom)
      const candidates = [r.top - h - 12, r.bottom + 12, minTop, viewportBottom - h - 8,
        ...caps.flatMap((cap) => [cap.top - h - 8, cap.bottom + 8])]
      const top = candidates.find((y) => y >= minTop && y + h <= viewportBottom - 8
        && !caps.some((cap) => left < cap.right + 4 && left + w > cap.left - 4 && y < cap.bottom + 6 && y + h > cap.top - 6))
      if (top == null) { hide(); return }
      el.style.top = `${Math.round(top)}px`; el.style.left = `${Math.round(left)}px`
      el.style.visibility = 'visible'; el.style.pointerEvents = 'auto'
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }
    const interaction = () => {
      // Synchronous suppression matters: pointer capture must win before a toolbar can intercept it.
      if (layoutInteractionBusy(root)) hide()
      else schedule()
    }
    place()
    observer = new ResizeObserver(schedule)
    if (box.current) observer.observe(box.current)
    const target = getEl()
    if (target) { observer.observe(target); observed = target }
    if (sc) observer.observe(sc)
    sc?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    root.addEventListener(LAYOUT_INTERACTION, interaction)
    editor.on('transaction', schedule)
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect()
      sc?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      root.removeEventListener(LAYOUT_INTERACTION, interaction)
      editor.off('transaction', schedule)
    }
    // The caller passes the node identity/attributes in deps; event callbacks resolve the current DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editor, ...deps])
  return box
}
