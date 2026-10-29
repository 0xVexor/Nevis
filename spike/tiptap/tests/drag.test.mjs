import test from 'node:test'
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from '@tiptap/pm/state'
import { history, undo, undoDepth } from '@tiptap/pm/history'
import { LayoutGroup, LayoutColumn } from '../src/editor/layout.ts'
import { DragHandle } from '../src/editor/dragHandle.ts'
import { groupColumns } from '../src/editor/layoutModel.ts'

const schema = getSchema([StarterKit, LayoutGroup, LayoutColumn])
const paragraph = (value) => schema.nodes.paragraph.create(null, schema.text(value))
const group = (...labels) => schema.nodes.layoutGroup.create({ widths: labels.map(() => 100 / labels.length) }, labels.map((s) => schema.nodes.layoutColumn.create(null, typeof s === 'string' ? paragraph(s) : s)))
const initial = () => schema.nodes.doc.create(null, [group('A1', 'A2'), group('B1', 'B2', 'B3')])
const json = (doc) => JSON.stringify(doc.toJSON())

class Surface {
  listeners = new Map()
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn) }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn) }
  emit(name, event) { for (const fn of [...(this.listeners.get(name) ?? [])]) fn(event) }
}
class Element extends Surface {
  children = []
  parentElement = null
  attrs = new Map()
  dataset = {}
  hidden = false
  style = { display: '', setProperty() {} }
  classes = new Set()
  classList = { add: (...names) => names.forEach((name) => this.classes.add(name)), remove: (...names) => names.forEach((name) => this.classes.delete(name)), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }
  rect = { left: 100, right: 900, top: 0, bottom: 32, width: 800, height: 32 }
  offsetWidth = 120
  offsetHeight = 30
  captured = new Set()
  append(...elements) { for (const el of elements) { el.parentElement = this; this.children.push(el) } }
  prepend(...elements) { for (const el of elements) el.parentElement = this; this.children.unshift(...elements) }
  replaceChildren(...elements) { this.children = []; this.append(...elements) }
  get childElementCount() { return this.children.length }
  querySelector(selector) {
    if (selector === ':scope > .layout-columns') return this.children.find((el) => el.kind === 'body') ?? null
    return null
  }
  querySelectorAll(selector) {
    if (selector.includes(':scope > *')) return this.children.flatMap((el) => [el, ...el.querySelectorAll(selector)])
    return []
  }
  getClientRects() { return this.hidden ? [] : [this.rect] }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((e) => e !== this) }
  setAttribute(name, value) { this.attrs.set(name, value) }
  getAttribute(name) { return this.attrs.get(name) ?? null }
  getBoundingClientRect() { return this.rect }
  contains(el) { return el === this || this.children.some((child) => child.contains(el)) }
  matches(selector) { return selector === '[data-type="layout-column"]' && this.kind === 'column' }
  closest(selector) {
    if (selector === '.layout-group' && this.kind === 'group' || selector === '[data-type="layout-column"]' && this.kind === 'column') return this
    return this.parentElement?.closest(selector) ?? null
  }
  setPointerCapture(id) { this.captured.add(id) }
  hasPointerCapture(id) { return this.captured.has(id) }
  releasePointerCapture(id) { this.captured.delete(id) }
  dispatchEvent(event) { this.emit(event.type, event) }
}
const event = (target, x = 130, y = 120) => ({ target, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true, pointerType: 'mouse', detail: 1, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} })

function harness(direction = 'ltr', doc = initial()) {
  const names = ['document', 'window', 'getComputedStyle', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame', 'Element', 'HTMLElement', 'Node', 'ResizeObserver', 'DOMRect']
  const originals = names.map((key) => globalThis[key])
  const host = new Element(), root = new Element(), body = new Element(), win = new Surface()
  host.append(root)
  root.rect = { left: 100, right: 900, top: 0, bottom: 600, width: 800, height: 600 }
  win.setTimeout = () => 0
  let hit = null
  const elements = new Map(), positions = new Map()
  let state = EditorState.create({ schema, doc, plugins: [history()] })
  state.doc.forEach((node, at, index) => {
    const outer = new Element(); outer.kind = 'group'
    outer.rect = { ...outer.rect, top: 100 + index * 140, bottom: 180 + index * 140, height: 80 }
    positions.set(outer, at + 1); elements.set(at, outer); root.append(outer)
    const columns = new Element(); columns.kind = 'body'; columns.rect = { ...outer.rect, top: outer.rect.top + 8, height: 64, bottom: outer.rect.bottom - 8 }; outer.append(columns)
    node.forEach((col, offset, colIndex) => {
      const el = new Element(); el.kind = 'column'
      const width = (800 - (node.childCount - 1) * 24) / node.childCount
      const left = 100 + colIndex * (width + 24)
      el.rect = { ...el.rect, left, right: left + width, width, top: 108 + index * 140, bottom: 172 + index * 140, height: 64 }
      const colPos = at + 1 + offset
      positions.set(el, colPos + 1); elements.set(colPos, el); columns.append(el)
      col.forEach((node, pOffset) => {
        const p = new Element(); p.rect = { ...el.rect, bottom: el.rect.top + 32, height: 32 }
        positions.set(p, colPos + 1 + pOffset + (node.isLeaf ? 0 : 1)); elements.set(colPos + 1 + pOffset, p); el.append(p)
      })
    })
  })
  const document = new Surface()
  Object.assign(document, { body, createElement: () => new Element(), elementFromPoint: () => hit, querySelectorAll: () => [],
    caretRangeFromPoint: () => null, createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }) })
  root.ownerDocument = document
  const frames = new Map(); let frameId = 0
  const flushFrame = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(performance.now()) }
  class Rect {
    constructor(left, top, width, height) { Object.assign(this, { left, top, width, height, right: left + width, bottom: top + height }) }
  }
  Object.assign(globalThis, { document, window: win, Element, HTMLElement: Element, Node: Element, DOMRect: Rect,
    ResizeObserver: class { observe() {} disconnect() {} }, getComputedStyle: () => ({ direction }), innerWidth: 1200, innerHeight: 800,
    requestAnimationFrame: (fn) => { frames.set(++frameId, fn); return frameId }, cancelAnimationFrame: (id) => frames.delete(id) })
  let pluginView
  const view = { dom: root, editable: true, composing: false, get state() { return state }, posAtDOM: (el) => positions.get(el), posAtCoords: () => hit && positions.has(hit) ? { pos: positions.get(hit) } : null, nodeDOM: (pos) => elements.get(pos), focus() {}, hasFocus: () => false, dispatch(tr) { const previous = state; state = state.apply(tr); pluginView?.update?.(view, previous) } }
  const [plugin] = DragHandle.config.addProseMirrorPlugins.call({})
  pluginView = plugin.spec.view(view)
  const grip = root // The editor owns pointer capture; there is no floating grip anymore.
  const source = (groupIndex = 0, colIndex = 0) => root.children[groupIndex].children[0].children[colIndex].children[0]
  const hover = (el, y = el.rect.top + 10, x = el.rect.left + 20) => { hit = el; host.emit('mousemove', event(el, x, y)); flushFrame() }
  const begin = (el, groupGrip = false) => {
    hover(el, el.rect.top + (groupGrip ? 2 : 10))
    root.emit('pointerdown', event(el, el.rect.left + 20, el.rect.top + (groupGrip ? 2 : 10)))
  }
  const move = (el, x = 500, y = 275) => { hit = el; win.emit('pointermove', event(el, x, y)); flushFrame() }
  const end = (el, x = 500, y = 275) => { hit = el; win.emit('pointerup', event(el, x, y)) }
  const cleanup = () => { pluginView.destroy(); names.forEach((key, i) => { globalThis[key] = originals[i] }) }
  return { view, plugin, grip, root, host, body, win, source, hover, begin, move, end, cleanup, get doc() { return state.doc } }
}

// These tests exercise the registered pointer handlers, without opening or writing any vault.
test('pointer move only commits on release, keeps the original block and makes one undo event', () => {
  const h = harness()
  try {
    const before = json(h.doc), original = groupColumns(h.doc)[0].node.firstChild
    h.begin(h.source()); h.move(h.source(1, 1))
    assert.equal(json(h.doc), before)
    assert.ok(h.grip.hasPointerCapture(1))
    h.end(h.source(1, 1))
    assert.equal(h.doc.firstChild.textContent, 'A2', 'the exhausted two-column group becomes full width')
    const destination = groupColumns(h.doc).find((col) => col.node.textContent === 'B2A1')
    assert.ok(destination)
    assert.equal(destination.node.lastChild, original)
    assert.equal(undoDepth(h.view.state), 1)
    assert.equal(h.grip.hasPointerCapture(1), false)
    assert.ok(undo(h.view.state, (tr) => h.view.dispatch(tr)))
    assert.equal(json(h.doc), before)
  } finally { h.cleanup() }
})

test('Escape, focus loss, pointer cancellation and lost capture never commit a preview', () => {
  for (const reason of ['Escape', 'blur', 'pointercancel', 'capture']) {
    const h = harness()
    try {
      const before = json(h.doc)
      h.begin(h.source()); h.move(h.source(1, 1))
      if (reason === 'Escape') h.win.emit('keydown', { ...event(null), key: 'Escape' })
      else if (reason === 'capture') h.win.emit('lostpointercapture', event(h.grip))
      else h.win.emit(reason, event(null))
      h.end(h.source(1, 1))
      assert.equal(json(h.doc), before, reason)
      assert.equal(undoDepth(h.view.state), 0)
      assert.equal(h.grip.hasPointerCapture(1), false)
    } finally { h.cleanup() }
  }
})

test('a changed document invalidates the pending source and target before pointer release', () => {
  const h = harness()
  try {
    h.begin(h.source()); h.move(h.source(1, 1))
    h.view.dispatch(h.view.state.tr.insertText('new ', 3))
    const fresh = json(h.doc)
    h.end(h.source(1, 1))
    assert.equal(json(h.doc), fresh)
    assert.equal(h.grip.hasPointerCapture(1), false)
  } finally { h.cleanup() }
})

test('a group dropped inside another column is rejected rather than moved or nested', () => {
  const h = harness()
  try {
    const before = json(h.doc)
    h.begin(h.root.children[0], true)
    h.move(h.source(1, 1)); h.end(h.source(1, 1))
    assert.equal(json(h.doc), before)
    assert.equal(undoDepth(h.view.state), 0)
  } finally { h.cleanup() }
})

test('dropping at the source or outside the editor is a no-op', () => {
  for (const outside of [false, true]) {
    const h = harness()
    try {
      const before = json(h.doc), target = outside ? null : h.source()
      h.begin(h.source()); h.move(target, 130, 128); h.end(target, 130, 128)
      assert.equal(json(h.doc), before)
      assert.equal(undoDepth(h.view.state), 0)
    } finally { h.cleanup() }
  }
})

test('external files retain the existing drop path, and older native block payloads cannot fall through', () => {
  const h = harness()
  try {
    assert.equal(h.plugin.props.handleDrop(h.view, { dataTransfer: { types: ['Files'] } }), false)
    assert.equal(h.plugin.props.handleDrop(h.view, { dataTransfer: { types: ['application/x-nevis-block-move'] } }), true)
  } finally { h.cleanup() }
})


test('column hover follows the actual block and clears over empty gutters in both directions', () => {
  for (const direction of ['ltr', 'rtl']) {
    const h = harness(direction)
    try {
      for (const index of [1, 2]) {
        const column = h.root.children[1].children[0].children[index]
        h.hover(h.source(1, index))
        const outline = h.body.children.find((el) => el.className === 'layout-snap-hover-outline')
        assert.equal(outline.hidden, false)
        assert.equal(outline.style.left, `${column.rect.left}px`)
        assert.equal(outline.style.width, `${column.rect.width}px`)
        h.hover(column, column.rect.top + 15, column.rect.left - 8)
        assert.equal(outline.hidden, true, 'blank space must not retain the nearest row')
        assert.equal(h.root.dataset.layoutInteraction, undefined)
      }
    } finally { h.cleanup() }
  }
})


test('atomic block surfaces resolve the node boundary and move the original node', () => {
  const atom = schema.nodes.horizontalRule.create()
  const doc = schema.nodes.doc.create(null, [group(atom, 'A2'), group('B1', 'B2', 'B3')])
  const h = harness('ltr', doc)
  try {
    h.begin(h.source())
    assert.equal(h.grip.hasPointerCapture(1), true)
    h.move(h.source(1, 1)); h.end(h.source(1, 1))
    assert.equal(groupColumns(h.doc).find((col) => col.node.textContent === 'B2').node.lastChild, atom)
    assert.equal(h.doc.firstChild.textContent, 'A2')
    assert.equal(undoDepth(h.view.state), 1)
  } finally { h.cleanup() }
})

test('vertical extraction from two and three columns previews without editing and preserves undo', () => {
  for (const groupIndex of [0, 1]) {
    const h = harness()
    try {
      const before = json(h.doc)
      const original = h.doc.child(groupIndex).firstChild.firstChild
      const source = h.source(groupIndex)
      const x = source.rect.left + 20, y = source.rect.top + 38
      h.begin(source)
      h.move(source, x, y)
      assert.equal(json(h.doc), before)
      const overlay = h.body.children.find((el) => el.className === 'layout-snap-overlay')
      assert.equal(overlay.hidden, false)
      assert.equal(overlay.classes.has('layout-snap-line'), false)
      assert.equal(overlay.children.length, 1, 'extraction previews a full-width panel')
      assert.equal(overlay.children[0].children[0].classes.has('layout-snap-miniature-extraction'), true)
      h.end(source, x, y)
      assert.equal(h.doc.child(groupIndex === 0 ? 1 : 2), original)
      if (groupIndex === 0) assert.equal(h.doc.firstChild.textContent, 'A2')
      else assert.equal(h.doc.child(1).childCount, 2)
      assert.equal(undoDepth(h.view.state), 1)
      assert.equal(h.grip.hasPointerCapture(1), false)
      assert.ok(undo(h.view.state, (tr) => h.view.dispatch(tr)))
      assert.equal(json(h.doc), before)
    } finally { h.cleanup() }
  }
})
