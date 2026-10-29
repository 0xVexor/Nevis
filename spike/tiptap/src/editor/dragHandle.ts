import { Extension } from '@tiptap/core'
import { Plugin, NodeSelection, Selection } from '@tiptap/pm/state'
import { redo, undo } from '@tiptap/pm/history'
import type { EditorView } from '@tiptap/pm/view'
import { COLUMN, GROUP, GAP, ancestor, blockRange, flow, type BlockRange } from './layoutModel'
import { LAYOUT_CANCEL } from './layout'
import { directionalSnapTarget, fitsSnapColumns, outsideSnapTarget, planSnap, snapKey, snapTransaction, verticalSnapTarget, type SnapContext, type SnapFailure, type SnapPlan } from './snapModel'
import { chooseSnapDestination, containsSnapPoint, hitsSnapDestination, snapContext, snapDestinations, type SnapDestination } from './snapTargets'
import { t } from '../i18n'
import { hoveredSnapBlock, snapBlockAtElement } from './snapHover'
import { isOverSectionText, isSectionDragSurface } from './snapSurface'
import { setLayoutInteraction } from './layoutInteraction'

const MIME = 'application/x-nevis-block-move'
let pickerSequence = 0
export const SNAP_PICK = 'layout-snap-pick'
export interface SnapPickRequest { range: BlockRange; doc: EditorView['state']['doc']; mode: 'pick' | 'up' | 'down' | 'left' | 'right' | 'outside-before' | 'outside-after' }

/** Both the chooser and the full-size ghost show the same planned extraction result. */
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
    const moved = row([100], 0), rest = row(remaining, -1)
    miniature.append(...(extraction.side === 'before' ? [moved, rest] : [rest, moved]))
  } else {
    const widths = columns ? columns.rtl ? [...columns.widths].reverse() : columns.widths : [100]
    const active = columns ? columns.rtl ? widths.length - 1 - columns.active : columns.active : 0
    miniature.append(row(widths, active))
  }
  return miniature
}

/** Pointer and keyboard share one planner, preview, commit, and cancellation lifecycle per editor. */
export const DragHandle = Extension.create({
  name: 'dragHandle',
  priority: 1050,
  addProseMirrorPlugins() {
    return [new Plugin({
      props: { handleDrop: (_view, event) => event.dataTransfer?.types.includes(MIME) ?? false },
      view(view) {
        const host = view.dom.parentElement
        if (!host) return {}
        const overlay = document.createElement('div')
        overlay.className = 'layout-snap-overlay'
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
        const tray = document.createElement('div')
        tray.className = 'layout-snap-tray'
        tray.dir = 'ltr'
        tray.setAttribute('aria-hidden', 'true')
        tray.hidden = true
        const preview = document.createElement('div')
        preview.className = 'layout-drag-preview'
        preview.setAttribute('aria-hidden', 'true')
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
        cancelButton.className = 'ghost-btn'
        cancelButton.textContent = t('Cancel')
        picker.append(hint, choice, cancelButton)
        overlay.hidden = true; preview.hidden = true; picker.hidden = true
        document.body.append(overlay, sourceOverlay, hoverOutline, columnHighlight, tray, preview, announcement, picker)
        let pos = -1, frame = 0, menuClickTimer = 0, announcementTimer = 0
        let destroyed = false, suppressSurfaceClick = false
        let hoverFrame = 0
        let hoverPoint: { x: number; y: number } | null = null
        let hoverModality: 'pointer' | 'keyboard' = 'keyboard'
        let cursor: { x: number; y: number } | null = null
        let pointer: {
          id: number; x: number; y: number; pos: number; started: boolean; doc: EditorView['state']['doc']
          capture: HTMLElement | null; chrome: boolean; range: BlockRange
        } | null = null
        let session: { range: BlockRange; doc: EditorView['state']['doc']; mode: 'drag' | 'pick'; direction: string; selectionBefore?: Selection; context: SnapContext } | null = null
        let target: SnapDestination | null = null
        // Cache eligibility only. Keeping a full document plan for every destination is quadratic memory.
        let cache = new Map<string, { error?: SnapFailure; columns?: SnapPlan['columns']; extraction?: SnapPlan['extraction'] }>()
        let keyboardChoice: string | null = null
        let lastPaint = ''
        let trayOwner = ''
        let traySlots: string[] = []
        let trayPendingOwner = '', trayPendingAt = 0
        let trayAnchor = { x: 0, y: 0 }
        const hideTray = () => { tray.hidden = true; trayOwner = ''; traySlots = []; trayPendingOwner = ''; trayPendingAt = 0 }
        let geometry: SnapDestination[] | null = null
        let locatedGeometry: SnapDestination[] | null = null
        let locatedX = NaN, locatedY = NaN, lastTickAt = 0
        const geometryChanged = () => { geometry = null }
        const geometryObserver = new ResizeObserver(() => { geometryChanged(); hideTray() })
        const setChoice = (message: string) => { if (choice.textContent !== message) choice.textContent = message }
        const announce = (message: string) => {
          clearTimeout(announcementTimer)
          announcement.textContent = ''
          announcementTimer = window.setTimeout(() => { if (!destroyed) announcement.textContent = message }, 0)
        }
        const clipToEditor = (element: HTMLElement, r: { left: number; top: number; width: number; height: number }, insertion = false) => {
          const scroller = view.dom.closest<HTMLElement>('.scroller')?.getBoundingClientRect()
          const editorRect = view.dom.getBoundingClientRect()
          const toolbar = view.dom.closest('.page')?.querySelector<HTMLElement>('.toolbar')?.getBoundingClientRect()
          const top = Math.max(0, scroller?.top ?? 0, insertion ? Math.min(editorRect.top, r.top) : editorRect.top, toolbar?.bottom ?? 0)
          const bottom = Math.min(innerHeight, scroller?.bottom ?? innerHeight, insertion ? Math.max(editorRect.bottom, r.top + r.height) : editorRect.bottom)
          const left = Math.max(0, scroller?.left ?? 0, editorRect.left)
          const right = Math.min(innerWidth, scroller?.right ?? innerWidth, editorRect.right)
          element.style.clipPath = `inset(${Math.max(0, top - r.top)}px ${Math.max(0, r.left + r.width - right)}px ${Math.max(0, r.top + r.height - bottom)}px ${Math.max(0, left - r.left)}px)`
        }
        const hide = () => {
          cancelAnimationFrame(hoverFrame); hoverFrame = 0
          hoverOutline.hidden = true; pos = -1; hoverPoint = null
          view.dom.classList.remove('layout-surface-hover')
          if (!session && !pointer && !view.dom.querySelector('.layout-resizing')) setLayoutInteraction(view.dom, 'idle')
        }
        const release = () => {
          const id = pointer?.id
          const capture = pointer?.capture
          pointer = null
          view.dom.classList.remove('layout-surface-armed')
          if (!session) setLayoutInteraction(view.dom, 'idle')
          if (id != null && capture) { try { if (capture.hasPointerCapture(id)) capture.releasePointerCapture(id) } catch { /* capture already gone */ } }
        }
        const cancel = (restoreFocus = false, message = '', restoreSelection = true) => {
          const previous = session
          const wasActive = !!session
          session = null
          release()
          cancelAnimationFrame(frame); frame = 0
          cancelAnimationFrame(hoverFrame); hoverFrame = 0
          overlay.hidden = true; preview.hidden = true; picker.hidden = true
          columnHighlight.hidden = true
          hideTray()
          overlay.replaceChildren(); lastPaint = ''
          target = null; cursor = null; keyboardChoice = null; cache.clear()
          geometry = null; geometryObserver.disconnect()
          locatedGeometry = null; locatedX = NaN; locatedY = NaN; lastTickAt = 0
          sourceOverlay.replaceChildren()
          view.dom.classList.remove('layout-dragging', 'layout-snap-picking', 'layout-surface-hover')
          setLayoutInteraction(view.dom, 'idle')
          hoverOutline.hidden = true; pos = -1; hoverPoint = null
          if (message && wasActive) announce(message)
          if (!destroyed && restoreSelection && previous?.selectionBefore && previous.doc === view.state.doc && !previous.selectionBefore.eq(view.state.selection)) {
            view.dispatch(view.state.tr.setSelection(previous.selectionBefore))
          }
          if (restoreFocus && !destroyed) view.focus()
          clearTimeout(menuClickTimer)
          menuClickTimer = window.setTimeout(() => { suppressSurfaceClick = false }, 0)
        }
        cancelButton.onclick = () => cancel(true, t('Move cancelled.'))
        const interactionFailed = (error: unknown) => {
          console.error('[layout] Interaction cancelled after an unexpected error', error)
          cancel(true)
          announce(t('The move could not be completed. Please try again.'))
        }
        const obstructed = () => [...document.querySelectorAll<HTMLElement>('.overlay, [role="dialog"], [role="alertdialog"], .popover, .tb-menu, .slash-menu')]
          .some((dom) => dom.getClientRects().length)
        const valid = () => !!session && session.doc === view.state.doc && view.editable && !view.composing
          && session.direction === getComputedStyle(view.dom).direction
          && !view.dom.querySelector('.layout-resizing')
          && !obstructed()
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
            geometry = snapDestinations(view, session.range)
            sourceOverlay.replaceChildren()
            let at = session.range.from
            for (const node of session.range.nodes) {
              const dom = view.nodeDOM(at)
              if (dom instanceof HTMLElement) {
                const r = dom.getBoundingClientRect(), outline = document.createElement('div')
                outline.className = 'layout-snap-source-outline'
                outline.style.left = `${r.left}px`; outline.style.top = `${r.top}px`
                outline.style.width = `${r.width}px`; outline.style.height = `${r.height}px`
                sourceOverlay.append(outline)
              }
              at += node.nodeSize
            }
            clipToEditor(sourceOverlay, { left: 0, top: 0, width: innerWidth, height: innerHeight })
          }
          return geometry
        }
        const paint = (destination: SnapDestination | null) => {
          if (target && target.key !== destination?.key) delete target.plan
          target = destination
          Array.from(tray.children).forEach((cell) => cell.classList.toggle('layout-snap-tray-active',
            !!destination && !destination.error && (cell as HTMLElement).dataset.snapKey === destination.key))
          if (!destination || destination.error || !destination.plan) {
            overlay.hidden = true; columnHighlight.hidden = true; lastPaint = ''
            const message = destination?.error === 'max-columns' ? t('A layout can have up to three columns.')
              : destination?.error === 'insufficient-width' ? t('There is not enough room for these columns.') : t('Choose a destination')
            if (session?.mode === 'pick') setChoice(message)
            else if (session?.mode === 'drag') preview.textContent = message
            return
          }
          const { rect, plan } = destination
          const signature = `${destination.key}:${rect.left}:${rect.top}:${rect.width}:${rect.height}:${plan.columns?.widths.join(',')}`
          if (signature !== lastPaint) {
            lastPaint = signature
            overlay.classList.toggle('layout-snap-line', destination.kind === 'line')
            overlay.style.left = `${rect.left}px`; overlay.style.top = `${rect.top}px`
            overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`
            if (plan.columns || destination.kind === 'full-width') {
              const widths = plan.columns ? plan.columns.rtl ? [...plan.columns.widths].reverse() : plan.columns.widths : [100]
              const active = plan.columns ? plan.columns.rtl ? widths.length - 1 - plan.columns.active : plan.columns.active : 0
              overlay.style.gridTemplateColumns = widths.map((w) => `minmax(0, ${w}fr)`).join(' ')
              overlay.style.gap = `${GAP}px`
              if (overlay.childElementCount !== widths.length) {
                overlay.replaceChildren(...widths.map(() => document.createElement('div')))
              }
              Array.from(overlay.children).forEach((column, i) => {
                column.className = 'layout-snap-column' + (i === active ? ' layout-snap-active' : '')
                column.textContent = destination.kind === 'full-width' ? t('Full width') : ''
                if (destination.kind === 'full-width' && plan.extraction) column.prepend(snapMiniature(undefined, plan.extraction))
              })
            } else { overlay.replaceChildren(); overlay.style.gridTemplateColumns = ''; overlay.style.gap = '' }
          }
          overlay.hidden = false
          clipToEditor(overlay, rect, destination.kind === 'full-width')
          const column = destination.columnRect
          columnHighlight.hidden = !column
          if (column) {
            columnHighlight.style.left = `${column.left}px`; columnHighlight.style.top = `${column.top}px`
            columnHighlight.style.width = `${column.width}px`; columnHighlight.style.height = `${column.height}px`
            clipToEditor(columnHighlight, column)
          }
          const label = plan.columns ? t(plan.columns.action === 'reorder' ? 'Move column · {destination}' : 'New column · {destination}', { destination: destination.label })
            : column ? t('Inside this column · {destination}', { destination: destination.label }) : destination.label
          if (session?.mode === 'pick') setChoice(label)
          else if (plan.columns) {
            const target = destination.target
            const group = target.kind === 'column-gap' ? view.state.doc.nodeAt(target.groupPos) : null
            const side = target.kind === 'pair' ? t(target.side === 'left' ? 'Left' : 'Right')
              : target.kind === 'column-gap' ? t(target.visualGap === 0 ? 'Left' : target.visualGap === group?.childCount ? 'Right' : 'Between') : ''
            preview.textContent = t(plan.columns.action === 'reorder' ? 'Move column · {side}' : 'New column · {side}', { side })
          } else preview.textContent = column ? t('Move into this column') : destination.label
        }
        const showTray = (all: SnapDestination[], x: number, y: number, preferred?: SnapDestination | null) => {
          if (session?.mode !== 'drag' || !pointer?.started) { hideTray(); return }
          const current = tray.getBoundingClientRect()
          // Keep the chooser still while the pointer approaches it; do not chase the pointer.
          if (!tray.hidden && containsSnapPoint(current, x, y, 24)) return
          const sourceGroup = ancestor(view.state.doc.resolve(session.range.from), GROUP)
          const leaving = sourceGroup && preferred?.target.kind === 'insert'
            && (preferred.target.pos === sourceGroup.pos || preferred.target.pos === sourceGroup.pos + sourceGroup.node.nodeSize)
          const group = leaving ? all.find((destination) => destination.target.kind === 'column-gap' && destination.target.groupPos === sourceGroup.pos)
            : all.find((destination) => destination.target.kind === 'column-gap' && y >= destination.rect.top
            && y <= destination.rect.top + destination.rect.height && x >= destination.rect.left - 28 && x <= destination.rect.left + destination.rect.width + 28)
          const pair = group ? undefined : all.find((destination) => destination.target.kind === 'pair' && containsSnapPoint(destination.rect, x, y))
          // Stacked layouts have no horizontal seams, but extraction must still have a chooser.
          const sourceDOM = sourceGroup && view.nodeDOM(sourceGroup.pos)
          const inSourceGroup = sourceDOM instanceof HTMLElement && containsSnapPoint(sourceDOM.getBoundingClientRect(), x, y)
          const groupPos = group?.target.kind === 'column-gap' ? group.target.groupPos
            : sourceGroup && (leaving || inSourceGroup) ? sourceGroup.pos : null
          const blockPos = pair?.target.kind === 'pair' ? pair.target.targetFrom : null
          const owner = groupPos != null ? `${leaving ? 'exit' : 'group'}:${groupPos}` : blockPos != null ? `block:${blockPos}` : ''
          const horizontal = groupPos != null
            ? all.filter((destination) => destination.target.kind === 'column-gap' && destination.target.groupPos === groupPos)
              .sort((a, b) => a.target.kind === 'column-gap' && b.target.kind === 'column-gap' ? a.target.visualGap - b.target.visualGap : 0)
            : blockPos != null ? all.filter((destination) => destination.target.kind === 'pair' && destination.target.targetFrom === blockPos)
              .sort((a, b) => Number(a.target.kind === 'pair' && a.target.side === 'right') - Number(b.target.kind === 'pair' && b.target.side === 'right')) : []
          const options = horizontal.map((destination, index) => ({ destination, vertical: false,
            label: index === 0 ? t('Left') : index === horizontal.length - 1 ? t('Right')
              : horizontal.length === 3 ? t('Between') : `${index} · ${index + 1}` }))
          // The same chooser offers above/below for entering AND leaving a layout.
          const anchorPos = groupPos ?? blockPos
          const anchorNode = anchorPos != null ? view.state.doc.nodeAt(anchorPos) : null
          if (anchorPos != null && anchorNode) {
            for (const [index, pos] of [anchorPos, anchorPos + anchorNode.nodeSize].entries()) {
              const destination = all.find((candidate) => candidate.target.kind === 'insert' && candidate.target.pos === pos)
              if (destination) options.push({ destination, vertical: true, label: t(index === 0 ? 'Above' : 'Below') })
            }
          }
          // A no-op is not a choice. Show only outcomes the planner can actually commit.
          const slots = options.filter(({ destination }) => !validate(destination).error)
          if (!slots.length) { hideTray(); return }
          const horizontalCount = slots.filter((slot) => !slot.vertical).length
          if (owner === trayOwner && !tray.hidden) return
          if (owner !== trayPendingOwner) {
            tray.hidden = true; traySlots = []; trayOwner = ''
            trayPendingOwner = owner; trayPendingAt = performance.now(); trayAnchor = { x, y }
          }
          // Passing over rows should not repeatedly spawn menus. The chooser settles once per owner.
          if (performance.now() - trayPendingAt < 120) return
          trayOwner = owner; traySlots = slots.map(({ destination }) => destination.key)
          tray.replaceChildren()
          const hasExits = slots.some((slot) => slot.vertical)
          tray.classList.toggle('layout-snap-tray-with-exits', hasExits)
          tray.style.gridTemplateColumns = hasExits ? `repeat(${Math.max(1, horizontalCount) * 2}, minmax(0, 1fr))` : ''
          slots.forEach(({ destination, vertical, label: caption }) => {
            const cell = document.createElement('div')
            cell.className = 'layout-snap-tray-slot'
            cell.dataset.snapKey = destination.key
            cell.setAttribute('aria-label', destination.label)
            if (hasExits) cell.style.gridColumn = `span ${vertical ? Math.max(1, horizontalCount) : 2}`
            const result = cache.get(destination.key)
            const miniature = snapMiniature(result?.columns, result?.extraction)
            const label = document.createElement('span')
            label.dir = 'auto'
            label.textContent = caption
            cell.append(miniature, label); tray.append(cell)
          })
          const area = view.dom.closest<HTMLElement>('.scroller')?.getBoundingClientRect() ?? view.dom.getBoundingClientRect()
          const toolbar = view.dom.closest('.page')?.querySelector<HTMLElement>('.toolbar')?.getBoundingClientRect()
          const width = Math.min(Math.max(208, horizontalCount * 72 + 8), area.width - 24, innerWidth - 24)
          const topEdge = Math.max(8, area.top + 8, (toolbar?.bottom ?? 0) + 8)
          tray.style.width = `${width}px`
          tray.style.left = `${Math.max(area.left + 12, Math.min(trayAnchor.x - width / 2, area.right - width - 12))}px`
          tray.hidden = false
          const height = tray.offsetHeight
          const top = trayAnchor.y - height - 12 >= topEdge ? trayAnchor.y - height - 12 : trayAnchor.y + 24
          tray.style.top = `${Math.max(topEdge, Math.min(top, area.bottom - height - 8))}px`
        }
        const trayDestination = (all: SnapDestination[], x: number, y: number) => {
          if (tray.hidden || !containsSnapPoint(tray.getBoundingClientRect(), x, y)) return null
          let index = -1, nearest = Infinity
          Array.from(tray.children).forEach((cell, i) => {
            const r = cell.getBoundingClientRect(), distance = containsSnapPoint(r, x, y) ? -1
              : Math.hypot(x - r.left - r.width / 2, y - r.top - r.height / 2)
            if (distance < nearest) { nearest = distance; index = i }
          })
          const destination = all.find((candidate) => candidate.key === traySlots[index])
          if (!destination) { hideTray(); return null }
          Array.from(tray.children).forEach((node, i) => node.classList.toggle('layout-snap-tray-active', i === index))
          return validate(destination, true)
        }
        const pullOutDestination = (all: SnapDestination[], x: number, y: number): SnapDestination | null => {
          if (!session || session.mode !== 'drag' || !pointer?.started) return null
          const dx = x - pointer.x, dy = y - pointer.y
          if (Math.abs(dy) < 24 || Math.abs(dy) < Math.abs(dx) * 1.25) return null
          const $source = view.state.doc.resolve(session.range.from)
          const column = ancestor($source, COLUMN), group = ancestor($source, GROUP)
          if (!column || !group) return null
          const columnDOM = view.nodeDOM(column.pos), groupDOM = view.nodeDOM(group.pos)
          if (!(columnDOM instanceof HTMLElement) || !(groupDOM instanceof HTMLElement)) return null
          const c = columnDOM.getBoundingClientRect(), g = groupDOM.getBoundingClientRect()
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
          if (!valid()) { if (session) cancel(false, t('Move cancelled because the page changed.')); return }
          const all = destinations()
          const chosen = trayDestination(all, x, y)
          if (chosen) { paint(chosen); return }
          const pulled = pullOutDestination(all, x, y)
          if (pulled) {
            const hit = document.elementFromPoint(x, y)
            if (hit && (view.dom.contains(hit) || tray.contains(hit))) {
              showTray(all, x, y, pulled); paint(validate(pulled, true)); return
            }
          }
          // Do not target content behind a modal, menu, scrollbar, or another editor.
          const hit = document.elementFromPoint(x, y)
          const group = hit instanceof Element ? hit.closest<HTMLElement>('.layout-group') : null
          const within = !!hit && view.dom.contains(hit)
          const editor = view.dom.getBoundingClientRect()
          const margin = hit instanceof Element && !hit.closest('button, input, textarea, select, .toolbar, .popover')
            && !!view.dom.closest('.page')?.contains(hit) && x >= editor.left - 52 && x <= editor.right + 52 && y >= editor.top - 24 && y <= editor.bottom + 24
          const edge = group && view.dom.contains(group)
          if (!within && !edge && !margin) {
            if (tray.hidden || !containsSnapPoint(tray.getBoundingClientRect(), x, y, 24)) hideTray()
            paint(null); return
          }
          // Validate hits before hysteresis: forbidden gaps must never fall through.
          for (const destination of all) {
            if (hitsSnapDestination(destination, x, y, 8)) validate(destination)
          }
          const selected = chooseSnapDestination(all, x, y, target)
          showTray(all, x, y, selected)
          paint(selected ? validate(selected, true) : null)
        }
        const locate = (x: number, y: number) => {
          try { locateUnsafe(x, y) } catch (error) { interactionFailed(error) }
        }
        const commitUnsafe = () => {
          if (!valid() || !target?.plan || target.error) return false
          // Re-plan at release, even if a cached preview was valid earlier.
          const result = planSnap(view.state, session!.range, target.target, session!.context)
          if (!result.plan || (result.plan.columns && !fitsSnapColumns(target.rect.width, result.plan.columns.widths))) return false
          const tr = snapTransaction(view.state, result.plan)
          if (!tr) return false
          cancel(false, '', false)
          view.dispatch(tr); view.focus(); announce(t('Content moved. Undo to restore its previous position.'))
          return true
        }
        const commit = () => {
          try { return commitUnsafe() } catch (error) { interactionFailed(error); return false }
        }
        const showKeyboardChoice = (key: string, scroll = false) => {
          let found = destinations().find((destination) => destination.key === key)
          if (!found) { paint(null); return }
          const sc = view.dom.closest<HTMLElement>('.scroller')
          if (scroll && sc) {
            const r = sc.getBoundingClientRect(), top = found.rect.top, bottom = top + Math.max(found.rect.height, 24)
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
          let index = end === 'first' ? 0 : end === 'last' ? choices.length - 1
            : current < 0 ? (direction < 0 ? choices.length - 1 : 0) : (current + direction + choices.length) % choices.length
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
          paint(null); setChoice(t('There are no available destinations.'))
        }
        const start = (range: BlockRange, mode: 'drag' | 'pick', selectionBefore?: Selection) => {
          cancelAnimationFrame(hoverFrame); hoverFrame = 0; hoverOutline.hidden = true
          session = { range, doc: view.state.doc, mode, direction: getComputedStyle(view.dom).direction, selectionBefore, context: snapContext(view) }
          cache = new Map(); keyboardChoice = null; geometry = null
          geometryObserver.observe(view.dom)
          for (const dom of view.dom.querySelectorAll(':scope > *, .layout-column, .layout-column > *')) geometryObserver.observe(dom)
          view.dom.classList.add('layout-dragging')
          setLayoutInteraction(view.dom, mode)
          if (mode === 'pick') {
            hint.textContent = t('Choose a place. Tab or arrow keys to browse, Enter to move, Escape to cancel.')
            cancelButton.textContent = t('Cancel')
            picker.setAttribute('aria-label', t('Choose a destination'))
            view.dom.classList.add('layout-snap-picking')
            picker.hidden = false; picker.dir = getComputedStyle(view.dom).direction
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
          hoverOutline.style.left = `${r.left}px`; hoverOutline.style.top = `${r.top}px`
          hoverOutline.style.width = `${r.width}px`; hoverOutline.style.height = `${r.height}px`
          clipToEditor(hoverOutline, r)
          hoverOutline.hidden = false
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
          const hit = document.elementFromPoint(hoverPoint.x, hoverPoint.y)
          const draggable = isSectionDragSurface(hit)
            && (!!hit.closest('[data-layout-drag-surface]') || !isOverSectionText(view.dom.ownerDocument, hoverPoint.x, hoverPoint.y))
          view.dom.classList.toggle('layout-surface-hover', draggable)
          setLayoutInteraction(view.dom, draggable ? 'hover' : 'idle')
        }
        const scheduleHover = () => { if (!hoverFrame) hoverFrame = requestAnimationFrame(resolveHover) }
        const onMove = (e: MouseEvent) => {
          if (!view.editable || view.composing || session || pointer || view.dom.querySelector('.layout-resizing')) return
          hoverModality = 'pointer'
          if (!isSectionDragSurface(e.target)) { hide(); return }
          hoverPoint = { x: e.clientX, y: e.clientY }
          scheduleHover()
        }
        const onFocus = () => {
          if (session || pointer) return
          hide()
          if (!session && !pointer && document.activeElement instanceof Element && document.activeElement.closest('[data-layout-drag-surface]')) {
            setLayoutInteraction(view.dom, 'hover'); return
          }
        }
        const sourceRange = (source: number): BlockRange | null => {
          const $source = view.state.doc.resolve(source), stream = flow($source), node = $source.nodeAfter
          if (!node || $source.depth !== stream.depth) return null
          const selected = blockRange(view.state)
          // A selected layout contains nested positions numerically, but its children are
          // different sources. Never let an old parent selection swallow a newly grabbed child.
          if (selected && selected.flowNode === stream.node && selected.flowStart === stream.start
            && source >= selected.from && source < selected.to) return selected
          return { from: source, to: source + node.nodeSize, nodes: [node], flowStart: stream.start, flowNode: stream.node }
        }
        const openMoveMenu = (source: number, rect: DOMRect) => {
          const range = sourceRange(source)
          if (!range) return
          const selected = blockRange(view.state)
          if (!selected || selected.flowNode !== range.flowNode || selected.flowStart !== range.flowStart
            || source < selected.from || source >= selected.to) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, source)))
          view.dom.dispatchEvent(new CustomEvent('layout-move-menu', { detail: rect }))
        }
        const surfaceDown = (e: PointerEvent) => {
          if (!view.editable || view.composing || session || pointer || view.dom.querySelector('.layout-resizing') || e.button !== 0 || !e.isPrimary || e.pointerType === 'touch'
            || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.detail > 1 || !isSectionDragSurface(e.target)) return
          const source = hoveredSnapBlock(view, e.clientX, e.clientY, -1)
          if (source == null) return
          const dom = view.nodeDOM(source)
          if (!(dom instanceof HTMLElement)) return
          const bounds = dom.getBoundingClientRect()
          if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top - 4 || e.clientY > bounds.bottom + 4) return
          // Editable glyphs always retain native selection, including slow/multi-column selections.
          if (!e.target.closest('[data-layout-drag-surface]') && isOverSectionText(view.dom.ownerDocument, e.clientX, e.clientY)) return
          const range = sourceRange(source)
          if (!range) return
          e.preventDefault()
          pointer = {
            id: e.pointerId, x: e.clientX, y: e.clientY, pos: source, started: false, doc: view.state.doc, capture: view.dom,
            chrome: !!e.target.closest('[data-layout-drag-surface]'), range,
          }
          setLayoutInteraction(view.dom, 'armed')
          hoverModality = 'pointer'; suppressSurfaceClick = false
          cancelAnimationFrame(hoverFrame); hoverFrame = 0
          positionHover(source)
          view.dom.classList.add('layout-surface-armed')
          try { view.dom.setPointerCapture(e.pointerId) } catch { /* mouseup and window listeners retain cancellation */ }
        }
        const sectionMenu = (event: Event) => {
          if (!view.editable || view.composing || !(event.target instanceof Element)) return
          const source = snapBlockAtElement(view, event.target)
          if (source == null) return
          event.stopPropagation()
          cancel()
          openMoveMenu(source, event.target.getBoundingClientRect())
        }
        const move = (e: PointerEvent) => {
          if (!session && !pointer && e.target instanceof Node && !host.contains(e.target)) hide()
          if (session?.mode === 'pick' && e.isPrimary) {
            if (picker.contains(e.target as globalThis.Node)) return
            keyboardChoice = null; cursor = { x: e.clientX, y: e.clientY }; return
          }
          if (!pointer || e.pointerId !== pointer.id) return
          if (!(e.buttons & 1)) { cancel(false, t('Move cancelled.')); return }
          if (!view.editable || view.composing || pointer.doc !== view.state.doc) return cancel()
          if (!pointer.started) {
            if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 6) return
            const selectionBefore = view.state.selection
            const range = pointer.range
            pointer.started = true
            suppressSurfaceClick = true
            start(range, 'drag', selectionBefore)
            preview.textContent = range.nodes.length === 1 ? range.nodes[0].textContent.slice(0, 90)
              || t(range.nodes[0].type.name === GROUP ? 'Move layout' : 'Move block') : t('Moving {n} blocks', { n: range.nodes.length })
          }
          e.preventDefault()
          cursor = { x: e.clientX, y: e.clientY }
        }
        const up = (e: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY' | 'preventDefault'>) => {
          if (!pointer || e.pointerId !== pointer.id) return
          if (!pointer.started) {
            const source = pointer.pos
            const chrome = pointer.chrome
            const dom = view.nodeDOM(source)
            release()
            if (view.editable && !view.composing) {
              if (chrome && dom instanceof HTMLElement) { openMoveMenu(source, dom.getBoundingClientRect()); return }
              const node = view.state.doc.nodeAt(source), hit = view.posAtCoords({ left: e.clientX, top: e.clientY })
              const selection = node?.isAtom ? NodeSelection.create(view.state.doc, source)
                : Selection.near(view.state.doc.resolve(hit?.pos ?? source))
              view.dispatch(view.state.tr.setSelection(selection)); view.focus()
            }
            return
          }
          e.preventDefault()
          geometryChanged()
          locate(e.clientX, e.clientY)
          const error = target?.error
          if (!commit()) cancel(true, error === 'max-columns' ? t('A layout can have up to three columns.')
            : error === 'insufficient-width' ? t('There is not enough room for these columns.') : t('Move cancelled.'))
        }
        const pointerCancel = (e: PointerEvent) => { if (pointer?.id === e.pointerId) cancel(false, t('Move cancelled.')) }
        const mouseUp = (e: MouseEvent) => {
          if (pointer && e.button === 0) up({ pointerId: pointer.id, clientX: e.clientX, clientY: e.clientY, preventDefault: () => e.preventDefault() })
        }
        const recoverPointer = (e: PointerEvent) => {
          if (pointer && e.isPrimary && e.button === 0) cancel(false, t('Move cancelled.'))
        }
        const visibility = () => { if (document.hidden) cancel() }
        const surfaceClick = (e: MouseEvent) => {
          if (suppressSurfaceClick) { suppressSurfaceClick = false; e.preventDefault(); e.stopImmediatePropagation() }
        }
        const preventNativeSelection = (e: Event) => { if (session?.mode === 'drag' || pointer) e.preventDefault() }
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
            e.preventDefault(); e.stopImmediatePropagation()
            const restore = e.key.toLowerCase() === 'y' || e.shiftKey ? redo : undo
            cancel(true)
            restore(view.state, (tr) => view.dispatch(tr))
            return
          }
          if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(true, t('Move cancelled.')); return }
          if (session?.mode !== 'pick') return
          if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
            e.preventDefault(); e.stopImmediatePropagation()
            browse(e.shiftKey || e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1, e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : undefined)
          } else if (e.key === 'Enter' && e.target !== cancelButton) {
            e.preventDefault(); e.stopImmediatePropagation()
            if (keyboardChoice) showKeyboardChoice(keyboardChoice)
            commit()
          } else if (e.key !== 'Shift' && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
            // The destination picker owns focus; typing must never edit the source underneath.
            e.preventDefault(); e.stopImmediatePropagation()
          }
        }
        const clickDestination = (e: PointerEvent) => {
          if (session?.mode !== 'pick' || e.button !== 0 || picker.contains(e.target as globalThis.Node)) return
          if (!(e.target instanceof globalThis.Node) || !view.dom.contains(e.target)) { cancel(); return }
          if (e.target instanceof Element && e.target.closest('.layout-resizer')) { cancel(); return }
          e.preventDefault(); e.stopImmediatePropagation()
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
          const destination = request.mode === 'outside-before' || request.mode === 'outside-after'
            ? outsideSnapTarget(view.state, range, request.mode === 'outside-before' ? 'before' : 'after')
            : verticalSnapTarget(view.state, range, request.mode)
          const found = destination && destinations().find((candidate) => candidate.key === snapKey(destination))
          paint(found ? validate(found, true) : null)
          if (!commit()) cancel(true)
        }
        const tickUnsafe = (now: number) => {
          frame = 0
          if (!session) return
          if (!valid()) { cancel(false, t('Move cancelled because the page changed.')); return }
          const elapsed = lastTickAt ? Math.min(32, now - lastTickAt) : 1000 / 60
          lastTickAt = now
          if (cursor) {
            if (session.mode === 'drag') {
              const sc = view.dom.closest<HTMLElement>('.scroller')
              if (sc && (tray.hidden || !containsSnapPoint(tray.getBoundingClientRect(), cursor.x, cursor.y, 12))) {
                const r = sc.getBoundingClientRect(), edge = 48
                if (cursor.x >= r.left && cursor.x <= r.right) {
                  const speed = cursor.y < r.top + edge ? -Math.min(12, (r.top + edge - cursor.y) / 4)
                    : cursor.y > r.bottom - edge ? Math.min(12, (cursor.y - r.bottom + edge) / 4) : 0
                  if (speed) {
                    const before = sc.scrollTop
                    sc.scrollTop += speed * elapsed / (1000 / 60)
                    if (sc.scrollTop !== before) geometryChanged()
                  }
                }
              }
              preview.hidden = !tray.hidden && containsSnapPoint(tray.getBoundingClientRect(), cursor.x, cursor.y)
              preview.style.left = `${Math.max(8, Math.min(cursor.x + 16, innerWidth - Math.min(preview.offsetWidth, 280) - 8))}px`
              preview.style.top = `${Math.max(8, Math.min(cursor.y + 16, innerHeight - preview.offsetHeight - 8))}px`
            }
            // Stationary pointers need no repeated DOM hit-testing or planning. The delayed
            // chooser still gets one update when it settles; scroll/resize invalidates geometry.
            if (!geometry || geometry !== locatedGeometry || cursor.x !== locatedX || cursor.y !== locatedY
              || (tray.hidden && !!trayPendingOwner && performance.now() - trayPendingAt >= 120)) {
              const point = cursor
              locate(point.x, point.y)
              if (session) { locatedGeometry = geometry; locatedX = point.x; locatedY = point.y }
            }
          } else if (keyboardChoice) showKeyboardChoice(keyboardChoice)
          if (session) frame = requestAnimationFrame(tick)
        }
        const tick = (now: number) => {
          try { tickUnsafe(now) } catch (error) { interactionFailed(error) }
        }
        const blur = () => cancel(false, t('Move cancelled.'))
        const contextMenu = () => { if (session || pointer) cancel(false, t('Move cancelled.')) }
        const externalCancel = () => cancel()
        const composition = () => cancel(false, t('Move cancelled.'))
        const outside = (e: FocusEvent) => {
          if (!(e.target instanceof globalThis.Node) || host.contains(e.target) || picker.contains(e.target)) return
          if (session || pointer) cancel()
          else hide()
        }
        const selectionFocus = () => { if (!session && hoverModality === 'keyboard' && view.hasFocus()) onFocus() }
        const repositionHover = () => {
          geometryChanged()
          hideTray()
          if (session || pointer || hoverOutline.hidden) return
          if (hoverModality === 'pointer' && hoverPoint) scheduleHover()
          else hide()
        }
        host.addEventListener('mousemove', onMove)
        host.addEventListener('mouseleave', hide)
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
              geometryChanged(); cache.clear(); pos = -1
              if (hoverModality === 'pointer' && hoverPoint) resolveHover()
              else if (view.hasFocus()) onFocus()
              else hide()
            } else selectionFocus()
          },
          destroy: () => {
            destroyed = true; cancel()
            clearTimeout(menuClickTimer); clearTimeout(announcementTimer)
            cancelAnimationFrame(hoverFrame)
            host.removeEventListener('mousemove', onMove)
            host.removeEventListener('mouseleave', hide)
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
            overlay.remove(); sourceOverlay.remove(); hoverOutline.remove(); columnHighlight.remove(); tray.remove(); preview.remove(); announcement.remove(); picker.remove()
          },
        }
      },
    })]
  },
})
