import { useEffect, type RefObject } from 'react'
import { DEFAULTS, getSettings, updateSettings } from '../settings'

/** The editor text size range, shared with the Text size slider in Settings. */
export const TEXT_SIZE_MIN = 12
export const TEXT_SIZE_MAX = 28

const clamp = (n: number) => Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, n))
const zoom = (step: number) => {
  const now = getSettings().fontSize
  const next = step === 0 ? DEFAULTS.fontSize : clamp(now + step)
  if (next !== now) updateSettings({ fontSize: next })
}

/** Physical keys, so the shortcut works on a Persian keyboard too: Ctrl + = / + bigger, Ctrl + - smaller, Ctrl + 0 back to normal. */
const STEP: Record<string, number> = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0, Numpad0: 0 }
/** The typed character, for a keyboard that reports no physical key. */
const BY_KEY: Record<string, number> = { '=': 1, '+': 1, '-': -1, '0': 0 }

/**
 * Ctrl (⌘) with + / - / 0 or the mouse wheel changes the page text size while a page is open, instead of zooming the
 * whole window. It is the same setting as Settings → Text size, so the choice is kept.
 */
export function useTextZoom(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    // looked up on each event: the page element appears only once its editor is ready
    const area = () => root.current?.closest<HTMLElement>('.scroller') ?? root.current
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const step = e.code ? STEP[e.code] : BY_KEY[e.key]
      if (step === undefined) return
      // only while the page has the focus (or nothing does): a dialog or another field keeps its own keys
      const host = area()
      const active = document.activeElement
      if (!host || (active && active !== document.body && !host.contains(active))) return
      e.preventDefault()
      zoom(step)
    }
    // a mouse notch is one step; a touchpad pinch sends many small deltas, so they are added up first
    let acc = 0
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.deltaY || !(e.target instanceof Node && area()?.contains(e.target))) return
      e.preventDefault()
      acc += e.deltaY
      if (Math.abs(acc) < 40) return
      zoom(acc < 0 ? 1 : -1)
      acc = 0
    }
    window.addEventListener('keydown', key)
    window.addEventListener('wheel', wheel, { passive: false })
    return () => (window.removeEventListener('keydown', key), window.removeEventListener('wheel', wheel))
  }, [root])
}
