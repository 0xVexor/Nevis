import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { t } from '../i18n'
import { Icon } from '../ds'
import { openCommandPalette } from './commandPalette'

/** A small web accessory; the browser controls the actual keyboard and its geometry. */
export function MobileCommands({ editor, allowedCommands }: { editor: Editor; allowedCommands?: readonly string[] }) {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches)
  const [focused, setFocused] = useState(editor.isFocused)
  const [keyboardOffset, setKeyboardOffset] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const focus = () => setFocused(true)
    const blur = () => setFocused(false)
    editor.on('focus', focus); editor.on('blur', blur)
    return () => { editor.off('focus', focus); editor.off('blur', blur) }
  }, [editor])
  useEffect(() => {
    if (!focused || !narrow) return
    const viewport = window.visualViewport
    const update = () => setKeyboardOffset(viewport && viewport.scale <= 1.05 ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0)
    const menu = () => setMenuOpen(!!document.querySelector('.slash-menu'))
    update(); menu()
    const observer = new MutationObserver(menu)
    observer.observe(document.body, { childList: true })
    viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update) }
  }, [focused, narrow])
  const keyboardOpen = keyboardOffset >= 100
  useEffect(() => {
    if (!focused || !keyboardOpen || !narrow) return
    document.documentElement.setAttribute('data-mobile-keyboard', '')
    return () => document.documentElement.removeAttribute('data-mobile-keyboard')
  }, [focused, keyboardOpen, narrow])
  useEffect(() => {
    if (!narrow || !focused || !keyboardOpen || menuOpen) return
    let gesture: { x: number; y: number; id: number; cancelled: boolean } | null = null
    const start = (event: TouchEvent) => {
      const target = event.target
      if (event.touches.length !== 1 || !(target instanceof Element) || !target.closest('.scroller, .dv-peek-body') ||
          target.closest('table, .tableWrapper, .slash-menu, .ds-pop, .toolbar, button, input, textarea, select, a, [role="dialog"]:not(.dv-peek-layer)')) { gesture = null; return }
      const touch = event.touches[0]!
      gesture = { x: touch.clientX, y: touch.clientY, id: touch.identifier, cancelled: false }
    }
    const move = (event: TouchEvent) => { if (gesture && event.touches.length !== 1) gesture.cancelled = true }
    const end = (event: TouchEvent) => {
      const active = gesture
      gesture = null
      if (!active || active.cancelled || event.touches.length || editor.isDestroyed || editor.view.composing || !window.getSelection()?.isCollapsed) return
      const touch = [...event.changedTouches].find(item => item.identifier === active.id)
      if (!touch) return
      const dx = Math.abs(touch.clientX - active.x), dy = Math.abs(touch.clientY - active.y)
      if (dy >= 70 && dy > dx * 1.5 && !document.querySelector('.slash-menu')) editor.commands.blur()
    }
    const cancel = () => { gesture = null }
    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: true })
    document.addEventListener('touchend', end, { passive: true })
    document.addEventListener('touchcancel', cancel, { passive: true })
    return () => { document.removeEventListener('touchstart', start); document.removeEventListener('touchmove', move); document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', cancel) }
  }, [editor, narrow, focused, keyboardOpen, menuOpen])
  if (!narrow || !focused || !keyboardOpen || menuOpen || editor.isDestroyed || !editor.isEditable) return null
  return createPortal(<div className="mobile-commands" data-testid="mobile-keyboard-bar" style={{ bottom: `${keyboardOffset}px` }}>
    <button type="button" data-testid="mobile-commands" aria-label={t('Commands')}
      onPointerDown={event => event.preventDefault()}
      onClick={() => { if (!document.querySelector('.slash-menu')) openCommandPalette(editor, allowedCommands) }}><span className="mobile-command-key">/</span><span>{t('Commands')}</span></button>
    <button type="button" data-testid="dismiss-keyboard" aria-label={t('Hide keyboard')} onPointerDown={event => event.preventDefault()} onClick={() => editor.commands.blur()}><Icon name="keyboard" size={20} /><Icon name="chevron-down" size={14} /><span>{t('Hide keyboard')}</span></button>
  </div>, document.body)
}
