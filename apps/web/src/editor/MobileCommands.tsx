import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { t } from '../i18n'
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
    const update = () => setKeyboardOffset(viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0)
    const menu = () => setMenuOpen(!!document.querySelector('.slash-menu'))
    update(); menu()
    const observer = new MutationObserver(menu)
    observer.observe(document.body, { childList: true })
    viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update) }
  }, [focused, narrow])
  useEffect(() => {
    if (!focused || keyboardOffset < 100 || !narrow) return
    document.documentElement.setAttribute('data-mobile-keyboard', '')
    return () => document.documentElement.removeAttribute('data-mobile-keyboard')
  }, [focused, keyboardOffset, narrow])
  if (!narrow || !focused || menuOpen || editor.isDestroyed || !editor.isEditable) return null
  return createPortal(<button type="button" className="mobile-commands" data-testid="mobile-commands" aria-label={t('Commands')}
    style={{ bottom: keyboardOffset >= 100 ? `${keyboardOffset + 8}px` : undefined }}
    onPointerDown={event => event.preventDefault()}
    onClick={() => { if (!document.querySelector('.slash-menu')) openCommandPalette(editor, allowedCommands) }}>/ <span>{t('Commands')}</span></button>, document.body)
}
