import { Node, Extension, mergeAttributes, type Command } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state'
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history'
import { confirmDialog } from '../dialog'
import { t } from '../i18n'
import { blockIdentityPending, isBlockIdentityTransaction } from './blockIdentity'
import {
  GROUP, COLUMN, GAP, MIN_WIDTH, activeGroup, ancestor, blockRange, boundaryKey,
  crossesColumns, displayWidths, equalWidths, flattenGroup, flattenLayouts, focusIn,
  groupColumns, layoutStructureValid, structural, validWidths,
} from './layoutModel'
import { planSnap, snapTransaction, verticalSnapTarget } from './snapModel'
import { snapContext } from './snapTargets'
import { crossColumnClipboard, editAcrossColumns, insideTable } from './layoutEditing'
import { navigateLayout } from './layoutNavigation'
import { setLayoutInteraction } from './layoutInteraction'

export const LAYOUT_CANCEL = 'layout-cancel'
export const layoutMessage = (message: string) => window.dispatchEvent(new CustomEvent('layout-message', { detail: t(message) }))
const reject = (message: string, dispatch: unknown) => { if (dispatch) layoutMessage(message); return false }

// Positions are resolved at command execution time; async callers must recheck the document first.
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageLayout: {
      insertLayout: (count: number) => ReturnType
      setLayoutColumns: (count: number, pos?: number) => ReturnType
      setLayoutWidths: (widths: number[], pos?: number) => ReturnType
      setLayoutDirection: (direction: 'ltr' | 'rtl' | null, pos?: number) => ReturnType
      addAfterLayout: (pos?: number) => ReturnType
      deleteLayout: (pos?: number) => ReturnType
      moveToLayout: (columnPos: number, end?: boolean) => ReturnType
      moveOutsideLayout: (groupPos?: number, after?: boolean) => ReturnType
      shiftLayoutBlock: (direction: -1 | 1) => ReturnType
    }
  }
}

const groupAt = (state: Parameters<Command>[0]['state'], pos?: number) => {
  if (pos == null) return activeGroup(state)
  const node = state.doc.nodeAt(pos)
  return node?.type.name === GROUP ? { node, pos, depth: 1 } : null
}

export const LayoutGroup = Node.create({
  name: GROUP,
  group: 'block',
  content: 'layoutColumn{2,3}',
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      widths: {
        default: null,
        parseHTML: (el) => { try { return JSON.parse(el.getAttribute('data-widths') || 'null') } catch { return null } },
        renderHTML: (attrs) => ({ 'data-widths': JSON.stringify(attrs.widths) }),
      },
      direction: {
        default: null,
        parseHTML: (el) => ['rtl', 'ltr'].includes(el.getAttribute('dir') || '') ? el.getAttribute('dir') : null,
        renderHTML: (attrs) => attrs.direction ? { dir: attrs.direction } : {},
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="layout-group"]' }],
  renderHTML({ node, HTMLAttributes }) {
    const widths = displayWidths(node)
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'layout-group', class: 'layout-group layout-export', style: `--layout-tracks:${widths.map((w) => `minmax(0, ${w}fr)`).join(' ')};--layout-min:${node.childCount * MIN_WIDTH + (node.childCount - 1) * GAP}px` }), 0]
  },
  addCommands() {
    return {
      insertLayout: (count) => ({ state, tr, dispatch, editor }) => {
        if (!editor.isEditable || editor.view.composing || ![2, 3].includes(count)) return false
        if (ancestor(state.selection.$from, COLUMN)) return reject('Layouts cannot be nested. Add full-width text after this layout first.', dispatch)
        if (crossesColumns(state)) return reject('Select blocks from one column.', dispatch)
        const selected = !state.selection.empty
        const range = selected ? blockRange(state, false) : null
        if (selected && (!range || range.nodes.some((n) => n.type.name === GROUP))) return reject('Select complete blocks to create a layout.', dispatch)
        const paragraph = state.schema.nodes.paragraph
        const cols = Array.from({ length: count }, (_, i) => state.schema.nodes[COLUMN].create(null, i === 0 && range ? Fragment.fromArray(range.nodes) : paragraph.create()))
        const node = state.schema.nodes[GROUP].create({ widths: equalWidths(count) }, cols)
        if (dispatch) {
          let at: number
          if (range) { at = range.from; tr.replaceWith(range.from, range.to, node) }
          else {
            const { $from } = state.selection
            if ($from.depth === 0) { at = $from.pos; tr.insert(at, node) }
            else {
              // Never split a partially edited block or capture its neighbours.
              const block = $from.node(1)
              if ($from.depth === 1 && block.type.name === 'paragraph' && block.content.size === 0) {
                at = $from.before(1); tr.replaceWith(at, at + block.nodeSize, node)
              } else { at = $from.after(1); tr.insert(at, node) }
            }
          }
          structural(tr); focusIn(tr, at + 3)
        }
        return true
      },
      setLayoutColumns: (count, pos) => ({ state, tr, dispatch, editor }) => {
        const group = groupAt(state, pos)
        if (crossesColumns(state)) return reject('Select blocks from one column.', dispatch)
        if (!editor.isEditable || editor.view.composing || !group || ![1, 2, 3].includes(count)) return false
        if (count === group.node.childCount) return true
        if (dispatch) {
          const { node, pos: at } = group
          if (count === 1) tr.replaceWith(at, at + node.nodeSize, Fragment.fromArray(flattenGroup(node)))
          else {
            const cols = Array.from({ length: Math.min(count, node.childCount) }, (_, i) => node.child(i))
            if (count < node.childCount) {
              let content = cols[count - 1].content
              for (let i = count; i < node.childCount; i++) content = content.append(node.child(i).content)
              cols[count - 1] = cols[count - 1].copy(content)
            }
            while (cols.length < count) cols.push(state.schema.nodes[COLUMN].create(null, state.schema.nodes.paragraph.create()))
            tr.replaceWith(at, at + node.nodeSize, node.type.create({ ...node.attrs, widths: equalWidths(count) }, cols))
          }
          structural(tr); focusIn(tr, at + (count === 1 ? 1 : 3))
        }
        return true
      },
      setLayoutWidths: (widths, pos) => ({ state, tr, dispatch, editor }) => {
        const group = groupAt(state, pos)
        if (!editor.isEditable || editor.view.composing || !group || !validWidths(widths, group.node.childCount)) return false
        if (JSON.stringify(widths) === JSON.stringify(group.node.attrs.widths)) return true
        if (dispatch) structural(tr).setNodeMarkup(group.pos, undefined, { ...group.node.attrs, widths: [...widths] })
        return true
      },
      setLayoutDirection: (direction, pos) => ({ state, tr, dispatch, editor }) => {
        const group = groupAt(state, pos)
        if (crossesColumns(state)) return reject('Select blocks from one column.', dispatch)
        if (!editor.isEditable || editor.view.composing || !group || ![null, 'rtl', 'ltr'].includes(direction)) return false
        if (group.node.attrs.direction === direction) return true
        if (dispatch) structural(tr).setNodeMarkup(group.pos, undefined, { ...group.node.attrs, direction })
        return true
      },
      addAfterLayout: (pos) => ({ state, tr, dispatch, editor }) => {
        const group = groupAt(state, pos)
        if (crossesColumns(state)) return reject('Select blocks from one column.', dispatch)
        if (!editor.isEditable || editor.view.composing || !group) return false
        if (dispatch) {
          const at = group.pos + group.node.nodeSize
          tr.insert(at, state.schema.nodes.paragraph.create())
          structural(tr); focusIn(tr, at + 1)
        }
        return true
      },
      // UI owns confirmation. This command is intentionally synchronous and atomic.
      deleteLayout: (pos) => ({ state, tr, dispatch, editor }) => {
        const group = groupAt(state, pos)
        if (crossesColumns(state)) return reject('Select blocks from one column.', dispatch)
        if (!editor.isEditable || editor.view.composing || !group) return false
        if (dispatch) {
          const { pos: at, node } = group
          if (state.doc.childCount === 1) tr.replaceWith(at, at + node.nodeSize, state.schema.nodes.paragraph.create())
          else tr.delete(at, at + node.nodeSize)
          structural(tr); focusIn(tr, at)
        }
        return true
      },
      moveToLayout: (columnPos, end = true) => ({ state, dispatch, editor }) => {
        if (!editor.isEditable || editor.view.composing) return false
        const range = blockRange(state), col = state.doc.nodeAt(columnPos)
        if (!range) return reject('Select complete blocks from one column.', dispatch)
        if (col?.type.name !== COLUMN) return false
        const target = columnPos + 1 + (end ? col.content.size : 0)
        const result = planSnap(state, range, { kind: 'insert', pos: target }, snapContext(editor.view))
        const tr = result.plan && snapTransaction(state, result.plan)
        if (tr && dispatch) dispatch(tr)
        return !!tr
      },
      moveOutsideLayout: (groupPos, after = true) => ({ state, dispatch, editor }) => {
        if (!editor.isEditable || editor.view.composing) return false
        const range = blockRange(state), group = groupAt(state, groupPos)
        if (!range || !group) return reject('Select complete blocks from one column.', dispatch)
        const result = planSnap(state, range, { kind: 'insert', pos: group.pos + (after ? group.node.nodeSize : 0) }, snapContext(editor.view))
        const tr = result.plan && snapTransaction(state, result.plan)
        if (tr && dispatch) dispatch(tr)
        return !!tr
      },
      shiftLayoutBlock: (direction) => ({ state, dispatch, editor }) => {
        if (!editor.isEditable || editor.view.composing || insideTable(state)) return false
        const range = blockRange(state)
        if (!range) return false
        const target = verticalSnapTarget(state, range, direction === -1 ? 'up' : 'down')
        if (!target) return false
        const result = planSnap(state, range, target, snapContext(editor.view))
        const tr = result.plan && snapTransaction(state, result.plan)
        if (tr && dispatch) dispatch(tr)
        return !!tr
      },
    }
  },
  addNodeView() {
    return ({ node, editor, getPos, view }) => {
      let cur = node
      const dom = document.createElement('div')
      dom.className = 'layout-group'
      dom.dataset.type = 'layout-group'
      dom.setAttribute('role', 'group')
      const body = document.createElement('div')
      body.className = 'layout-columns'
      const grips = document.createElement('div')
      grips.className = 'layout-resizers'
      grips.contentEditable = 'false'
      dom.append(body, grips)
      let cancelResize: (() => void) | null = null
      const draw = (widths = displayWidths(cur)) => {
        if (cur.attrs.direction) dom.dir = cur.attrs.direction
        else dom.removeAttribute('dir')
        body.style.gridTemplateColumns = widths.map((w) => `minmax(0, ${w}fr)`).join(' ')
        dom.setAttribute('aria-label', t('Layout with {n} columns', { n: cur.childCount }))
        dom.dataset.invalidWidths = String(!validWidths(cur.attrs.widths, cur.childCount))
        const available = body.clientWidth - GAP * (cur.childCount - 1)
        const stacked = widths.some((w) => available * w / 100 < MIN_WIDTH)
        dom.classList.toggle('layout-stacked', stacked)
        Array.from(grips.children).forEach((child, i) => {
          const before = widths.slice(0, i + 1).reduce((a, b) => a + b, 0)
          const grip = child as HTMLElement
          grip.style.insetInlineStart = `${available * before / 100 + GAP * (i + 0.5)}px`
          const min = available > 0 ? Math.max(20, MIN_WIDTH / available * 100) : 20
          const max = widths[i] + widths[i + 1] - min
          grip.setAttribute('aria-valuenow', String(Math.round(widths[i])))
          grip.setAttribute('aria-valuemin', String(Math.ceil(min)))
          grip.setAttribute('aria-valuemax', String(Math.max(Math.ceil(min), Math.floor(max))))
          grip.setAttribute('aria-disabled', String(stacked || max < min))
        })
      }
      const makeGrips = () => {
        grips.replaceChildren()
        for (let i = 0; i < cur.childCount - 1; i++) {
          const grip = document.createElement('button')
          grip.type = 'button'
          grip.className = 'layout-resizer'
          grip.setAttribute('role', 'slider')
          grip.setAttribute('aria-orientation', 'horizontal')
          grip.setAttribute('aria-label', t('Resize columns {a} and {b}', { a: i + 1, b: i + 2 }))
          grip.title = t('Drag to resize. Escape cancels. Arrow keys adjust width.')
          grip.onkeydown = (e) => {
            if (!editor.isEditable || view.composing || dom.classList.contains('layout-stacked') || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return
            e.preventDefault(); e.stopPropagation()
            view.dom.dispatchEvent(new Event(LAYOUT_CANCEL))
            const rtl = getComputedStyle(dom).direction === 'rtl'
            const delta = (e.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1)
            const widths = displayWidths(cur).slice(), pair = widths[i] + widths[i + 1]
            const min = Math.max(20, MIN_WIDTH / (body.clientWidth - GAP * (cur.childCount - 1)) * 100)
            if (!Number.isFinite(min) || pair < min * 2) return
            widths[i] = Math.max(min, Math.min(pair - min, widths[i] + delta))
            widths[i + 1] = pair - widths[i]
            const pos = getPos()
            if (pos != null) editor.commands.setLayoutWidths(widths, pos)
          }
          grip.onpointerdown = (e) => {
            if (!editor.isEditable || editor.view.composing || e.button !== 0 || !e.isPrimary || dom.classList.contains('layout-stacked')) return
            e.preventDefault(); e.stopPropagation()
            view.dom.dispatchEvent(new Event(LAYOUT_CANCEL))
            const originalDoc = editor.state.doc, at = getPos()
            if (at == null) return
            const widths = displayWidths(cur).slice(), start = e.clientX
            const usable = body.clientWidth - GAP * (cur.childCount - 1)
            const pair = widths[i] + widths[i + 1], min = Math.max(20, MIN_WIDTH / usable * 100)
            if (!Number.isFinite(min) || pair < min * 2) return
            const rtl = getComputedStyle(dom).direction === 'rtl'
            let preview = widths.slice()
            let finished = false
            dom.classList.add('layout-resizing')
            setLayoutInteraction(view.dom, 'resize')
            const move = (ev: PointerEvent) => {
              if (ev.pointerId !== e.pointerId || finished) return
              if (view.composing || !editor.isEditable || getComputedStyle(dom).direction !== (rtl ? 'rtl' : 'ltr')) { finish(false); return }
              const delta = (ev.clientX - start) / usable * 100 * (rtl ? -1 : 1)
              preview = widths.slice()
              preview[i] = Math.max(min, Math.min(pair - min, widths[i] + delta))
              preview[i + 1] = pair - preview[i]
              draw(preview)
            }
            const finish = (commit: boolean) => {
              if (finished) return
              finished = true
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              window.removeEventListener('pointercancel', pointerCancel)
              window.removeEventListener('blur', cancel)
              window.removeEventListener('pagehide', cancel)
              document.removeEventListener('visibilitychange', visibility)
              window.removeEventListener('keydown', key, true)
              grip.removeEventListener('lostpointercapture', cancel)
              view.dom.removeEventListener('compositionstart', cancel)
              editor.off('transaction', changed)
              cancelResize = null
              dom.classList.remove('layout-resizing')
              setLayoutInteraction(view.dom, 'idle')
              try { if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId) } catch { /* already released */ }
              draw()
              if (commit && !editor.isDestroyed && editor.isEditable && !view.composing && editor.state.doc === originalDoc && JSON.stringify(preview) !== JSON.stringify(widths)) editor.commands.setLayoutWidths(preview, at)
            }
            const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) { move(ev); finish(true) } }
            const cancel = () => finish(false)
            const visibility = () => { if (document.hidden) cancel() }
            const pointerCancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) cancel() }
            const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel() } }
            const changed = () => { if (editor.state.doc !== originalDoc || !editor.isEditable) cancel() }
            cancelResize = cancel
            try { grip.setPointerCapture(e.pointerId) } catch { /* window listeners still cancel */ }
            grip.addEventListener('lostpointercapture', cancel)
            view.dom.addEventListener('compositionstart', cancel)
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
            window.addEventListener('pointercancel', pointerCancel)
            window.addEventListener('blur', cancel, { once: true })
            window.addEventListener('pagehide', cancel)
            document.addEventListener('visibilitychange', visibility)
            window.addEventListener('keydown', key, true)
            editor.on('transaction', changed)
          }
          grips.append(grip)
        }
      }
      makeGrips(); draw()
      let measuredWidth = -1, resizeFrame = 0
      const ro = new ResizeObserver(() => {
        const width = body.clientWidth
        // Text wrapping changes height during a preview; only a container-width change cancels it.
        if (width === measuredWidth) return
        measuredWidth = width
        cancelResize?.()
        cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; draw() })
      })
      ro.observe(body)
      const cancel = () => cancelResize?.()
      view.dom.addEventListener(LAYOUT_CANCEL, cancel)
      return {
        dom, contentDOM: body,
        update: (next) => {
          if (next.type !== cur.type) return false
          cancelResize?.()
          const changedCount = next.childCount !== cur.childCount
          cur = next
          if (changedCount) makeGrips()
          draw(); return true
        },
        selectNode: () => dom.classList.add('ProseMirror-selectednode'),
        deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
        stopEvent: (e) => grips.contains(e.target as HTMLElement),
        ignoreMutation: (m) => grips.contains(m.target) || (m.type === 'attributes' && (m.target === dom || m.target === body)),
        destroy: () => { cancelResize?.(); cancelAnimationFrame(resizeFrame); ro.disconnect(); view.dom.removeEventListener(LAYOUT_CANCEL, cancel) },
      }
    }
  },
})

export const LayoutColumn = Node.create({
  name: COLUMN,
  content: 'block+',
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="layout-column"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'layout-column', class: 'layout-column' }), 0],
  addNodeView() {
    return ({ node, getPos, view }) => {
      const dom = document.createElement('div')
      dom.className = 'layout-column'
      dom.dataset.type = 'layout-column'
      dom.setAttribute('role', 'group')
      const label = () => {
        const pos = getPos()
        if (pos != null) dom.setAttribute('aria-label', t('Column {n}', { n: view.state.doc.resolve(pos).index() + 1 }))
      }
      label()
      return {
        dom, contentDOM: dom,
        update: (next) => { if (next.type !== node.type) return false; label(); return true },
        ignoreMutation: (mutation) => mutation.type === 'attributes' && mutation.target === dom,
      }
    }
  },
})

export const LayoutSafety = Extension.create({
  name: 'layoutSafety',
  priority: 1100,
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({
      key: new PluginKey('layoutSafety'),
      filterTransaction(tr, state) {
        if (!tr.docChanged) return true
        if (!layoutStructureValid(tr.doc)) { layoutMessage('Layouts cannot be nested. Add full-width text after this layout first.'); return false }
        // Full document replacement and history use their own validated document.
        if (isBlockIdentityTransaction(tr) || tr.getMeta('preventUpdate') || isHistoryTransaction(tr) || tr.getMeta('layoutAction')) return true
        if (crossesColumns(state)) { layoutMessage('Select blocks from one column.'); return false }
        if (state.selection instanceof NodeSelection && state.selection.node.type.name === GROUP) {
          layoutMessage('Use the layout menu to delete a layout and its content.')
          return false
        }
        return true
      },
      appendTransaction(transactions, _previous, state) {
        // Keep later typing out of the structural action's undo event as well.
        const layoutAction = transactions.some(tr => tr.getMeta('layoutAction') || tr.getMeta('appendedTransaction')?.getMeta('layoutAction'))
        if (layoutAction && !blockIdentityPending(state)) return closeHistory(state.tr).setMeta('addToHistory', false)
        return null
      },
      props: {
        handleKeyDown(view, e) {
          if (!view.editable) return false
          if (e.isComposing || view.composing) return false
          if (typeof HTMLElement !== 'undefined' && e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="false"]')) return false
          const selected = view.state.selection
          if ((e.key === 'Backspace' || e.key === 'Delete') && selected instanceof NodeSelection && selected.node.type.name === GROUP) {
            const { doc } = view.state
            const remove = () => { if (!editor.isDestroyed && editor.isEditable && editor.state.doc === doc) editor.commands.deleteLayout(selected.from) }
            const empty = flattenGroup(selected.node).every((n) => n.type.name === 'paragraph' && n.content.size === 0)
            if (empty) remove()
            else void confirmDialog({ title: t('Delete layout and content'), message: t('Delete this layout with {n} columns and all its content? You can undo this action.', { n: selected.node.childCount }), confirmLabel: t('Delete'), danger: true }).then((ok) => { if (ok) remove() })
            return true
          }
          if (crossesColumns(view.state)) {
            if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter') {
              const tr = editAcrossColumns(view.state, undefined, e.key === 'Enter')
              if (tr) view.dispatch(tr)
              return true
            }
          }
          if (e.key === 'Backspace' && boundaryKey(view.state, true)) return true
          if (e.key === 'Delete' && boundaryKey(view.state, false)) return true
          if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
            const physical = e.key.slice(5).toLowerCase() as 'left' | 'right' | 'up' | 'down'
            const next = navigateLayout(view, physical)
            if (next) {
              if (next.selection) view.dispatch(view.state.tr.setSelection(next.selection).scrollIntoView())
              return true
            }
          }
          return false
        },
        handleTextInput(view, _from, _to, text) {
          if (!view.editable || !crossesColumns(view.state)) return false
          const tr = editAcrossColumns(view.state, text)
          if (tr) view.dispatch(tr)
          return true
        },
        handlePaste(view, _event, slice) {
          if (!view.editable || !crossesColumns(view.state)) return false
          const tr = editAcrossColumns(view.state, slice)
          if (tr) view.dispatch(tr)
          return true
        },
        handleDOMEvents: {
          cut: (view, e) => {
            if (!view.editable || !crossesColumns(view.state)) return false
            e.preventDefault()
            if (!e.clipboardData) return true
            const tr = editAcrossColumns(view.state)
            if (!tr) return true
            try {
              const copied = view.serializeForClipboard(crossColumnClipboard(view.state))
              e.clipboardData.setData('text/html', copied.dom.innerHTML)
              e.clipboardData.setData('text/plain', copied.text)
            } catch { return true }
            view.dispatch(tr)
            return true
          },
          beforeinput: (view, e) => {
            if (!view.editable || !crossesColumns(view.state)) return false
            if (!e.cancelable || e.isComposing) return false
            const deletion = e.inputType.startsWith('delete')
            const text = e.inputType === 'insertText' || e.inputType === 'insertReplacementText'
            const split = e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak'
            if (!deletion && !text && !split) return false
            e.preventDefault()
            const tr = editAcrossColumns(view.state, text ? e.data ?? '' : undefined, split)
            if (tr) view.dispatch(tr)
            return true
          },
          compositionstart: (view) => {
            if (view.editable && crossesColumns(view.state)) {
              const tr = editAcrossColumns(view.state)
              if (tr) view.dispatch(tr)
            }
            return false
          },
        },
        transformCopied(slice, view) {
          return crossesColumns(view.state) ? new Slice(flattenLayouts(slice.content), 0, 0) : slice
        },
        transformPasted(slice, view) {
          if (!ancestor(view.state.selection.$from, COLUMN)) return slice
          let containsLayout = false
          slice.content.descendants((n) => { if ([GROUP, COLUMN].includes(n.type.name)) containsLayout = true })
          return containsLayout ? new Slice(flattenLayouts(slice.content), 0, 0) : slice
        },
      },
    })]
  },
  addKeyboardShortcuts() {
    const snap = (mode: 'left' | 'right') => {
      const editor = this.editor
      if (!editor.isEditable || editor.view.composing || insideTable(editor.state)) return false
      const range = blockRange(editor.state)
      if (!range) return true
      editor.view.dom.dispatchEvent(new CustomEvent('layout-snap-pick', { detail: { range, doc: editor.state.doc, mode } }))
      return true
    }
    return {
      'Mod-Alt-ArrowLeft': () => snap('left'),
      'Mod-Alt-ArrowRight': () => snap('right'),
      'Mod-Alt-ArrowUp': () => this.editor.commands.shiftLayoutBlock(-1),
      'Mod-Alt-ArrowDown': () => this.editor.commands.shiftLayoutBlock(1),
      'Mod-Alt-Enter': () => this.editor.commands.addAfterLayout(),
      'Mod-Alt-m': () => { if (!this.editor.isEditable) return false; this.editor.view.dom.dispatchEvent(new Event('layout-move-menu')); return true },
    }
  },
})

export { activeGroup, blockRange, groupColumns, NodeSelection }
