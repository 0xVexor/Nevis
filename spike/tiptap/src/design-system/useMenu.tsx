import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react'
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
  const trigger = useRef<HTMLElement | null>(null)
  const [state, setState] = useState<{ items: MenuItem[]; anchor: DOMRect; header?: ReactNode } | null>(null)
  const open = useCallback((items: MenuItem[], target: Target, header?: ReactNode) => {
    trigger.current = target instanceof HTMLElement ? target : document.activeElement instanceof HTMLElement ? document.activeElement : null
    setState({ items, anchor: rectOf(target), header })
  }, [])
  const close = useCallback(() => {
    setState(null)
    if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
  }, [])
  const menu: ReactNode = state ? <Menu anchor={state.anchor} items={state.items} header={state.header} onClose={close} /> : null
  return { open, close, menu }
}
