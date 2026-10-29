/** Keep native controls and text selection independent from section dragging. */
export function isSectionDragSurface(target: EventTarget | null): target is Element {
  if (target instanceof Element && target.closest('[data-layout-drag-surface]')) return true
  return target instanceof Element && !target.closest(
    'a, button, input, textarea, select, label, canvas, video, audio, iframe, td, th, '
    + '[role="button"], [role="slider"], [role="checkbox"], .layout-resizer, .img-handle, '
    + '.db-embed, .database-embed, [data-type="database-embed"]',
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
    event.preventDefault(); event.stopPropagation()
    surface.dispatchEvent(new CustomEvent('layout-section-menu', { bubbles: true }))
  }
  return surface
}

/** Inspect glyph rectangles, not paragraph rectangles: blank space is a natural drag surface. */
export function isOverSectionText(doc: Document, x: number, y: number): boolean {
  const api = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const caret = api.caretPositionFromPoint?.(x, y)
  const fallback = !caret ? api.caretRangeFromPoint?.(x, y) : null
  const node = caret?.offsetNode ?? fallback?.startContainer
  const offset = caret?.offset ?? fallback?.startOffset ?? 0
  // On engines without a caret API, protect native selection rather than grabbing text blindly.
  if (!api.caretPositionFromPoint && !api.caretRangeFromPoint) return true
  if (!node || node.nodeType !== 3) return false
  const length = node.textContent?.length ?? 0
  for (const at of [offset - 1, offset]) {
    if (at < 0 || at >= length) continue
    const range = doc.createRange()
    range.setStart(node, at); range.setEnd(node, at + 1)
    if (Array.from(range.getClientRects()).some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 4 && y <= r.bottom + 4)) return true
  }
  return false
}
