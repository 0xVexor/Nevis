import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const TARGET = '.row, button.side-new'
const DELAY = 220

/** Icons-only sidebar: a label that opens beside the hovered entry, since its own text is hidden. */
export function SideTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; rtl: boolean } | null>(null)

  useEffect(() => {
    let timer = 0
    let target: Element | null = null // the entry whose label is pending or shown
    const hide = () => {
      window.clearTimeout(timer)
      target = null
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      if (document.documentElement.dataset.side !== 'icons' && !window.matchMedia('(max-width: 760px)').matches) return
      const el = (e.target as Element | null)?.closest?.(TARGET)
      const side = el?.closest('.side')
      if (!el || !side || el === target) return
      hide()
      const text = el.querySelector('.ntitle')?.textContent?.trim() || el.getAttribute('aria-label') || (el as HTMLElement).title || ''
      if (!text) return
      target = el
      timer = window.setTimeout(() => {
        if (!el.isConnected) return
        const r = el.getBoundingClientRect()
        const s = side.getBoundingClientRect()
        const rtl = getComputedStyle(side).direction === 'rtl'
        setTip({ text, x: rtl ? s.left - 8 : s.right + 8, y: r.top + r.height / 2, rtl })
      }, DELAY)
    }
    const out = (e: PointerEvent) => {
      const to = e.relatedTarget as Element | null
      // still inside the entry that is pending or shown (moving between its children): keep going
      if (to && target?.contains(to)) return
      hide()
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out)
    document.addEventListener('pointerdown', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', out)
      document.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  if (!tip) return null
  // portal: the sidebar clips and re-anchors fixed children (overflow, backdrop-filter)
  return createPortal(
    <div className={'side-tip' + (tip.rtl ? ' rtl' : '')} style={{ left: tip.x, top: tip.y }} dir="auto" role="tooltip">
      {tip.text}
    </div>,
    document.body,
  )
}
