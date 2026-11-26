import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { t } from '../i18n'
import { Icon } from '../ds'
import { runEditorCommand } from './commandPalette'
import { paletteItems, shownItem } from './slash'
import { commandIconName, ICON_PREFIX } from './menuIcons'

/** A small web accessory; the browser controls the actual keyboard and its geometry. */
export function MobileCommands({ editor, allowedCommands, titleInput }: { editor: Editor; allowedCommands?: readonly string[]; titleInput?: HTMLInputElement | HTMLTextAreaElement | null }) {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches)
  const [editorFocused, setEditorFocused] = useState(editor.isFocused)
  const [titleFocused, setTitleFocused] = useState(() => !!titleInput && document.activeElement === titleInput)
  const [keyboardOffset, setKeyboardOffset] = useState(0)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const restingViewport = useRef({ width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight })
  const focused = editorFocused || titleFocused
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const focus = () => setEditorFocused(true)
    const blur = () => setEditorFocused(false)
    editor.on('focus', focus); editor.on('blur', blur)
    return () => { editor.off('focus', focus); editor.off('blur', blur) }
  }, [editor])
  useEffect(() => {
    if (!titleInput) return
    const focus = () => setTitleFocused(true)
    const blur = () => setTitleFocused(false)
    setTitleFocused(document.activeElement === titleInput)
    titleInput.addEventListener('focus', focus)
    titleInput.addEventListener('blur', blur)
    return () => { titleInput.removeEventListener('focus', focus); titleInput.removeEventListener('blur', blur) }
  }, [titleInput])
  useEffect(() => {
    if (!narrow) return
    const viewport = window.visualViewport
    const update = () => {
      const visibleHeight = viewport?.height ?? window.innerHeight
      const scale = viewport?.scale || 1
      const unscaled = scale <= 1.05
      if (unscaled && Math.abs(window.innerWidth - restingViewport.current.width) > 40) {
        restingViewport.current = { width: window.innerWidth, height: visibleHeight }
      } else if (unscaled && !focused && visibleHeight > restingViewport.current.height) {
        restingViewport.current.height = visibleHeight
      }
      const heightLost = Math.max(window.innerHeight, restingViewport.current.height) / scale - visibleHeight
      setKeyboardOpen(focused && heightLost >= 100)
      setKeyboardOffset(viewport ? Math.max(0, window.innerHeight - visibleHeight - viewport.offsetTop) : 0)
    }
    const menu = () => setMenuOpen(!!document.querySelector('.slash-menu'))
    update(); menu()
    const observer = new MutationObserver(menu)
    observer.observe(document.body, { childList: true })
    viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update) }
  }, [focused, narrow])
  const showAccessory = focused && (keyboardOpen || ios)
  useEffect(() => { if (!narrow || !showAccessory || menuOpen) setChoosing(false) }, [narrow, showAccessory, menuOpen])
  useEffect(() => {
    if (!choosing) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setChoosing(false) } }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [choosing])
  useEffect(() => {
    if (!focused || !keyboardOpen || !narrow) return
    document.documentElement.setAttribute('data-mobile-keyboard', '')
    return () => document.documentElement.removeAttribute('data-mobile-keyboard')
  }, [focused, keyboardOpen, narrow])
  useEffect(() => {
    if (!narrow || !showAccessory || menuOpen) return
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
  }, [editor, narrow, showAccessory, menuOpen])
  useLayoutEffect(() => {
    if (!choosing || !narrow || !showAccessory || editor.isDestroyed) return
    const root = editor.view.dom
    const scroller = root.closest<HTMLElement>('.scroller, .dv-peek-body')
    if (!scroller) return
    scroller.style.setProperty('--mobile-block-room', '210px')
    let frame = 0
    const place = () => {
      frame = 0
      if (!bar.current || editor.isDestroyed) return
      const limit = bar.current.getBoundingClientRect().top - 12
      const adjust = (element: HTMLElement) => {
        const caret = editor.view.coordsAtPos(editor.state.selection.head)
        const delta = caret.bottom - limit
        if (delta > 0) element.scrollTop += delta
      }
      // A quick note has its own scrolling editor inside the page scroller.
      for (let element: HTMLElement | null = root; element && element !== scroller; element = element.parentElement) {
        if (element.scrollHeight > element.clientHeight && /(auto|scroll)/.test(getComputedStyle(element).overflowY)) adjust(element)
      }
      adjust(scroller)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }
    schedule()
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    return () => { cancelAnimationFrame(frame); scroller.style.removeProperty('--mobile-block-room'); window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule) }
  }, [choosing, narrow, showAccessory, keyboardOffset, editor])
  if (!narrow || !showAccessory || menuOpen || editor.isDestroyed || !editor.isEditable) return null
  const preferred = ['Text', 'Heading 1', 'Bulleted list', 'Checklist']
  const items = choosing ? paletteItems('', editor, undefined, allowedCommands).sort((a, b) => {
    const rank = (title: string) => { const index = preferred.indexOf(title); return index < 0 ? preferred.length : index }
    return rank(a.title) - rank(b.title)
  }) : []
  const visibleHeight = window.visualViewport?.height ?? window.innerHeight
  const dockHeight = Math.max(110, Math.min(192, visibleHeight - 90))
  return createPortal(<div ref={bar} className={'mobile-commands' + (choosing ? ' mobile-commands--choosing' : '')} data-testid="mobile-keyboard-bar" role="toolbar" aria-label={t('Commands')} style={{ bottom: `${keyboardOffset}px`, ...(choosing ? { blockSize: `${dockHeight}px` } : {}) }}>
    {choosing ? <>
      <div className="mobile-block-head"><b>{t('Blocks')}</b><button type="button" className="mobile-block-close" data-testid="mobile-block-close" aria-label={t('Close')} onMouseDown={event => event.preventDefault()} onClick={() => setChoosing(false)}><Icon name="x" size={18} /><span>{t('Close')}</span></button></div>
      <div className="mobile-block-options" data-testid="mobile-block-options" role="group" aria-label={t('Blocks')}>
        {items.map(item => {
          const shown = shownItem(item)
          const name = shown.icon.startsWith(ICON_PREFIX) ? commandIconName(shown.icon.slice(ICON_PREFIX.length)) : undefined
          return <button type="button" key={item.title} data-testid={`mobile-block-${item.title.replace(/ /g, '-').toLowerCase()}`} disabled={item.disabled} aria-label={shown.title}
            onMouseDown={event => event.preventDefault()} onClick={() => { runEditorCommand(editor, item); setChoosing(false) }}>
            <span className="mobile-block-icon">{name ? <Icon name={name} size={17} /> : shown.icon}</span><span className="mobile-block-text"><b>{shown.title}</b><small>{shown.desc}</small></span>
          </button>
        })}
      </div>
    </> : <>
      <button type="button" data-testid="mobile-commands" aria-label={t('Blocks')} onMouseDown={event => event.preventDefault()} onClick={() => { if (titleFocused) editor.commands.focus('start'); setChoosing(true) }}><Icon name="plus" size={19} /><span>{t('Blocks')}</span><Icon name="chevron-down" size={15} /></button>
      <button type="button" data-testid="dismiss-keyboard" aria-label={t('Hide keyboard')} onMouseDown={event => event.preventDefault()} onClick={() => { if (titleFocused) titleInput?.blur(); else editor.commands.blur() }}><Icon name="keyboard" size={19} /><span>{t('Close')}</span></button>
    </>}
  </div>, document.body)
}
