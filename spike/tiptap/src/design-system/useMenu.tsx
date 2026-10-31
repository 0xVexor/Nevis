import { useCallback, useState, type MouseEvent, type ReactNode } from 'react'
import { Menu, type MenuItem } from './Menu'

type Target = DOMRect | HTMLElement | MouseEvent

const rectOf = (target: Target): DOMRect => {
  if (target instanceof DOMRect) return target
  if ('getBoundingClientRect' in target) return target.getBoundingClientRect()
  return new DOMRect(target.clientX, target.clientY, 0, 0)
}

/**
 * const { open, menu } = useMenu()
 * <button onClick={(e) => open(items, e.currentTarget)}>…</button>      // dropdown under a button
 * <div onContextMenu={(e) => { e.preventDefault(); open(items, e) }}>   // context menu at the pointer
 * {menu}
 */
export function useMenu() {
  const [state, setState] = useState<{ items: MenuItem[]; anchor: DOMRect } | null>(null)
  const open = useCallback((items: MenuItem[], target: Target) => setState({ items, anchor: rectOf(target) }), [])
  const close = useCallback(() => setState(null), [])
  const menu: ReactNode = state ? <Menu anchor={state.anchor} items={state.items} onClose={close} /> : null
  return { open, close, menu }
}
