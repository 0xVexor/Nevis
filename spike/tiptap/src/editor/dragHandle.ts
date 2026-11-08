import { Extension } from '@tiptap/core'
import { Plugin, NodeSelection, Selection } from '@tiptap/pm/state'
import { redo, undo } from '@tiptap/pm/history'
import type { EditorView } from '@tiptap/pm/view'
import { COLUMN, GROUP, GAP, ancestor, blockRange, flow, type BlockRange } from './layoutModel'
import { LAYOUT_CANCEL } from './layout'
import { directionalSnapTarget, fitsSnapColumns, outsideSnapTarget, planSnap, snapKey, snapTransaction, verticalSnapTarget, type SnapContext, type SnapFailure, type SnapPlan } from './snapModel'
import { chooseSnapDestination, hitsSnapDestination, snapContext, snapDestinations, type SnapDestination } from './snapTargets'
import { t } from '../i18n'
import { hoveredSnapBlock, snapBlockAtElement } from './snapHover'
import { isSectionDragSurface } from './snapSurface'
import { setLayoutInteraction } from './layoutInteraction'
import { DS_ICONS } from '../design-system/iconData'
import { motionMs, prefersReducedMotion } from '../design-system/motion'
import type { Node as PMNode } from '@tiptap/pm/model'

const MIME = 'application/x-nevis-block-move'
/** The gap, in pixels, that opens between two blocks where a dragged block will land. */
const ROOM = 12
/** How long, in ms, the auto-scroll at the page edges takes to reach full speed. */
const EDGE_RAMP = 350
/** How far into the text, in pixels, the pointer must be before a drag may put blocks side by side; the margin reorders. */
const TEXT_INSET = 6
/** The easing token, for animations started from script. */
const motionEase = () => getComputedStyle(document.documentElement).getPropertyValue('--ds-ease').trim() || 'ease-out'
/** No animation: the Reduce motion settings, or a host without media queries (the tests' document), where nothing is drawn anyway. */
const stillMotion = () => typeof matchMedia !== 'function' || prefersReducedMotion()
const icon = (name: string) => `<svg class="ds-icon" viewBox="0 0 24 24" aria-hidden="true">${DS_ICONS[name]?.[1] ?? ''}</svg>`
let pickerSequence = 0
let roomHosts = 0
export const SNAP_PICK = 'layout-snap-pick'
export interface SnapPickRequest {
  range: BlockRange
  doc: EditorView['state']['doc']
  mode: 'pick' | 'up' | 'down' | 'left' | 'right' | 'outside-before' | 'outside-after'
}

/** Taking content out of a layout: the preview shows the moved block and the columns left behind. */
function snapMiniature(columns?: SnapPlan['columns'], extraction?: SnapPlan['extraction']) {
  const miniature = document.createElement('div')
  miniature.className = 'layout-snap-miniature'
  miniature.setAttribute('aria-hidden', 'true')
  const row = (widths: number[], active: number) => {
    const dom = document.createElement('div')
    dom.className = 'layout-snap-miniature-row'
    dom.style.gridTemplateColumns = widths.map((width) => `${width}fr`).join(' ')
    widths.forEach((_width, index) => {
      const panel = document.createElement('div')
      panel.className = 'layout-snap-miniature-panel' + (index === active ? ' active' : '')
      dom.append(panel)
    })
    return dom
  }
  if (extraction?.remainingWidths.length) {
    miniature.classList.add('layout-snap-miniature-extraction')
    const remaining = extraction.rtl ? [...extraction.remainingWidths].reverse() : extraction.remainingWidths
    const moved = row([100], 0),
      rest = row(remaining, -1)
    miniature.append(...(extraction.side === 'before' ? [moved, rest] : [rest, moved]))
  } else {
    const widths = columns ? (columns.rtl ? [...columns.widths].reverse() : columns.widths) : [100]
    const active = columns ? (columns.rtl ? widths.length - 1 - columns.active : columns.active) : 0
    miniature.append(row(widths, active))
  }
  return miniature
}

/** Pointer and keyboard share one planner, preview, commit, and cancellation lifecycle per editor. */
export const DragHandle = Extension.create({
  name: 'dragHandle',
  priority: 1050,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: { handleDrop: (_view, event) => event.dataTransfer?.types.includes(MIME) ?? false },
        view(view) {
          const host = view.dom.parentElement
          if (!host) return {}
          // the hover follows the pointer over the whole page, margins included: the grip stands in the margin beside the text
          const area: HTMLElement = view.dom.closest<HTMLElement>('.scroller') ?? host
          // The landing preview. Direction is fixed so the column order can be drawn as the page shows it.
          const overlay = document.createElement('div')
          overlay.className = 'ds-snap-preview'
          overlay.dir = 'ltr'
          overlay.setAttribute('aria-hidden', 'true')
          const sourceOverlay = document.createElement('div')
          sourceOverlay.className = 'layout-snap-source-overlay'
          sourceOverlay.setAttribute('aria-hidden', 'true')
          const hoverOutline = document.createElement('div')
          hoverOutline.className = 'layout-snap-hover-outline'
          hoverOutline.setAttribute('aria-hidden', 'true')
          hoverOutline.hidden = true
          const columnHighlight = document.createElement('div')
          columnHighlight.className = 'layout-snap-column-highlight'
          columnHighlight.setAttribute('aria-hidden', 'true')
          columnHighlight.hidden = true
          // The ghost under the pointer: what is moving, and what releasing here will do.
          const preview = document.createElement('div')
          preview.className = 'ds-drag-ghost'
          preview.setAttribute('aria-hidden', 'true')
          const previewTitle = document.createElement('div')
          previewTitle.className = 'ds-drag-ghost-title'
          previewTitle.dir = 'auto'
          const previewAction = document.createElement('div')
          previewAction.className = 'ds-drag-ghost-action'
          preview.append(previewTitle, previewAction)
          let previewSignature = ''
          const setAction = (text: string, state: 'ready' | 'idle' | 'blocked', glyph = '') => {
            const signature = `${state}:${glyph}:${text}`
            if (signature === previewSignature) return
            previewSignature = signature
            preview.dataset.state = state
            const label = document.createElement('span')
            label.textContent = text
            previewAction.innerHTML = glyph ? icon(glyph) : ''
            previewAction.append(label)
          }
          const announcement = document.createElement('div')
          announcement.className = 'layout-snap-announcement'
          announcement.setAttribute('role', 'status')
          announcement.setAttribute('aria-live', 'polite')
          const picker = document.createElement('div')
          picker.className = 'layout-snap-picker'
          picker.setAttribute('role', 'group')
          picker.setAttribute('aria-label', t('Choose a destination'))
          picker.tabIndex = -1
          const hint = document.createElement('div')
          hint.className = 'layout-snap-hint'
          hint.id = `layout-snap-hint-${++pickerSequence}`
          hint.textContent = t('Choose a place. Tab or arrow keys to browse, Enter to move, Escape to cancel.')
          const choice = document.createElement('div')
          choice.className = 'layout-snap-choice'
          choice.id = `layout-snap-choice-${pickerSequence}`
          choice.setAttribute('aria-live', 'polite')
          picker.setAttribute('aria-describedby', `${hint.id} ${choice.id}`)
          const cancelButton = document.createElement('button')
          cancelButton.type = 'button'
          cancelButton.className = 'ds-btn ds-btn--sm ds-btn--ghost'
          cancelButton.textContent = t('Cancel')
          picker.append(hint, choice, cancelButton)
          overlay.hidden = true
          preview.hidden = true
          picker.hidden = true
          document.body.append(overlay, sourceOverlay, hoverOutline, columnHighlight, preview, announcement, picker)
          // The one place a text block is picked up. Text and the blank space around it always select text.
          const grip = document.createElement('button')
          grip.type = 'button'
          grip.className = 'ds-grip'
          grip.tabIndex = -1
          grip.dataset.show = 'false'
          grip.setAttribute('aria-label', t('Move block'))
          grip.title = t('Move block')
          grip.innerHTML =
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
            [
              [9, 6],
              [15, 6],
              [9, 12],
              [15, 12],
              [9, 18],
              [15, 18],
            ]
              .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.9"/>`)
              .join('') +
            '</svg>'
          document.body.append(grip)
          let pos = -1,
            frame = 0,
            menuClickTimer = 0,
            announcementTimer = 0
          let destroyed = false,
            suppressSurfaceClick = false
          let hoverFrame = 0
          let gripPos = -1,
            gripTimer = 0,
            overGrip = false
          let hoverPoint: { x: number; y: number } | null = null
          let hoverModality: 'pointer' | 'keyboard' = 'keyboard'
          let cursor: { x: number; y: number } | null = null
          let pointer: {
            id: number
            x: number
            y: number
            pos: number
            started: boolean
            doc: EditorView['state']['doc']
            capture: HTMLElement | null
            chrome: boolean
            range: BlockRange
          } | null = null
          let session: { range: BlockRange; doc: EditorView['state']['doc']; mode: 'drag' | 'pick'; direction: string; selectionBefore?: Selection; context: SnapContext } | null = null
          let target: SnapDestination | null = null
          // Cache eligibility only. Keeping a full document plan for every destination is quadratic memory.
          let cache = new Map<string, { error?: SnapFailure; columns?: SnapPlan['columns']; extraction?: SnapPlan['extraction'] }>()
          let keyboardChoice: string | null = null
          let lastPaint = ''
          let lastShape = '' // 'line' or 'box': the preview fades in when it changes from one to the other
          // Making room: the blocks below the place a dragged block will land slide down by ROOM, so a gap opens for it. It is
          // drawn by a stylesheet on the editor's children, not on the blocks themselves, which the editor redraws as it likes.
          const roomHost = String(++roomHosts)
          const roomStyle = document.createElement('style')
          let roomAt = -1,
            roomRule = ''
          const writeRoom = (sliding: boolean) => {
            const host = `.ProseMirror[data-snap-room="${roomHost}"]`
            const slide = sliding && roomParents.size ? `${[...roomParents].map((parent) => `${host} ${parent}> *`).join(', ')} { transition: transform var(--ds-fast) var(--ds-ease); }\n` : ''
            roomStyle.textContent = slide + (roomRule ? `${host} ${roomRule} { transform: translateY(${ROOM}px); }` : '')
          }
          // the containers whose blocks have slid during this drag: they keep the transition, so their blocks slide back too
          const roomParents = new Set<string>()
          const setRoom = (at: number) => {
            if (at === roomAt) return
            // the block's place as a chain of child positions from the editor down, so a gap opens inside a column as well
            let steps: number[] | null = null
            const dom = at >= 0 && !stillMotion() ? view.nodeDOM(at) : null
            if (dom instanceof HTMLElement && dom !== view.dom && view.dom.contains(dom)) {
              steps = []
              for (let el: HTMLElement | null = dom; el && el !== view.dom; el = el.parentElement) steps.unshift(Array.prototype.indexOf.call(el.parentElement?.children ?? [], el) + 1)
            }
            roomAt = steps ? at : -1
            const parent = steps
              ? steps
                  .slice(0, -1)
                  .map((n) => `> :nth-child(${n}) `)
                  .join('')
              : ''
            if (steps) roomParents.add(parent)
            roomRule = steps ? `${parent}> :nth-child(n + ${steps[steps.length - 1]})` : ''
            if (roomAt >= 0 && !roomStyle.isConnected) {
              view.dom.dataset.snapRoom = roomHost
              document.head.append(roomStyle)
            }
            if (roomStyle.isConnected) writeRoom(true)
          }
          // instant: at the drop, where the document is about to change under the blocks; otherwise they slide back
          const clearRoom = (instant: boolean) => {
            if (!roomStyle.isConnected) return
            roomAt = -1
            roomRule = ''
            writeRoom(!instant)
            const remove = () => {
              if (roomAt >= 0) return // a new drag has opened a gap again
              roomParents.clear()
              roomStyle.remove()
              delete view.dom.dataset.snapRoom
            }
            if (instant) remove()
            else window.setTimeout(remove, motionMs('--ds-fast', 120) + 80)
          }
          // measured where the blocks stand, not where the gap has slid them
          const withoutRoom = (measure: () => void) => {
            const rule = roomRule
            if (!rule) return measure()
            roomRule = ''
            writeRoom(false)
            try {
              measure()
            } finally {
              roomRule = rule
              writeRoom(false)
              void view.dom.offsetHeight
              writeRoom(true)
            }
          }
          let geometry: SnapDestination[] | null = null
          let locatedGeometry: SnapDestination[] | null = null
          let locatedX = NaN,
            locatedY = NaN,
            lastTickAt = 0,
            edgeSince = 0 // when the pointer entered the scrolling band at the top or bottom; 0 outside it
          const geometryChanged = () => {
            geometry = null
          }
          const geometryObserver = new ResizeObserver(geometryChanged)
          const setChoice = (message: string) => {
            if (choice.textContent !== message) choice.textContent = message
          }
          const announce = (message: string) => {
            clearTimeout(announcementTimer)
            announcement.textContent = ''
            announcementTimer = window.setTimeout(() => {
              if (!destroyed) announcement.textContent = message
            }, 0)
          }
          // the first visible line of the page: below the app's top bar (the scroller's edge) and the sticky formatting toolbar
          const visibleTop = () => {
            const scroller = view.dom.closest<HTMLElement>('.scroller')?.getBoundingClientRect()
            const toolbar = view.dom.closest('.page')?.querySelector<HTMLElement>('.toolbar')?.getBoundingClientRect()
            return Math.max(0, scroller?.top ?? 0, toolbar?.bottom ?? 0)
          }
          // slack lets a box's own border (drawn on its edge) show where the box meets the top or bottom of the text
          const clipToEditor = (element: HTMLElement, r: { left: number; top: number; width: number; height: number }, insertion = false, slack = 0) => {
            const scroller = view.dom.closest<HTMLElement>('.scroller')?.getBoundingClientRect()
            const editorRect = view.dom.getBoundingClientRect()
            const top = Math.max(visibleTop(), (insertion ? Math.min(editorRect.top, r.top) : editorRect.top) - slack)
            const bottom = Math.min(innerHeight, scroller?.bottom ?? innerHeight, (insertion ? Math.max(editorRect.bottom, r.top + r.height) : editorRect.bottom) + slack)
            const left = Math.max(0, scroller?.left ?? 0, editorRect.left)
            const right = Math.min(innerWidth, scroller?.right ?? innerWidth, editorRect.right)
            element.style.clipPath = `inset(${Math.max(0, top - r.top)}px ${Math.max(0, r.left + r.width - right)}px ${Math.max(0, r.top + r.height - bottom)}px ${Math.max(0, left - r.left)}px)`
          }
          const hideGrip = () => {
            clearTimeout(gripTimer)
            grip.dataset.show = 'false'
            gripPos = -1
          }
          // Leave the grip up for a moment: the pointer has to cross the gutter to reach it.
          const scheduleGripHide = () => {
            clearTimeout(gripTimer)
            if (!overGrip) gripTimer = window.setTimeout(hideGrip, 220)
          }
          // The outline marks the block the grip belongs to. It is drawn faintly only while it matters: the pointer on the grip, on a
          // block's own drag strip, or grabbing. Moving over text leaves the page calm.
          const markOutline = (on: boolean) => {
            if (on) hoverOutline.dataset.strong = ''
            else delete hoverOutline.dataset.strong
          }
          const hide = () => {
            cancelAnimationFrame(hoverFrame)
            hoverFrame = 0
            // leaving the page for the grip (it lives outside it) keeps the block it belongs to marked
            if (overGrip && gripPos >= 0 && !session) return
            hoverOutline.hidden = true
            markOutline(false)
            pos = -1
            hoverPoint = null
            view.dom.classList.remove('layout-surface-hover')
            scheduleGripHide()
            if (!session && !pointer && !view.dom.querySelector('.layout-resizing')) setLayoutInteraction(view.dom, 'idle')
          }
          const release = () => {
            const id = pointer?.id
            const capture = pointer?.capture
            pointer = null
            view.dom.classList.remove('layout-surface-armed')
            if (!session) setLayoutInteraction(view.dom, 'idle')
            if (id != null && capture) {
              try {
                if (capture.hasPointerCapture(id)) capture.releasePointerCapture(id)
              } catch {
                /* capture already gone */
              }
            }
          }
          const returnCard = (from: number) => {
            const dom = view.nodeDOM(from)
            const to = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
            const card = preview.getBoundingClientRect()
            if (stillMotion() || !to || !to.width || !card.width) return
            const copy = preview.cloneNode(true) as HTMLElement
            copy.setAttribute('aria-hidden', 'true')
            document.body.append(copy)
            copy
              .animate(
                [
                  { transform: 'none', opacity: 1 },
                  { transform: `translate(${to.left - card.left}px, ${to.top - card.top}px)`, opacity: 0 },
                ],
                { duration: motionMs('--ds-base', 220), easing: motionEase() },
              )
              .finished.catch(() => undefined)
              .finally(() => copy.remove())
          }
          const cancel = (restoreFocus = false, message = '', restoreSelection = true) => {
            const previous = session
            const wasActive = !!session
            session = null
            release()
            cancelAnimationFrame(frame)
            frame = 0
            cancelAnimationFrame(hoverFrame)
            hoverFrame = 0
            overlay.hidden = true
            clearRoom(false)
            // a drag that ends without a move sends its card back to the block, so it is clear that nothing changed
            // (only while the page is the one the drag began on: after a change the old position may be another block)
            if (previous?.mode === 'drag' && restoreSelection && !preview.hidden && previous.doc === view.state.doc) returnCard(previous.range.from)
            preview.hidden = true
            picker.hidden = true
            columnHighlight.hidden = true
            overlay.replaceChildren()
            lastPaint = ''
            lastShape = ''
            previewSignature = ''
            target = null
            cursor = null
            keyboardChoice = null
            cache.clear()
            geometry = null
            geometryObserver.disconnect()
            locatedGeometry = null
            locatedX = NaN
            locatedY = NaN
            lastTickAt = 0
            edgeSince = 0
            sourceOverlay.replaceChildren()
            view.dom.classList.remove('layout-dragging', 'layout-snap-picking', 'layout-surface-hover')
            setLayoutInteraction(view.dom, 'idle')
            hoverOutline.hidden = true
            markOutline(false)
            pos = -1
            hoverPoint = null
            if (message && wasActive) announce(message)
            if (!destroyed && restoreSelection && previous?.selectionBefore && previous.doc === view.state.doc && !previous.selectionBefore.eq(view.state.selection)) {
              view.dispatch(view.state.tr.setSelection(previous.selectionBefore))
            }
            if (restoreFocus && !destroyed) view.focus()
            clearTimeout(menuClickTimer)
            menuClickTimer = window.setTimeout(() => {
              suppressSurfaceClick = false
            }, 0)
          }
          cancelButton.onclick = () => cancel(true, t('Move cancelled.'))
          const interactionFailed = (error: unknown) => {
            console.error('[layout] Interaction cancelled after an unexpected error', error)
            cancel(true)
            announce(t('The move could not be completed. Please try again.'))
          }
          const obstructed = () =>
            [...document.querySelectorAll<HTMLElement>('.overlay, [role="dialog"], [role="alertdialog"], .ds-pop, .tb-menu, .slash-menu')].some((dom) => dom.getClientRects().length)
          const valid = () =>
            !!session &&
            session.doc === view.state.doc &&
            view.editable &&
            !view.composing &&
            session.direction === getComputedStyle(view.dom).direction &&
            !view.dom.querySelector('.layout-resizing') &&
            !obstructed()
          const validate = (destination: SnapDestination, includePlan = false): SnapDestination => {
            if (!session) return destination
            let result = cache.get(destination.key)
            if (!result) {
              const planned = planSnap(view.state, session.range, destination.target, session.context)
              result = { error: planned.error, columns: planned.plan?.columns, extraction: planned.plan?.extraction }
              cache.set(destination.key, result)
              if (includePlan) destination.plan = planned.plan
            }
            destination.error = result.error
            if (result.columns && !fitsSnapColumns(destination.rect.width, result.columns.widths)) destination.error = 'insufficient-width'
            if (includePlan && !destination.error && !destination.plan) {
              destination.plan = target?.key === destination.key ? target.plan : undefined
              if (!destination.plan) destination.plan = planSnap(view.state, session.range, destination.target, session.context).plan
            }
            return destination
          }
          const destinations = () => {
            if (!session) return []
            if (!geometry) {
              const range = session.range
              withoutRoom(() => {
                geometry = snapDestinations(view, range)
                sourceOverlay.replaceChildren()
                let at = range.from
                for (const node of range.nodes) {
                  const dom = view.nodeDOM(at)
                  if (dom instanceof HTMLElement) {
                    const r = dom.getBoundingClientRect(),
                      outline = document.createElement('div')
                    outline.className = 'ds-drag-source'
                    outline.style.left = `${r.left}px`
                    outline.style.top = `${r.top}px`
                    outline.style.width = `${r.width}px`
                    outline.style.height = `${r.height}px`
                    sourceOverlay.append(outline)
                  }
                  at += node.nodeSize
                }
                clipToEditor(sourceOverlay, { left: 0, top: 0, width: innerWidth, height: innerHeight })
              })
            }
            return geometry ?? [] // set inside withoutRoom, which the type checker cannot follow
          }
          const paint = (destination: SnapDestination | null) => {
            if (target && target.key !== destination?.key) delete target.plan
            target = destination
            // a plain move between blocks, on the page or inside a column, opens a gap; columns and taking out of a layout do not
            const plain = destination && !destination.error && destination.plan && (destination.kind === 'line' || (destination.kind === 'full-width' && !destination.plan.extraction))
            setRoom(plain && destination.target.kind === 'insert' ? destination.target.pos : -1)
            if (!destination || destination.error || !destination.plan) {
              overlay.hidden = true
              lastShape = ''
              columnHighlight.hidden = true
              lastPaint = ''
              const blocked = destination?.error === 'max-columns' || destination?.error === 'insufficient-width'
              const message =
                destination?.error === 'max-columns'
                  ? t('A layout can have up to three columns.')
                  : destination?.error === 'insufficient-width'
                    ? t('There is not enough room for these columns.')
                    : session?.mode === 'pick'
                      ? t('Choose a destination')
                      : t('Release to leave it where it was')
              if (session?.mode === 'pick') setChoice(message)
              else if (session?.mode === 'drag') setAction(message, blocked ? 'blocked' : 'idle')
              return
            }
            const { rect, plan } = destination
            // Between blocks a plain line is enough. A box is drawn only when the shape of the page changes:
            // new or reordered columns, or content taken out of a layout.
            const line = destination.kind === 'line' || (destination.kind === 'full-width' && !plan.extraction)
            const signature = `${destination.key}:${rect.left}:${rect.top}:${rect.width}:${rect.height}:${plan.columns?.widths.join(',')}:${roomAt}`
            if (signature !== lastPaint) {
              lastPaint = signature
              // in an opened gap the line sits in its middle
              const top = (line && destination.kind === 'full-width' ? rect.top - 1.5 : rect.top) + (line && roomAt >= 0 ? ROOM / 2 : 0)
              const shape = line ? 'line' : 'box'
              if (shape !== lastShape) {
                // a line becoming a box of columns (or back) fades in rather than jumping
                if (!stillMotion()) overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs('--ds-fast', 120), easing: motionEase() })
                lastShape = shape
              }
              const height = line ? (destination.kind === 'line' ? rect.height : 3) : rect.height
              overlay.dataset.line = String(line)
              overlay.dataset.cols = String(!line)
              overlay.style.left = `${rect.left}px`
              overlay.style.top = `${top}px`
              overlay.style.width = `${rect.width}px`
              overlay.style.height = `${height}px`
              if (!line) {
                const widths = plan.columns ? (plan.columns.rtl ? [...plan.columns.widths].reverse() : plan.columns.widths) : [100]
                const active = plan.columns ? (plan.columns.rtl ? widths.length - 1 - plan.columns.active : plan.columns.active) : 0
                overlay.style.gridTemplateColumns = widths.map((w) => `minmax(0, ${w}fr)`).join(' ')
                overlay.style.gap = `${GAP}px`
                if (overlay.childElementCount !== widths.length) {
                  overlay.replaceChildren(...widths.map(() => document.createElement('div')))
                }
                Array.from(overlay.children).forEach((column, i) => {
                  column.className = 'ds-snap-col'
                  ;(column as HTMLElement).dataset.active = String(i === active)
                  column.textContent = destination.kind === 'full-width' ? t('Full width') : ''
                  if (destination.kind === 'full-width' && plan.extraction) column.prepend(snapMiniature(undefined, plan.extraction))
                })
              } else {
                overlay.replaceChildren()
                overlay.style.gridTemplateColumns = ''
                overlay.style.gap = ''
              }
            }
            overlay.hidden = false
            clipToEditor(overlay, rect, destination.kind === 'full-width', 3)
            const column = destination.columnRect
            columnHighlight.hidden = !column
            if (column) {
              columnHighlight.style.left = `${column.left}px`
              columnHighlight.style.top = `${column.top}px`
              columnHighlight.style.width = `${column.width}px`
              columnHighlight.style.height = `${column.height}px`
              clipToEditor(columnHighlight, column)
            }
            if (session?.mode === 'pick') {
              setChoice(
                plan.columns
                  ? t(plan.columns.action === 'reorder' ? 'Move column · {destination}' : 'New column · {destination}', { destination: destination.label })
                  : column
                    ? t('Inside this column · {destination}', { destination: destination.label })
                    : destination.label,
              )
              return
            }
            // Say the outcome in plain words; the preview shows where.
            if (plan.columns)
              setAction(
                t(plan.columns.action === 'reorder' ? 'Move this column here' : plan.columns.action === 'pair' ? 'Place side by side' : 'Add as a new column'),
                'ready',
                plan.columns.widths.length >= 3 ? 'columns-3' : 'columns',
              )
            else if (plan.extraction) setAction(t('Take out of the columns'), 'ready', 'arrow-up-right')
            else setAction(column ? t('Move into this column') : t('Move here'), 'ready', 'move')
          }
          const pullOutDestination = (all: SnapDestination[], x: number, y: number): SnapDestination | null => {
            if (!session || session.mode !== 'drag' || !pointer?.started) return null
            const dx = x - pointer.x,
              dy = y - pointer.y
            if (Math.abs(dy) < 24 || Math.abs(dy) < Math.abs(dx) * 1.25) return null
            const $source = view.state.doc.resolve(session.range.from)
            const column = ancestor($source, COLUMN),
              group = ancestor($source, GROUP)
            if (!column || !group) return null
            const columnDOM = view.nodeDOM(column.pos),
              groupDOM = view.nodeDOM(group.pos)
            if (!(columnDOM instanceof HTMLElement) || !(groupDOM instanceof HTMLElement)) return null
            const c = columnDOM.getBoundingClientRect(),
              g = groupDOM.getBoundingClientRect()
            if (x < c.left || x > c.right || y < g.top || y > g.bottom) return null
            // Reordering real sibling blocks keeps the ordinary insertion behavior. Within
            // the grabbed block (including a tall table), vertical motion means full width.
            let overSibling = false
            column.node.forEach((_node, offset) => {
              const pos = column.pos + 1 + offset
              if (pos >= session!.range.from && pos < session!.range.to) return
              const dom = view.nodeDOM(pos)
              if (!(dom instanceof HTMLElement)) return
              const r = dom.getBoundingClientRect()
              if (y >= r.top - 6 && y <= r.bottom + 6) overSibling = true
            })
            if (overSibling) return null
            const target = outsideSnapTarget(view.state, session.range, dy < 0 ? 'before' : 'after')
            const destination = target && all.find((candidate) => candidate.key === snapKey(target))
            return destination ? { ...destination, label: t(dy < 0 ? 'Full width · above layout' : 'Full width · below layout') } : null
          }
          const locateUnsafe = (x: number, y: number) => {
            if (!valid()) {
              if (session) cancel(false, t('Move cancelled because the page changed.'))
              return
            }
            const all = destinations()
            const pulled = pullOutDestination(all, x, y)
            if (pulled) {
              const hit = document.elementFromPoint(x, y)
              if (hit && view.dom.contains(hit)) {
                paint(validate(pulled, true))
                return
              }
            }
            // Do not target content behind a modal, menu, scrollbar, or another editor.
            const hit = document.elementFromPoint(x, y)
            const group = hit instanceof Element ? hit.closest<HTMLElement>('.layout-group') : null
            const within = !!hit && view.dom.contains(hit)
            const editor = view.dom.getBoundingClientRect()
            const margin =
              hit instanceof Element &&
              !hit.closest('button, input, textarea, select, .toolbar, .ds-pop') &&
              !!view.dom.closest('.page')?.contains(hit) &&
              x >= editor.left - 52 &&
              x <= editor.right + 52 &&
              y >= editor.top - 24 &&
              y <= editor.bottom + 24
            const edge = group && view.dom.contains(group)
            if (!within && !edge && !margin) {
              paint(null)
              return
            }
            // Validate hits before hysteresis: forbidden gaps must never fall through.
            for (const destination of all) {
              if (hitsSnapDestination(destination, x, y, 8)) validate(destination)
            }
            // Columns form only over the text itself. The margin, where the grip is, is the lane for reordering: dragging
            // straight up or down from the grip always reorders. Counting the distance from where the drag began instead
            // made the near side hard to reach, since dropping beside a block on the grip's side means going back there.
            const sideways = !pointer?.started || (x >= editor.left + TEXT_INSET && x <= editor.right - TEXT_INSET)
            const selected = chooseSnapDestination(all, x, y, target, sideways)
            paint(selected ? validate(selected, true) : null)
          }
          const locate = (x: number, y: number) => {
            try {
              locateUnsafe(x, y)
            } catch (error) {
              interactionFailed(error)
            }
          }
          const commitUnsafe = () => {
            if (!valid() || !target?.plan || target.error) return false
            // Re-plan at release, even if a cached preview was valid earlier.
            const result = planSnap(view.state, session!.range, target.target, session!.context)
            if (!result.plan || (result.plan.columns && !fitsSnapColumns(target.rect.width, result.plan.columns.widths))) return false
            const tr = snapTransaction(view.state, result.plan)
            if (!tr) return false
            clearRoom(true)
            const from = sourceRect()
            const moved = session!.range.nodes[0]
            cancel(false, '', false)
            view.dispatch(tr)
            view.focus()
            if (from && moved) settle(moved, from)
            announce(t('Content moved. Undo to restore its previous position.'))
            return true
          }
          // Where the block stands before the drop: the move is drawn from there.
          const sourceRect = () => {
            const dom = view.nodeDOM(session!.range.from)
            const r = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
            return r && r.width > 0 ? r : null
          }
          // The drop slides the block from where it stood into its new place, so the eye follows the move instead of losing it in a jump.
          const settle = (moved: PMNode, from: DOMRect) => {
            if (stillMotion()) return
            let landed: HTMLElement | null = null
            view.state.doc.descendants((node, at) => {
              if (landed) return false
              if (node !== moved) return true
              const dom = view.nodeDOM(at)
              if (dom instanceof HTMLElement) landed = dom
              return false
            })
            const el = landed as HTMLElement | null
            const to = el?.getBoundingClientRect()
            if (!el || !to || !to.width) return
            const dx = from.left - to.left,
              dy = from.top - to.top
            if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return
            el.animate(
              [
                { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6 },
                { transform: 'none', opacity: 1 },
              ],
              {
                duration: motionMs('--ds-slow', 300), // a longer way than a hover change: the slow step of the scale
                easing: motionEase(),
              },
            )
          }
          const commit = () => {
            try {
              return commitUnsafe()
            } catch (error) {
              interactionFailed(error)
              return false
            }
          }
          const showKeyboardChoice = (key: string, scroll = false) => {
            let found = destinations().find((destination) => destination.key === key)
            if (!found) {
              paint(null)
              return
            }
            const sc = view.dom.closest<HTMLElement>('.scroller')
            if (scroll && sc) {
              const r = sc.getBoundingClientRect(),
                top = found.rect.top,
                bottom = top + Math.max(found.rect.height, 24)
              if (top < r.top + 24) sc.scrollTop += top - r.top - 24
              else if (bottom > r.bottom - 80) sc.scrollTop += Math.min(bottom - r.bottom + 80, top - r.top - 24)
              geometryChanged()
              found = destinations().find((destination) => destination.key === key)
            }
            if (found) paint(validate(found, true))
          }
          const browse = (delta: number, end?: 'first' | 'last') => {
            const choices = destinations()
            const current = choices.findIndex((destination) => destination.key === (keyboardChoice ?? target?.key))
            const direction = end === 'first' ? 1 : end === 'last' ? -1 : delta
            let index = end === 'first' ? 0 : end === 'last' ? choices.length - 1 : current < 0 ? (direction < 0 ? choices.length - 1 : 0) : (current + direction + choices.length) % choices.length
            // Validate lazily as the user browses, rather than planning every possible move up front.
            for (let visited = 0; visited < choices.length; visited++) {
              if (!validate(choices[index]).error) {
                keyboardChoice = choices[index].key
                cursor = null
                showKeyboardChoice(keyboardChoice, true)
                return
              }
              index = (index + direction + choices.length) % choices.length
            }
            paint(null)
            setChoice(t('There are no available destinations.'))
          }
          const start = (range: BlockRange, mode: 'drag' | 'pick', selectionBefore?: Selection) => {
            hideGrip()
            cancelAnimationFrame(hoverFrame)
            hoverFrame = 0
            hoverOutline.hidden = true
            session = { range, doc: view.state.doc, mode, direction: getComputedStyle(view.dom).direction, selectionBefore, context: snapContext(view) }
            cache = new Map()
            keyboardChoice = null
            geometry = null
            geometryObserver.observe(view.dom)
            for (const dom of view.dom.querySelectorAll(':scope > *, .layout-column, .layout-column > *')) geometryObserver.observe(dom)
            view.dom.classList.add('layout-dragging')
            setLayoutInteraction(view.dom, mode)
            if (mode === 'pick') {
              hint.textContent = t('Choose a place. Tab or arrow keys to browse, Enter to move, Escape to cancel.')
              cancelButton.textContent = t('Cancel')
              picker.setAttribute('aria-label', t('Choose a destination'))
              view.dom.classList.add('layout-snap-picking')
              picker.hidden = false
              picker.dir = getComputedStyle(view.dom).direction
              picker.focus({ preventScroll: true })
              keyboardChoice = destinations().find((destination) => destination.target.kind === 'insert' && destination.target.pos === range.from)?.key ?? null
              browse(1)
            }
            if (!frame) frame = requestAnimationFrame(tick)
          }
          const positionHover = (start: number) => {
            const dom = view.nodeDOM(start)
            if (!(dom instanceof HTMLElement)) return
            const r = dom.getBoundingClientRect()
            pos = start
            hoverOutline.style.left = `${r.left}px`
            hoverOutline.style.top = `${r.top}px`
            hoverOutline.style.width = `${r.width}px`
            hoverOutline.style.height = `${r.height}px`
            clipToEditor(hoverOutline, r)
            hoverOutline.hidden = false
          }
          const showGrip = (start: number) => {
            const dom = view.nodeDOM(start)
            if (!(dom instanceof HTMLElement)) return
            clearTimeout(gripTimer)
            const r = dom.getBoundingClientRect()
            // the side follows the app's own language, not the block's: left, or right when the whole app is in Persian
            const rtl = document.documentElement.dir === 'rtl'
            const width = 24,
              gap = 12 // clear of the block, so the grip never sits on its text or bullet
            const x = Math.min(Math.max(rtl ? r.right + gap : r.left - width - gap, 2), innerWidth - width - 2)
            // level with the block's first line of text (a heading's line is taller than a paragraph's); other blocks at their top
            const height = grip.offsetHeight || 28
            let first = r.top + 2
            if (/^(P|H[1-6]|BLOCKQUOTE|UL|OL)$/.test(dom.tagName)) {
              const line = dom.tagName === 'UL' || dom.tagName === 'OL' ? (dom.querySelector('p') ?? dom) : dom
              const cs = getComputedStyle(line)
              const lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.6
              first = line.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0) + (lineHeight - height) / 2
            }
            // never over the top bar or the formatting toolbar: it slides down with a block that scrolled under them, and goes once the block has
            const top = visibleTop()
            if (r.bottom < top + width) return hideGrip()
            grip.style.left = `${x}px`
            grip.style.top = `${Math.max(first, top + 2)}px`
            grip.dataset.show = 'true'
            gripPos = start
          }
          const resolveHover = () => {
            hoverFrame = 0
            if (!hoverPoint || !view.editable || view.composing || session || pointer || destroyed || view.dom.querySelector('.layout-resizing')) return
            const next = hoveredSnapBlock(view, hoverPoint.x, hoverPoint.y, pos)
            if (next == null) {
              hide()
              return
            }
            positionHover(next)
            showGrip(next)
            const hit = document.elementFromPoint(hoverPoint.x, hoverPoint.y)
            // Only a block's own drag surface (table, code, drawing...) is draggable here; text and blank space select.
            const draggable = !!hit?.closest('[data-layout-drag-surface]')
            markOutline(draggable || overGrip)
            view.dom.classList.toggle('layout-surface-hover', draggable)
            setLayoutInteraction(view.dom, draggable ? 'hover' : 'idle')
          }
          const scheduleHover = () => {
            if (!hoverFrame) hoverFrame = requestAnimationFrame(resolveHover)
          }
          const onMove = (e: MouseEvent) => {
            if (!view.editable || view.composing || session || pointer || view.dom.querySelector('.layout-resizing')) return
            hoverModality = 'pointer'
            // Every block shows its grip, whatever sits inside it (a link, a table cell, a checkbox): which block is under the
            // pointer is decided by geometry. Only a popup or a control outside the text hides it.
            if (e.target instanceof Element && !view.dom.contains(e.target) && e.target.closest('button, input, textarea, select, .ds-pop, .toolbar, .ds-toolbar')) {
              hide()
              return
            }
            hoverPoint = { x: e.clientX, y: e.clientY }
            scheduleHover()
          }
          const onFocus = () => {
            if (session || pointer) return
            hide()
            if (!session && !pointer && document.activeElement instanceof Element && document.activeElement.closest('[data-layout-drag-surface]')) {
              setLayoutInteraction(view.dom, 'hover')
              return
            }
          }
          const sourceRange = (source: number): BlockRange | null => {
            const $source = view.state.doc.resolve(source),
              stream = flow($source),
              node = $source.nodeAfter
            if (!node || $source.depth !== stream.depth) return null
            const selected = blockRange(view.state)
            // A selected layout contains nested positions numerically, but its children are
            // different sources. Never let an old parent selection swallow a newly grabbed child.
            if (selected && selected.flowNode === stream.node && selected.flowStart === stream.start && source >= selected.from && source < selected.to) return selected
            return { from: source, to: source + node.nodeSize, nodes: [node], flowStart: stream.start, flowNode: stream.node }
          }
          const openMoveMenu = (source: number, rect: DOMRect) => {
            const range = sourceRange(source)
            if (!range) return
            const selected = blockRange(view.state)
            if (!selected || selected.flowNode !== range.flowNode || selected.flowStart !== range.flowStart || source < selected.from || source >= selected.to)
              view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, source)))
            view.dom.dispatchEvent(new CustomEvent('layout-move-menu', { detail: rect }))
          }
          const surfaceDown = (e: PointerEvent) => {
            if (
              !view.editable ||
              view.composing ||
              session ||
              pointer ||
              view.dom.querySelector('.layout-resizing') ||
              e.button !== 0 ||
              !e.isPrimary ||
              e.pointerType === 'touch' ||
              e.altKey ||
              e.ctrlKey ||
              e.metaKey ||
              e.shiftKey ||
              e.detail > 1 ||
              !isSectionDragSurface(e.target)
            )
              return
            const source = hoveredSnapBlock(view, e.clientX, e.clientY, -1)
            if (source == null) return
            const dom = view.nodeDOM(source)
            if (!(dom instanceof HTMLElement)) return
            const bounds = dom.getBoundingClientRect()
            if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top - 4 || e.clientY > bounds.bottom + 4) return
            // Text and the blank space around it always select. Only a drag surface (or the grip) picks a block up.
            if (!e.target.closest('[data-layout-drag-surface]')) return
            const range = sourceRange(source)
            if (!range) return
            e.preventDefault()
            pointer = {
              id: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              pos: source,
              started: false,
              doc: view.state.doc,
              capture: view.dom,
              chrome: !!e.target.closest('[data-layout-drag-surface]'),
              range,
            }
            setLayoutInteraction(view.dom, 'armed')
            hoverModality = 'pointer'
            suppressSurfaceClick = false
            cancelAnimationFrame(hoverFrame)
            hoverFrame = 0
            positionHover(source)
            markOutline(true)
            view.dom.classList.add('layout-surface-armed')
            try {
              view.dom.setPointerCapture(e.pointerId)
            } catch {
              /* mouseup and window listeners retain cancellation */
            }
          }
          const sectionMenu = (event: Event) => {
            if (!view.editable || view.composing || !(event.target instanceof Element)) return
            const source = snapBlockAtElement(view, event.target)
            if (source == null) return
            event.stopPropagation()
            cancel()
            openMoveMenu(source, event.target.getBoundingClientRect())
          }
          const gripDown = (e: PointerEvent) => {
            if (!view.editable || view.composing || session || pointer || e.button !== 0 || !e.isPrimary || gripPos < 0) return
            const source = gripPos
            const range = sourceRange(source)
            if (!range) return
            e.preventDefault()
            e.stopPropagation()
            pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, pos: source, started: false, doc: view.state.doc, capture: grip, chrome: true, range }
            setLayoutInteraction(view.dom, 'armed')
            hoverModality = 'pointer'
            suppressSurfaceClick = false
            cancelAnimationFrame(hoverFrame)
            hoverFrame = 0
            positionHover(source)
            markOutline(true)
            view.dom.classList.add('layout-surface-armed')
            try {
              grip.setPointerCapture(e.pointerId)
            } catch {
              /* mouseup and window listeners retain cancellation */
            }
          }
          const gripEnter = () => {
            overGrip = true
            clearTimeout(gripTimer)
            if (gripPos >= 0 && !session) {
              positionHover(gripPos)
              markOutline(true)
            }
          }
          const gripLeave = () => {
            overGrip = false
            if (!pointer && !session) {
              markOutline(false)
              scheduleGripHide()
            }
          }
          grip.addEventListener('pointerdown', gripDown)
          grip.addEventListener('pointerenter', gripEnter)
          grip.addEventListener('pointerleave', gripLeave)
          // The card that follows the pointer is placed on every move rather than on the next frame, close by, so it stays in hand.
          const placeCard = () => {
            if (!cursor || session?.mode !== 'drag') return
            preview.hidden = false
            preview.style.left = `${Math.max(8, Math.min(cursor.x + 10, innerWidth - Math.min(preview.offsetWidth, 280) - 8))}px`
            preview.style.top = `${Math.max(8, Math.min(cursor.y + 10, innerHeight - preview.offsetHeight - 8))}px`
          }
          const move = (e: PointerEvent) => {
            if (!session && !pointer && e.target instanceof Node && !area.contains(e.target) && !grip.contains(e.target)) hide()
            if (session?.mode === 'pick' && e.isPrimary) {
              if (picker.contains(e.target as globalThis.Node)) return
              keyboardChoice = null
              cursor = { x: e.clientX, y: e.clientY }
              return
            }
            if (!pointer || e.pointerId !== pointer.id) return
            if (!(e.buttons & 1)) {
              cancel(false, t('Move cancelled.'))
              return
            }
            if (!view.editable || view.composing || pointer.doc !== view.state.doc) return cancel()
            if (!pointer.started) {
              if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 6) return
              const selectionBefore = view.state.selection
              const range = pointer.range
              pointer.started = true
              suppressSurfaceClick = true
              start(range, 'drag', selectionBefore)
              previewTitle.textContent =
                range.nodes.length === 1
                  ? range.nodes[0].textContent.trim().replace(/\s+/g, ' ').slice(0, 90) || t(range.nodes[0].type.name === GROUP ? 'Move layout' : 'Move block')
                  : t('Moving {n} blocks', { n: range.nodes.length })
              setAction(t('Release to leave it where it was'), 'idle')
            }
            e.preventDefault()
            cursor = { x: e.clientX, y: e.clientY }
            placeCard()
          }
          const up = (e: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY' | 'preventDefault'>) => {
            if (!pointer || e.pointerId !== pointer.id) return
            if (!pointer.started) {
              const source = pointer.pos
              const chrome = pointer.chrome
              const dom = view.nodeDOM(source)
              release()
              if (view.editable && !view.composing) {
                if (chrome && dom instanceof HTMLElement) {
                  openMoveMenu(source, dom.getBoundingClientRect())
                  return
                }
                const node = view.state.doc.nodeAt(source),
                  hit = view.posAtCoords({ left: e.clientX, top: e.clientY })
                const selection = node?.isAtom ? NodeSelection.create(view.state.doc, source) : Selection.near(view.state.doc.resolve(hit?.pos ?? source))
                view.dispatch(view.state.tr.setSelection(selection))
                view.focus()
              }
              return
            }
            e.preventDefault()
            geometryChanged()
            locate(e.clientX, e.clientY)
            const error = target?.error
            if (!commit())
              cancel(
                true,
                error === 'max-columns' ? t('A layout can have up to three columns.') : error === 'insufficient-width' ? t('There is not enough room for these columns.') : t('Move cancelled.'),
              )
          }
          const pointerCancel = (e: PointerEvent) => {
            if (pointer?.id === e.pointerId) cancel(false, t('Move cancelled.'))
          }
          const mouseUp = (e: MouseEvent) => {
            if (pointer && e.button === 0) up({ pointerId: pointer.id, clientX: e.clientX, clientY: e.clientY, preventDefault: () => e.preventDefault() })
          }
          const recoverPointer = (e: PointerEvent) => {
            if (pointer && e.isPrimary && e.button === 0) cancel(false, t('Move cancelled.'))
          }
          const visibility = () => {
            if (document.hidden) cancel()
          }
          const surfaceClick = (e: MouseEvent) => {
            if (suppressSurfaceClick) {
              suppressSurfaceClick = false
              e.preventDefault()
              e.stopImmediatePropagation()
            }
          }
          const preventNativeSelection = (e: Event) => {
            if (session?.mode === 'drag' || pointer) e.preventDefault()
          }
          const key = (e: KeyboardEvent) => {
            if (!session && !pointer) {
              if (view.hasFocus() || e.key === 'Tab') {
                hoverModality = 'keyboard'
                hide()
                if (!view.dom.querySelector('.layout-resizing')) setLayoutInteraction(view.dom, 'idle')
              }
              return
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) {
              e.preventDefault()
              e.stopImmediatePropagation()
              const restore = e.key.toLowerCase() === 'y' || e.shiftKey ? redo : undo
              cancel(true)
              restore(view.state, (tr) => view.dispatch(tr))
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopImmediatePropagation()
              cancel(true, t('Move cancelled.'))
              return
            }
            if (session?.mode !== 'pick') return
            if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
              e.preventDefault()
              e.stopImmediatePropagation()
              browse(e.shiftKey || e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1, e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : undefined)
            } else if (e.key === 'Enter' && e.target !== cancelButton) {
              e.preventDefault()
              e.stopImmediatePropagation()
              if (keyboardChoice) showKeyboardChoice(keyboardChoice)
              commit()
            } else if (e.key !== 'Shift' && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
              // The destination picker owns focus; typing must never edit the source underneath.
              e.preventDefault()
              e.stopImmediatePropagation()
            }
          }
          const clickDestination = (e: PointerEvent) => {
            if (session?.mode !== 'pick' || e.button !== 0 || picker.contains(e.target as globalThis.Node)) return
            if (!(e.target instanceof globalThis.Node) || !view.dom.contains(e.target)) {
              cancel()
              return
            }
            if (e.target instanceof Element && e.target.closest('.layout-resizer')) {
              cancel()
              return
            }
            e.preventDefault()
            e.stopImmediatePropagation()
            keyboardChoice = null
            geometryChanged()
            locate(e.clientX, e.clientY)
            commit()
          }
          const pick = (event: Event) => {
            const request = (event as CustomEvent<SnapPickRequest>).detail
            if (!request || request.doc !== view.state.doc || !view.editable || view.composing || obstructed()) return
            view.dom.dispatchEvent(new Event(LAYOUT_CANCEL))
            start(request.range, request.mode === 'pick' ? 'pick' : 'drag')
            if (request.mode === 'pick') return
            const range = request.range
            if (request.mode === 'left' || request.mode === 'right') {
              const result = directionalSnapTarget(view.state, range, request.mode, snapContext(view))
              if (!result.target) {
                cancel(true)
                if (result.error === 'max-columns') announce(t('A layout can have up to three columns.'))
                return
              }
              const found = destinations().find((destination) => destination.key === snapKey(result.target))
              paint(found ? validate(found, true) : null)
              const error = target?.error
              if (!commit()) {
                cancel(true)
                if (!found || error === 'insufficient-width') announce(t('There is not enough room for these columns.'))
              }
              return
            }
            const destination =
              request.mode === 'outside-before' || request.mode === 'outside-after'
                ? outsideSnapTarget(view.state, range, request.mode === 'outside-before' ? 'before' : 'after')
                : verticalSnapTarget(view.state, range, request.mode)
            const found = destination && destinations().find((candidate) => candidate.key === snapKey(destination))
            paint(found ? validate(found, true) : null)
            if (!commit()) cancel(true)
          }
          const tickUnsafe = (now: number) => {
            frame = 0
            if (!session) return
            if (!valid()) {
              cancel(false, t('Move cancelled because the page changed.'))
              return
            }
            const elapsed = lastTickAt ? Math.min(32, now - lastTickAt) : 1000 / 60
            lastTickAt = now
            if (cursor) {
              if (session.mode === 'drag') {
                const sc = view.dom.closest<HTMLElement>('.scroller')
                if (sc) {
                  const r = sc.getBoundingClientRect(),
                    edge = 56,
                    top = Math.max(r.top, visibleTop())
                  if (cursor.x >= r.left && cursor.x <= r.right) {
                    // Near the top or bottom the page scrolls, gently at first: faster the deeper the pointer is in the band
                    // (a curve, not a step) and building up over the first EDGE_RAMP ms, so a brief pass does not throw the page.
                    const depth = cursor.y < top + edge ? (cursor.y - top - edge) / edge : cursor.y > r.bottom - edge ? (cursor.y - r.bottom + edge) / edge : 0
                    if (!depth) edgeSince = 0
                    else if (!edgeSince) edgeSince = now
                    const ramp = edgeSince ? Math.min(1, (now - edgeSince) / EDGE_RAMP) : 0
                    const speed = Math.sign(depth) * 16 * Math.min(1, Math.abs(depth)) ** 2 * ramp
                    if (speed) {
                      const before = sc.scrollTop
                      sc.scrollTop += (speed * elapsed) / (1000 / 60)
                      if (sc.scrollTop !== before) geometryChanged()
                    }
                  }
                }
                placeCard()
              }
              // Stationary pointers need no repeated DOM hit-testing or planning; scroll/resize invalidates geometry.
              if (!geometry || geometry !== locatedGeometry || cursor.x !== locatedX || cursor.y !== locatedY) {
                const point = cursor
                locate(point.x, point.y)
                if (session) {
                  locatedGeometry = geometry
                  locatedX = point.x
                  locatedY = point.y
                }
              }
            } else if (keyboardChoice) showKeyboardChoice(keyboardChoice)
            if (session) frame = requestAnimationFrame(tick)
          }
          const tick = (now: number) => {
            try {
              tickUnsafe(now)
            } catch (error) {
              interactionFailed(error)
            }
          }
          const blur = () => cancel(false, t('Move cancelled.'))
          const contextMenu = () => {
            if (session || pointer) cancel(false, t('Move cancelled.'))
          }
          const externalCancel = () => cancel()
          const composition = () => cancel(false, t('Move cancelled.'))
          const outside = (e: FocusEvent) => {
            if (!(e.target instanceof globalThis.Node) || host.contains(e.target) || picker.contains(e.target)) return
            if (session || pointer) cancel()
            else hide()
          }
          const selectionFocus = () => {
            if (!session && hoverModality === 'keyboard' && view.hasFocus()) onFocus()
          }
          const repositionHover = () => {
            geometryChanged()
            if (session || pointer || (hoverOutline.hidden && gripPos < 0)) return
            if (hoverModality === 'pointer' && hoverPoint) scheduleHover()
            else hide()
          }
          area.addEventListener('mousemove', onMove)
          area.addEventListener('mouseleave', hide)
          host.addEventListener('focusin', onFocus)
          view.dom.addEventListener('pointerdown', surfaceDown, true)
          view.dom.addEventListener('layout-section-menu', sectionMenu)
          view.dom.addEventListener('selectstart', preventNativeSelection)
          view.dom.addEventListener('dragstart', preventNativeSelection)
          window.addEventListener('pointermove', move, { passive: false })
          window.addEventListener('pointerup', up)
          window.addEventListener('mouseup', mouseUp)
          window.addEventListener('pointerdown', recoverPointer, true)
          window.addEventListener('pointercancel', pointerCancel)
          window.addEventListener('lostpointercapture', pointerCancel)
          window.addEventListener('click', surfaceClick, true)
          window.addEventListener('pointerdown', clickDestination, true)
          window.addEventListener('blur', blur)
          window.addEventListener('pagehide', blur)
          document.addEventListener('visibilitychange', visibility)
          window.addEventListener('contextmenu', contextMenu)
          window.addEventListener('keydown', key, true)
          window.addEventListener('scroll', repositionHover, true)
          window.addEventListener('resize', repositionHover)
          window.visualViewport?.addEventListener('resize', geometryChanged)
          window.visualViewport?.addEventListener('scroll', geometryChanged)
          document.addEventListener('focusin', outside)
          view.dom.addEventListener('compositionstart', composition)
          view.dom.addEventListener(LAYOUT_CANCEL, externalCancel)
          view.dom.addEventListener(SNAP_PICK, pick)
          return {
            update: (_view, prev) => {
              if (!view.editable || (view.state.doc !== prev.doc && (session || pointer))) {
                cancel(false, t('Move cancelled because the page changed.'), false)
              } else if (view.state.doc !== prev.doc) {
                // Idle typing updates ownership in-place instead of hiding/reappearing each transaction.
                geometryChanged()
                cache.clear()
                pos = -1
                if (hoverModality === 'pointer' && hoverPoint) resolveHover()
                else if (view.hasFocus()) onFocus()
                else hide()
              } else selectionFocus()
            },
            destroy: () => {
              destroyed = true
              cancel()
              clearTimeout(menuClickTimer)
              clearTimeout(announcementTimer)
              cancelAnimationFrame(hoverFrame)
              area.removeEventListener('mousemove', onMove)
              area.removeEventListener('mouseleave', hide)
              host.removeEventListener('focusin', onFocus)
              view.dom.removeEventListener('pointerdown', surfaceDown, true)
              view.dom.removeEventListener('layout-section-menu', sectionMenu)
              view.dom.removeEventListener('selectstart', preventNativeSelection)
              view.dom.removeEventListener('dragstart', preventNativeSelection)
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              window.removeEventListener('mouseup', mouseUp)
              window.removeEventListener('pointerdown', recoverPointer, true)
              window.removeEventListener('pointercancel', pointerCancel)
              window.removeEventListener('lostpointercapture', pointerCancel)
              window.removeEventListener('click', surfaceClick, true)
              window.removeEventListener('pointerdown', clickDestination, true)
              window.removeEventListener('blur', blur)
              window.removeEventListener('pagehide', blur)
              document.removeEventListener('visibilitychange', visibility)
              window.removeEventListener('contextmenu', contextMenu)
              window.removeEventListener('keydown', key, true)
              window.removeEventListener('scroll', repositionHover, true)
              window.removeEventListener('resize', repositionHover)
              window.visualViewport?.removeEventListener('resize', geometryChanged)
              window.visualViewport?.removeEventListener('scroll', geometryChanged)
              document.removeEventListener('focusin', outside)
              view.dom.removeEventListener('compositionstart', composition)
              view.dom.removeEventListener(LAYOUT_CANCEL, externalCancel)
              view.dom.removeEventListener(SNAP_PICK, pick)
              clearTimeout(gripTimer)
              grip.remove()
              overlay.remove()
              sourceOverlay.remove()
              hoverOutline.remove()
              columnHighlight.remove()
              preview.remove()
              announcement.remove()
              picker.remove()
            },
          }
        },
      }),
    ]
  },
})
