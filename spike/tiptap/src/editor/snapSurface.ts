/** Keep native controls and text selection independent from section dragging. */
export function isSectionDragSurface(target: EventTarget | null): target is Element {
  if (target instanceof Element && target.closest('[data-layout-drag-surface]')) return true
  return (
    target instanceof Element &&
    !target.closest(
      'a, button, input, textarea, select, label, canvas, video, audio, iframe, td, th, ' +
        '[role="button"], [role="slider"], [role="checkbox"], .layout-resizer, .img-handle, ' +
        '.db-embed, .database-embed, [data-type="database-embed"]',
    )
  )
}

/** Whole-width block chrome, separate from editable code and table cells. */
export function createSectionDragSurface(label: string, hint: string): HTMLDivElement {
  const surface = document.createElement('div')
  surface.className = 'section-drag-surface'
  surface.dataset.layoutDragSurface = 'true'
  surface.contentEditable = 'false'
  surface.tabIndex = 0
  surface.setAttribute('role', 'button')
  surface.setAttribute('aria-label', label)
  surface.title = hint
  surface.textContent = label
  surface.onclick = (event) => {
    if (event.detail === 0) surface.dispatchEvent(new CustomEvent('layout-section-menu', { bubbles: true }))
  }
  surface.onkeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    surface.dispatchEvent(new CustomEvent('layout-section-menu', { bubbles: true }))
  }
  return surface
}
