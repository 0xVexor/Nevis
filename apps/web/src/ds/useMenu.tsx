import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Menu, type MenuItem } from './Menu'

type Target = DOMRect | HTMLElement | MouseEvent

export function contextMenuAnchor(event: MouseEvent): DOMRect {
  event.preventDefault()
  event.stopPropagation()
  if (!event.clientX && !event.clientY) {
    const active = document.activeElement
    return (active instanceof HTMLElement && event.currentTarget.contains(active) ? active : event.currentTarget).getBoundingClientRect()
  }
  return new DOMRect(event.clientX, event.clientY, 0, 0)
}

const rectOf = (target: Target): DOMRect => {
  if (target instanceof DOMRect) return target
  if ('getBoundingClientRect' in target) return target.getBoundingClientRect()
  return contextMenuAnchor(target)
}

/**
 * const { open, menu } = useMenu()
 * <button onClick={(e) => open(items, e.currentTarget)}>…</button>      // dropdown under a button
 * <div onContextMenu={(e) => { open(items, e) }}>   // context menu at the pointer
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
  return { open, close, menu, isOpen: state !== null }
}
