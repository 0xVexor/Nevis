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
  style = { display: '', setProperty() {} }
  classes = new Set()
  classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }
  rect = { left: 100, right: 900, top: 0, bottom: 32, width: 800, height: 32 }
  offsetWidth = 120
  offsetHeight = 30
  captured = new Set()
  append(...elements) { for (const el of elements) { el.parentElement = this; this.children.push(el) } }
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
const event = (target, x = 130, y = 120) => ({ target, clientX: x, clientY: y, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} })

function harness(direction = 'ltr', doc = initial()) {
  const names = ['document', 'window', 'getComputedStyle', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame']
  const originals = names.map((key) => globalThis[key])
  const host = new Element(), root = new Element(), body = new Element(), win = new Surface()
  host.append(root)
  win.setTimeout = () => 0
  let hit = null
  const elements = new Map(), positions = new Map()
  let state = EditorState.create({ schema, doc, plugins: [history()] })
  state.doc.forEach((node, at, index) => {
    const outer = new Element(); outer.kind = 'group'
    outer.rect = { ...outer.rect, top: 100 + index * 140, bottom: 180 + index * 140, height: 80 }
    positions.set(outer, at + 1); elements.set(at, outer); root.append(outer)
    node.forEach((col, offset, colIndex) => {
      const el = new Element(); el.kind = 'column'
      const width = (800 - (node.childCount - 1) * 24) / node.childCount
      const left = 100 + colIndex * (width + 24)
      el.rect = { ...el.rect, left, right: left + width, width, top: 108 + index * 140, bottom: 172 + index * 140, height: 64 }
      const colPos = at + 1 + offset
      positions.set(el, colPos + 1); elements.set(colPos, el); outer.append(el)
      col.forEach((node, pOffset) => {
        const p = new Element(); p.rect = { ...el.rect, bottom: el.rect.top + 32, height: 32 }
        positions.set(p, colPos + 1 + pOffset + (node.isLeaf ? 0 : 1)); elements.set(colPos + 1 + pOffset, p); el.append(p)
      })
    })
  })
  Object.assign(globalThis, { document: { body, createElement: () => new Element(), elementFromPoint: () => hit }, window: win, getComputedStyle: () => ({ direction }), innerWidth: 1200, innerHeight: 800, requestAnimationFrame: () => 1, cancelAnimationFrame() {} })
  let pluginView
  const view = { dom: root, editable: true, composing: false, get state() { return state }, posAtDOM: (el) => positions.get(el), nodeDOM: (pos) => elements.get(pos), focus() {}, dispatch(tr) { const previous = state; state = state.apply(tr); pluginView?.update?.(view, previous) } }
  const [plugin] = DragHandle.config.addProseMirrorPlugins.call({})
  pluginView = plugin.spec.view(view)
  const grip = host.children[1]
  const source = (groupIndex = 0, colIndex = 0) => root.children[groupIndex].children[colIndex].children[0]
  const hover = (el, y = el.rect.top + 10) => host.emit('mousemove', event(el, el.rect.left + 20, y))
  const begin = (el, groupGrip = false) => {
    hover(el, el.rect.top + (groupGrip ? 2 : 10))
    grip.onpointerdown(event(grip, 80, 120))
  }
  const move = (el, x = 600, y = 275) => { hit = el; win.emit('pointermove', event(el, x, y)) }
  const end = (el, x = 600, y = 275) => { hit = el; win.emit('pointerup', event(el, x, y)) }
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
    assert.equal(groupColumns(h.doc)[0].node.textContent, '')
    assert.equal(groupColumns(h.doc)[3].node.lastChild, original)
    assert.equal(groupColumns(h.doc)[3].node.textContent, 'B2A1')
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
      else if (reason === 'capture') h.grip.onlostpointercapture()
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
      h.begin(h.source()); h.move(target, 130, 110); h.end(target, 130, 110)
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


test('middle and last column grips stay inside their own gutter in both directions', () => {
  for (const direction of ['ltr', 'rtl']) {
    const h = harness(direction)
    try {
      for (const index of [1, 2]) {
        const column = h.root.children[1].children[index]
        h.hover(h.source(1, index))
        const blockLeft = h.grip.style.left
        h.hover(column, column.rect.top + 15)
        assert.equal(h.grip.getAttribute('aria-label'), 'Move block', 'crossing the gutter must not select the whole group')
        assert.equal(h.grip.style.left, blockLeft)
        const left = h.host.rect.left + parseFloat(h.grip.style.left)
        const right = left + 24
        assert.ok(left >= column.rect.left && right <= column.rect.right)
        const separator = direction === 'rtl' ? column.rect.right + 12 : column.rect.left - 12
        assert.ok(right < separator - 8 || left > separator + 8, 'grip and resize hit areas must not intersect')
        if (direction === 'ltr') assert.equal(left, column.rect.left + 2)
        else assert.equal(right, column.rect.right - 2)
      }
    } finally { h.cleanup() }
  }
})


test('atomic block grips resolve the node boundary and move the original node', () => {
  const atom = schema.nodes.horizontalRule.create()
  const doc = schema.nodes.doc.create(null, [group(atom, 'A2'), group('B1', 'B2', 'B3')])
  const h = harness('ltr', doc)
  try {
    h.begin(h.source())
    assert.equal(h.grip.style.display, 'flex')
    h.move(h.source(1, 1)); h.end(h.source(1, 1))
    assert.equal(groupColumns(h.doc)[3].node.lastChild, atom)
    assert.equal(groupColumns(h.doc)[0].node.firstChild.type.name, 'paragraph')
    assert.equal(undoDepth(h.view.state), 1)
  } finally { h.cleanup() }
})
