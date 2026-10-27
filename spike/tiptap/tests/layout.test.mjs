import test from 'node:test'
import assert from 'node:assert/strict'
import { getSchema, Node } from '@tiptap/core'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Callout, Toggle } from '../src/editor/blocks.ts'
import StarterKit from '@tiptap/starter-kit'
import { NodeSelection, TextSelection, EditorState } from '@tiptap/pm/state'
import { history, undo, redo, undoDepth } from '@tiptap/pm/history'
import { Fragment, Slice } from '@tiptap/pm/model'
import { LayoutGroup, LayoutColumn, LayoutSafety } from '../src/editor/layout.ts'
import { adjacentColumnSelection, ancestor, blockRange, boundaryKey, crossesColumns, flattenLayouts, groupColumns, layoutStructureValid, linearSelection, moveBlocks, validWidths, displayWidths } from '../src/editor/layoutModel.ts'
import { contentProblem } from '../src/editor/contentSafety.ts'
import { toMarkdown } from '../src/markdown.ts'

// The application is never opened and no real vault is read or written by this suite.
const notices = []
globalThis.window = { dispatchEvent: (e) => { notices.push(e.detail) }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) }
globalThis.localStorage = { getItem: () => null }
const schema = getSchema([StarterKit, LayoutGroup, LayoutColumn])
const text = (s) => schema.nodes.paragraph.create({ dir: 'auto' }, s ? schema.text(s, [schema.marks.bold.create()]) : null)
const column = (...nodes) => schema.nodes.layoutColumn.create(null, nodes.length ? nodes : [text('')])
const group = (labels, attrs = {}) => schema.nodes.layoutGroup.create({ widths: labels.map(() => 100 / labels.length), ...attrs }, labels.map((s) => column(text(s))))
const fixture = () => schema.nodes.doc.create(null, [group(['A1', 'A2']), group(['B1', 'B2', 'B3']), text('FULL'), group(['C1', 'C2'], { widths: [30, 70], direction: 'rtl' })])
function harness(doc = fixture(), withSafety = false) {
  let state = EditorState.create({ schema: doc.type.schema, doc, plugins: [history()] })
  const editor = { isEditable: true, view: { composing: false }, get state() { return state } }
  if (withSafety) state = state.reconfigure({ plugins: [...state.plugins, ...LayoutSafety.config.addProseMirrorPlugins.call({ editor })] })
  const commands = LayoutGroup.config.addCommands.call({ editor })
  const apply = (tr) => { state = state.apply(tr) }
  const run = (name, ...args) => {
    const tr = state.tr
    // Tiptap commands receive a shared transaction; dispatch is only a capability flag.
    const commandState = Object.create(state)
    Object.defineProperty(commandState, 'tr', { get: () => tr })
    const ok = commands[name](...args)({ editor, state: commandState, tr, dispatch: () => {} })
    if (tr.docChanged || tr.selectionSet) apply(tr)
    return ok
  }
  const select = (selection) => apply(state.tr.setSelection(selection))
  return { editor, run, select, apply, get state() { return state } }
}
const position = (doc, name) => { let pos; doc.descendants((n, p) => { if (n.isTextblock && n.textContent === name) pos = p }); return pos }
const inside = (h, label) => h.select(TextSelection.create(h.state.doc, position(h.state.doc, label) + 1))
const json = (node) => JSON.stringify(node.toJSON())

test('independent groups survive widths/direction changes and JSON roundtrip', () => {
  const h = harness(), untouched = h.state.doc.child(1), c = h.state.doc.child(3)
  inside(h, 'A1')
  assert.equal(h.run('setLayoutWidths', [70, 30]), true)
  assert.equal(h.run('setLayoutDirection', 'rtl'), true)
  assert.deepEqual(h.state.doc.child(0).attrs.widths, [70, 30])
  assert.equal(h.state.doc.child(1), untouched)
  assert.equal(h.state.doc.child(3), c)
  assert.equal(json(schema.nodeFromJSON(h.state.doc.toJSON())), json(h.state.doc))
})

test('insert at the caret preserves surrounding full-width content', () => {
  const h = harness(schema.nodes.doc.create(null, [text('X'), text('Y'), text('Z')]))
  inside(h, 'X')
  assert.equal(h.run('insertLayout', 2), true)
  assert.deepEqual(Array.from({ length: h.state.doc.childCount }, (_, i) => h.state.doc.child(i).type.name), ['paragraph', 'layoutGroup', 'paragraph', 'paragraph'])
  assert.equal(h.state.doc.textContent, 'XYZ')
  assert.equal(groupColumns(h.state.doc).length, 2)
  h.state.doc.check()
})

test('complete selection wraps in first column, partial selection and nesting are rejected', () => {
  const h = harness(schema.nodes.doc.create(null, [text('one'), text('two')]))
  h.select(TextSelection.create(h.state.doc, 1, h.state.doc.content.size - 1))
  assert.ok(h.run('insertLayout', 3))
  assert.equal(h.state.doc.firstChild.child(0).textContent, 'onetwo')
  assert.equal(h.state.doc.firstChild.child(1).textContent, '')
  const before = json(h.state.doc)
  assert.equal(h.run('insertLayout', 2), false)
  assert.equal(json(h.state.doc), before)
  const partial = harness(schema.nodes.doc.create(null, [text('partial')]))
  partial.select(TextSelection.create(partial.state.doc, 2, 4))
  assert.equal(partial.run('insertLayout', 2), false)
  assert.equal(partial.state.doc.firstChild.type.name, 'paragraph')
})

test('three to two appends removed contents; unwrap retains all marked nodes in logical order', () => {
  const h = harness(), before = h.state.doc.child(1)
  inside(h, 'B2')
  assert.ok(h.run('setLayoutColumns', 2))
  assert.equal(h.state.doc.child(1).child(0).textContent, 'B1')
  assert.equal(h.state.doc.child(1).child(1).textContent, 'B2B3')
  assert.deepEqual(h.state.doc.child(1).attrs.widths, [50, 50])
  assert.ok(undo(h.state, h.apply))
  assert.equal(json(h.state.doc.child(1)), json(before))
  inside(h, 'B1')
  assert.ok(h.run('setLayoutDirection', 'rtl'))
  assert.ok(h.run('setLayoutColumns', 1))
  assert.equal(h.state.doc.textContent, 'A1A2B1B2B3FULLC1C2')
  for (const label of ['B1', 'B2', 'B3']) assert.equal(h.state.doc.nodeAt(position(h.state.doc, label)).firstChild.marks[0].type.name, 'bold')
  h.state.doc.check()
})

test('increasing columns adds empty content and respects the three-column cap', () => {
  const h = harness(); inside(h, 'A1')
  const a1 = h.state.doc.firstChild.child(0)
  assert.ok(h.run('setLayoutColumns', 3))
  assert.equal(h.state.doc.firstChild.child(0), a1)
  assert.equal(h.state.doc.firstChild.child(2).firstChild.type.name, 'paragraph')
  assert.equal(h.run('setLayoutColumns', 4), false)
})

test('move retains node identity/marks, source paragraph, and creates one undo entry', () => {
  const h = harness(); inside(h, 'A1')
  const moved = h.state.doc.nodeAt(position(h.state.doc, 'A1'))
  const before = json(h.state.doc)
  const dest = groupColumns(h.state.doc).find((c) => c.group === 2 && c.column === 3)
  assert.ok(h.run('moveToLayout', dest.pos))
  const a1 = groupColumns(h.state.doc)[0].node
  assert.equal(a1.childCount, 1)
  assert.equal(a1.firstChild.type.name, 'paragraph')
  assert.equal(a1.firstChild.content.size, 0)
  const b3 = groupColumns(h.state.doc).find((c) => c.group === 2 && c.column === 3).node
  assert.equal(b3.lastChild, moved)
  assert.equal(undoDepth(h.state), 1)
  assert.ok(undo(h.state, h.apply)); assert.equal(json(h.state.doc), before)
  assert.ok(redo(h.state, h.apply)); assert.equal(h.state.doc.textContent, 'A2B1B2B3A1FULLC1C2')
})

test('multi-block movement keeps order; self/no-op creates no transaction', () => {
  const doc = schema.nodes.doc.create(null, [schema.nodes.layoutGroup.create({ widths: [50, 50] }, [column(text('a'), text('b')), column(text('c'))])])
  const h = harness(doc)
  h.select(TextSelection.create(doc, position(doc, 'a') + 1, position(doc, 'b') + 2))
  const range = blockRange(h.state)
  assert.equal(range.nodes.length, 2)
  assert.equal(moveBlocks(h.state, range, range.from), null)
  assert.equal(moveBlocks(h.state, range, range.to), null)
  assert.ok(h.run('moveToLayout', groupColumns(h.state.doc)[1].pos))
  assert.equal(groupColumns(h.state.doc)[1].node.textContent, 'cab')
})

test('group movement remains root-only, and preserves direction and ratios', () => {
  const h = harness(), last = h.state.doc.lastChild, at = h.state.doc.content.size - last.nodeSize
  h.select(NodeSelection.create(h.state.doc, at))
  const range = blockRange(h.state)
  assert.equal(moveBlocks(h.state, range, groupColumns(h.state.doc)[0].pos + 1), null)
  const tr = moveBlocks(h.state, range, 0)
  h.apply(tr)
  assert.equal(h.state.doc.firstChild, last)
  assert.equal(layoutStructureValid(h.state.doc), true)
})

test('cross-column selection is copy-only and linearizes the touched blocks', () => {
  const h = harness()
  h.select(TextSelection.create(h.state.doc, position(h.state.doc, 'A1') + 2, position(h.state.doc, 'A2') + 2))
  assert.ok(crossesColumns(h.state))
  assert.equal(blockRange(h.state), null)
  const copy = linearSelection(h.state)
  assert.equal(copy.childCount, 2)
  assert.equal(copy.firstChild.type.name, 'paragraph')
  assert.equal(copy.firstChild.textContent, 'A1')
  assert.equal(h.run('setLayoutColumns', 1), false)
})

test('column boundary deletion is guarded while internal text positions are editable', () => {
  const h = harness(); inside(h, 'A2')
  assert.ok(boundaryKey(h.state, true))
  assert.equal(boundaryKey(h.state, false), false)
  h.select(TextSelection.create(h.state.doc, position(h.state.doc, 'A2') + 3))
  assert.ok(boundaryKey(h.state, false))
  assert.ok(ancestor(h.state.selection.$from, 'layoutColumn'))
})

test('paste into a column flattens layouts in logical order', () => {
  const doc = fixture()
  const fragment = flattenLayouts(Fragment.from(doc.child(1)))
  assert.deepEqual(Array.from({ length: fragment.childCount }, (_, i) => fragment.child(i).textContent), ['B1', 'B2', 'B3'])
  assert.ok(fragment.firstChild.firstChild.marks.length)
})

test('invalid widths only affect presentation; unknown, nested or malformed nodes are protected', () => {
  const h = harness()
  for (const widths of [[0, 100], [-1, 101], [NaN, 50], [10, 90], [40, 40]]) assert.equal(validWidths(widths, 2), false)
  const invalid = group(['one', 'two'], { widths: [0, 100] })
  assert.deepEqual(displayWidths(invalid), [50, 50])
  assert.deepEqual(invalid.attrs.widths, [0, 100])
  assert.equal(contentProblem(schema.nodes.doc.create(null, [invalid]).toJSON(), schema), null)
  const unknown = h.state.doc.toJSON(); unknown.content.push({ type: 'futureWidget' })
  assert.ok(contentProblem(unknown, schema))
  const malformed = h.state.doc.toJSON(); malformed.content[0].content[0].content = []
  assert.ok(contentProblem(malformed, schema))
  const nested = h.state.doc.toJSON(); nested.content[0].content[0].content.push(h.state.doc.firstChild.toJSON())
  assert.ok(contentProblem(nested, schema))
  const four = h.state.doc.toJSON(); four.content[0].content.push(...four.content[0].content)
  assert.ok(contentProblem(four, schema))
})

test('width/direction/resize commits are atomic, reject invalid values, and no-op adds no history', () => {
  const h = harness(); inside(h, 'A1')
  assert.equal(h.run('setLayoutWidths', [0, 100]), false)
  assert.equal(undoDepth(h.state), 0)
  h.run('setLayoutWidths', [30, 70]); h.run('setLayoutWidths', [30, 70])
  assert.equal(undoDepth(h.state), 1)
  h.run('setLayoutDirection', 'rtl')
  assert.equal(undoDepth(h.state), 2)
  undo(h.state, h.apply)
  assert.deepEqual(h.state.doc.firstChild.attrs.widths, [30, 70])
  undo(h.state, h.apply)
  assert.deepEqual(h.state.doc.firstChild.attrs.widths, [50, 50])
})

test('full-width exit and deletion leave a valid typing destination', () => {
  const h = harness(); inside(h, 'A1')
  h.run('addAfterLayout')
  assert.equal(h.state.doc.child(1).type.name, 'paragraph')
  const one = harness(schema.nodes.doc.create(null, [group(['one', 'two'])]))
  inside(one, 'one'); one.run('deleteLayout')
  assert.equal(one.state.doc.childCount, 1)
  assert.equal(one.state.doc.firstChild.type.name, 'paragraph')
  assert.ok(undo(one.state, one.apply))
  assert.equal(one.state.doc.textContent, 'onetwo')
})

test('markdown exports every column in logical order without layout wrappers', async () => {
  const md = await toMarkdown('', fixture().toJSON(), async () => null)
  const labels = ['A1', 'A2', 'B1', 'B2', 'B3', 'FULL', 'C1', 'C2']
  assert.ok(labels.every((label, i) => md.indexOf(label) > (i ? md.indexOf(labels[i - 1]) : -1)))
  assert.ok(!md.includes('layoutGroup'))
})

test('safety plugin rejects cross-column typing, malformed structures and destructive group deletion', () => {
  const h = harness()
  const editor = { ...h.editor, isEditable: true }
  const [plugin] = LayoutSafety.config.addProseMirrorPlugins.call({ editor })
  let state = EditorState.create({ schema, doc: h.state.doc, plugins: [plugin] })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, position(state.doc, 'A1') + 2, position(state.doc, 'A2') + 2)))
  assert.equal(state.applyTransaction(state.tr.insertText('replace')).transactions.length, 0)
  const copied = plugin.props.transformCopied(new Slice(Fragment.empty, 0, 0), { state })
  assert.equal(copied.content.childCount, 2)
  state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 0)))
  assert.equal(state.applyTransaction(state.tr.deleteSelection()).transactions.length, 0)
})

test('saved layout NodeViews initialize before editor.view is assigned', () => {
  const previousDocument = globalThis.document, previousObserver = globalThis.ResizeObserver
  const previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame
  const frames = [], cancelled = []
  globalThis.requestAnimationFrame = (fn) => (frames.push(fn), frames.length)
  globalThis.cancelAnimationFrame = (id) => cancelled.push(id)
  let listening = 0, disconnected = false, observeResize
  class ElementStub {
    children = []
    style = {}
    dataset = {}
    clientWidth = 1000
    classList = { toggle() {}, add() {}, remove() {} }
    append(...elements) { this.children.push(...elements) }
    replaceChildren(...elements) { this.children = elements }
    setAttribute() {}
    removeAttribute() {}
    addEventListener() { listening++ }
    removeEventListener() { listening-- }
    contains() { return false }
  }
  globalThis.document = { createElement: () => new ElementStub() }
  globalThis.ResizeObserver = class { constructor(fn) { observeResize = fn } observe() {} disconnect() { disconnected = true } }
  try {
    const editor = { get view() { throw new Error('Editor is still mounting') } }
    const renderer = LayoutGroup.config.addNodeView.call({})
    const result = renderer({ node: fixture().firstChild, editor, getPos: () => 0, view: { dom: new ElementStub() } })
    assert.equal(result.contentDOM.children.length, 0)
    assert.equal(result.contentDOM.style.gridTemplateColumns, 'minmax(0, 50fr) minmax(0, 50fr)')
    assert.equal(listening, 1)
    observeResize()
    assert.equal(frames.length, 1, 'observer defers layout writes to the next frame')
    observeResize()
    assert.equal(frames.length, 1, 'height-only notification does not reset a preview')
    result.contentDOM.clientWidth = 500
    observeResize()
    assert.equal(frames.length, 2)
    assert.ok(cancelled.includes(1))
    result.destroy()
    assert.ok(cancelled.includes(2))
    assert.equal(listening, 0)
    assert.ok(disconnected)
  } finally {
    globalThis.document = previousDocument
    globalThis.ResizeObserver = previousObserver
    globalThis.requestAnimationFrame = previousRaf
    globalThis.cancelAnimationFrame = previousCancel
  }
})


test('column arrow navigation follows logical order, including empty columns and full-width exit', () => {
  const h = harness()
  inside(h, 'A1')
  assert.equal(adjacentColumnSelection(h.state, true), null)
  h.select(TextSelection.create(h.state.doc, position(h.state.doc, 'A1') + 3))
  const next = adjacentColumnSelection(h.state, false)
  assert.equal(next.from, position(h.state.doc, 'A2') + 1)
  h.select(next)
  assert.equal(adjacentColumnSelection(h.state, true).from, position(h.state.doc, 'A1') + 3)
  inside(h, 'B3')
  h.select(TextSelection.create(h.state.doc, position(h.state.doc, 'B3') + 3))
  assert.equal(adjacentColumnSelection(h.state, false).from, position(h.state.doc, 'FULL') + 1)
  const empty = harness(schema.nodes.doc.create(null, [group(['', 'two']), text('after')]))
  empty.select(TextSelection.create(empty.state.doc, 3))
  assert.equal(adjacentColumnSelection(empty.state, false).from, position(empty.state.doc, 'two') + 1)
})


test('all existing block shapes retain attrs, marks, nested data and attachment ids through moves and unwrap', () => {
  const atom = (name, defaults, inline = false) => Node.create({ name, group: inline ? 'inline' : 'block', inline, atom: true, addAttributes: () => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { default: value }])) })
  const rich = getSchema([StarterKit, LayoutGroup, LayoutColumn, TaskList, TaskItem, Table, TableRow, TableCell, TableHeader, Image, Callout, Toggle,
    atom('databaseEmbed', { containerId: '' }), atom('drawing', { scene: '', preview: '' }), atom('mermaid', { code: '' }), atom('mathBlock', { latex: '' }),
    atom('pageLink', { id: '', label: '' }, true), atom('mathInline', { latex: '' }, true)])
  const p = (label) => rich.nodes.paragraph.create(null, rich.text(label, [rich.marks.bold.create()]))
  const blocks = [
    rich.nodes.heading.create({ level: 2 }, rich.text('heading', [rich.marks.link.create({ href: 'https://example.org' })])),
    rich.nodes.bulletList.create(null, rich.nodes.listItem.create(null, p('list'))),
    rich.nodes.taskList.create(null, rich.nodes.taskItem.create({ checked: true }, p('done'))),
    rich.nodes.blockquote.create(null, p('quote')),
    rich.nodes.callout.create({ emoji: '⚠️' }, p('callout')),
    rich.nodes.toggle.create({ open: false }, [p('title'), p('hidden text')]),
    rich.nodes.codeBlock.create({ language: 'typescript' }, rich.text('const x = 1')),
    rich.nodes.table.create(null, rich.nodes.tableRow.create(null, [rich.nodes.tableHeader.create(null, p('header')), rich.nodes.tableCell.create(null, p('cell'))])),
    rich.nodes.image.create({ src: 'att:image-id', alt: 'picture', title: 'image title' }),
    rich.nodes.paragraph.create(null, [rich.nodes.pageLink.create({ id: 'page-id', label: 'linked page' }), rich.nodes.mathInline.create({ latex: 'x^2' })]),
    rich.nodes.drawing.create({ scene: 'drawing-scene-id', preview: 'drawing-preview-id' }),
    rich.nodes.mermaid.create({ code: 'graph TD; A-->B' }),
    rich.nodes.mathBlock.create({ latex: String.raw`\frac{1}{2}` }),
    rich.nodes.databaseEmbed.create({ containerId: 'database-id' }),
  ]
  const col = (content) => rich.nodes.layoutColumn.create(null, content)
  const g = (...cols) => rich.nodes.layoutGroup.create({ widths: [50, 50] }, cols)
  const h = harness(rich.nodes.doc.create(null, [g(col(blocks), col(p('other'))), g(col(p('destination')), col(p('empty')))]))
  const originals = blocks.map((n) => n.toJSON())
  for (const original of blocks) {
    let at
    h.state.doc.descendants((node, pos) => { if (node === original) at = pos })
    h.select(NodeSelection.create(h.state.doc, at))
    h.run('moveToLayout', groupColumns(h.state.doc).find((c) => c.group === 2 && c.column === 2).pos)
    h.state.doc.check()
  }
  const target = groupColumns(h.state.doc).find((c) => c.group === 2 && c.column === 2)
  for (let i = 0; i < blocks.length; i++) {
    assert.equal(target.node.child(i + 1), blocks[i])
    assert.deepEqual(target.node.child(i + 1).toJSON(), originals[i])
  }
  h.run('setLayoutColumns', 1, target.groupPos)
  assert.equal(layoutStructureValid(h.state.doc), true)
  assert.equal(json(rich.nodeFromJSON(h.state.doc.toJSON())), json(h.state.doc))
  for (const original of blocks) {
    let copies = 0
    h.state.doc.descendants((node) => { if (node === original) copies++ })
    assert.equal(copies, 1)
  }
})

test('Markdown keeps a database embed reference inside the linear column output', async () => {
  const md = await toMarkdown('', { type: 'doc', content: [{ type: 'layoutGroup', content: [{ type: 'layoutColumn', content: [{ type: 'databaseEmbed', attrs: { containerId: 'C<1>&' } }] }] }] }, async () => '')
  assert.ok(md.includes('data-type="database-embed"'))
  assert.ok(md.includes('C&lt;1&gt;&amp;'))
})

test('structural layout commands do not interrupt an active IME composition', () => {
  const h = harness(); inside(h, 'A1')
  h.editor.view.composing = true
  const before = json(h.state.doc)
  for (const [command, args] of [['insertLayout', [2]], ['setLayoutColumns', [3]], ['setLayoutWidths', [[30, 70]]], ['setLayoutDirection', ['rtl']], ['addAfterLayout', []], ['deleteLayout', []]]) assert.equal(h.run(command, ...args), false)
  assert.equal(json(h.state.doc), before)
  assert.equal(undoDepth(h.state), 0)
})


test('thirty independent groups retain every block through repeated structural edits', (t) => {
  const doc = schema.nodes.doc.create(null, Array.from({ length: 30 }, (_, i) => group(Array.from({ length: i % 2 ? 3 : 2 }, (_, c) => `G${i}-C${c}`))))
  const h = harness(doc, true)
  const texts = (d) => { const values = []; d.descendants((n) => { if (n.isText) values.push(n.text) }); return values.sort() }
  const before = texts(h.state.doc), started = performance.now()
  for (let i = 0; i < 30; i++) {
    inside(h, `G${i}-C0`)
    h.run('setLayoutWidths', i % 2 ? [20, 30, 50] : [30, 70])
  }
  inside(h, 'G29-C2')
  h.run('moveToLayout', groupColumns(h.state.doc)[0].pos)
  assert.deepEqual(texts(h.state.doc), before)
  assert.equal(h.state.doc.childCount, 30)
  assert.ok(layoutStructureValid(h.state.doc))
  h.state.doc.check()
  t.diagnostic(`Structural edits on 30 groups: ${(performance.now() - started).toFixed(1)} ms; no formal performance budget is claimed.`)
})
