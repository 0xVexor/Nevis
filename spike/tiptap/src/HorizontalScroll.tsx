import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { t } from './i18n'

/** A horizontal viewport with a matching native rail that stays inside its section while the page scrolls. */
export function HorizontalScroll({ children, className = '', viewportClassName = '', viewportRef, viewportProps = {}, label, followVisibleBottom = false }: {
  children: ReactNode
  className?: string
  viewportClassName?: string
  viewportRef?: RefObject<HTMLDivElement | null>
  viewportProps?: HTMLAttributes<HTMLDivElement> & { 'data-density'?: string }
  label?: string
  followVisibleBottom?: boolean
}) {
  const section = useRef<HTMLDivElement>(null)
  const local = useRef<HTMLDivElement>(null)
  const viewport = viewportRef ?? local
  const content = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = viewport.current, bar = rail.current, inner = content.current
    if (!el || !bar || !inner) return
    let frame = 0
    const measure = () => {
      setWidth(el.scrollWidth)
      setOverflow(el.scrollWidth > el.clientWidth + 1)
      bar.scrollLeft = el.scrollLeft
    }
    // One source of truth in either direction, including the browser's negative RTL scroll offsets.
    const fromViewport = () => { if (Math.abs(bar.scrollLeft - el.scrollLeft) > 1) bar.scrollLeft = el.scrollLeft }
    const fromRail = () => { if (Math.abs(el.scrollLeft - bar.scrollLeft) > 1) el.scrollLeft = bar.scrollLeft }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const ro = new ResizeObserver(schedule)
    ro.observe(el); ro.observe(inner)
    const mo = new MutationObserver(schedule)
    mo.observe(inner, { childList: true, subtree: true, attributes: true, characterData: true })
    el.addEventListener('scroll', fromViewport, { passive: true })
    bar.addEventListener('scroll', fromRail, { passive: true })
    measure()
    return () => {
      cancelAnimationFrame(frame); ro.disconnect(); mo.disconnect()
      el.removeEventListener('scroll', fromViewport); bar.removeEventListener('scroll', fromRail)
    }
  }, [viewport])
  // Keep the Pages rail within the visible slice of its section. Its vertical
  // position follows the sidebar scrollport, rather than the end of the list.
  useLayoutEffect(() => {
    if (!followVisibleBottom || !overflow) return
    const host = section.current, bar = rail.current
    if (!host || !bar) return
    let scrollport = host.parentElement
    while (scrollport && !/(auto|scroll)/.test(getComputedStyle(scrollport).overflowY)) scrollport = scrollport.parentElement
    let frame = 0
    const position = () => {
      const bounds = host.getBoundingClientRect()
      const clip = scrollport?.getBoundingClientRect()
      const top = Math.max(0, clip ? clip.top + scrollport!.clientTop : 0)
      const bottom = Math.min(window.innerHeight, clip ? clip.top + scrollport!.clientTop + scrollport!.clientHeight : window.innerHeight)
      const height = bar.offsetHeight
      const visible = Math.min(bounds.bottom, bottom) - Math.max(bounds.top, top) >= height
      bar.style.visibility = visible ? 'visible' : 'hidden'
      bar.style.top = Math.max(0, Math.min(bounds.height - height, bottom - bounds.top - height)) + 'px'
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position) }
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    if (scrollport) observer.observe(scrollport)
    // Capture nested scrolling without changing which element owns vertical scroll.
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    position()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      bar.style.removeProperty('top')
      bar.style.removeProperty('visibility')
    }
  }, [followVisibleBottom, overflow])
  return <div ref={section} className={'hscroll ' + className + (followVisibleBottom ? ' hscroll-follow' : '')}>
    <div {...viewportProps} ref={viewport} className={'hscroll-viewport ' + viewportClassName}>
      <div ref={content} className="hscroll-content">{children}</div>
    </div>
    <div ref={rail} className="hscroll-rail" hidden={!overflow} tabIndex={overflow ? 0 : -1} role="region" aria-label={label ? t('Horizontal scroll') + ': ' + label : t('Horizontal scroll')}>
      <div style={{ width, height: 1 }} />
    </div>
  </div>
}
