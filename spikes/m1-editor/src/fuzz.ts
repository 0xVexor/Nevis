// Randomised two-replica editing through the REAL editors (ProseMirror transactions through y-tiptap), with delayed,
// reordered and duplicated delivery. Runs in a browser page (the editor needs a DOM): window.__fuzz(seed, steps, withUndo).
import { TextSelection } from '@tiptap/pm/state'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { BODY, attrValues, isBlockId, normalize, project, schema, type PMJson } from '@nevis/schema'
import { createEditor, setDir, DIRS } from './editor'
import { Relay } from './relay'

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FA = ['سلام', 'دنیا', 'نوشتن', 'کتاب', 'می‌خواهم', '۱۲۳', 'گربه', 'برنامه', 'یادداشت']
const EN = ['hello', 'world', 'sync', 'merge', '42', 'Nevis']
const pick = <T,>(rng: () => number, a: readonly T[]): T => a[Math.floor(rng() * a.length)]!
const word = (rng: () => number) => (rng() < 0.6 ? pick(rng, FA) : pick(rng, EN))

let counter = 0
const bid = () => `01930000-0000-7000-8000-${String(++counter).padStart(12, '0')}`
const para = (text: string, dir = 'auto'): PMJson => ({ type: 'paragraph', attrs: { blockId: bid(), dir }, content: [{ type: 'text', text }] })

export function initialJson(): PMJson {
  const cell = (t: string): PMJson => ({ type: 'tableCell', attrs: { blockId: bid(), colspan: 1, rowspan: 1 }, content: [para(t)] })
  const item = (t: string): PMJson => ({ type: 'listItem', attrs: { blockId: bid() }, content: [para(t)] })
  return {
    type: 'doc',
    content: [
      para('سلام دنیا، این یک سند آزمایشی است'),
      para('mixed متن مخلوط 123 and English', 'rtl'),
      { type: 'bulletList', attrs: { blockId: bid() }, content: [item('اول'), item('دوم'), item('سوم')] },
      para('left to right paragraph', 'ltr'),
      { type: 'table', attrs: { blockId: bid(), dir: 'rtl' }, content: [{ type: 'tableRow', attrs: { blockId: bid() }, content: [cell('الف'), cell('ب')] }, { type: 'tableRow', attrs: { blockId: bid() }, content: [cell('ج'), cell('د')] }] },
      // M8a: the blocks of the old editor (not the drawing: it only loads Excalidraw when it is shown)
      { type: 'callout', attrs: { blockId: bid(), icon: 'info' }, content: [para('کادر نکته'), { type: 'bulletList', attrs: { blockId: bid() }, content: [item('داخل کادر')] }] },
      { type: 'toggle', attrs: { blockId: bid(), open: true }, content: [para('عنوان بازشو'), para('محتوای بازشو')] },
      { type: 'layoutGroup', attrs: { blockId: bid(), dir: 'auto' }, content: [{ type: 'layoutColumn', attrs: { blockId: bid(), width: 0 }, content: [para('ستون یک')] }, { type: 'layoutColumn', attrs: { blockId: bid(), width: 0 }, content: [para('ستون دو'), para('خط دوم')] }] },
      { type: 'mathBlock', attrs: { blockId: bid(), latex: 'x^2' } },
      { type: 'mermaid', attrs: { blockId: bid(), code: 'graph TD\n A-->B' } },
      { type: 'image', attrs: { blockId: bid(), src: '', alt: 'جای تصویر', title: '', width: 0, align: '', motion: '' } },
      para('پایان'),
    ],
  }
}

/** The first place two JSON values differ, for the report. */
export function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`
  const ka = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
  for (const k of ka) { const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`); if (d) return d }
  return path
}

export interface FuzzResult {
  seed: number
  steps: number
  withUndo: boolean
  docsEqual: boolean
  viewChecks: number
  viewMismatches: number
  fixedByRerender: number
  rangeErrors: number
  otherErrors: number
  errorSample: string[]
  idsOk: boolean
  nullAttrs: number
  sizeA: number
  ms: number
  mismatchSample: string[]
  /** view differed from the Y.Doc for a moment and agreed after one event-loop turn */
  transient: number
}

const settle = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

export async function runFuzz(seed: number, steps = 500, withUndo = false, checkEvery = 5): Promise<FuzzResult> {
  const t0 = performance.now()
  const rng = mulberry32(seed)
  const a = new Y.Doc(), b = new Y.Doc()
  prosemirrorJSONToYXmlFragment(schema, normalize(initialJson()), a.getXmlFragment(BODY))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const relay = new Relay(a, b)
  const ed = { A: createEditor(a), B: createEditor(b) }
  const docs = { A: a, B: b }
  const res: FuzzResult = { seed, steps, withUndo, docsEqual: false, viewChecks: 0, viewMismatches: 0, fixedByRerender: 0, rangeErrors: 0, otherErrors: 0, errorSample: [], idsOk: false, nullAttrs: 0, sizeA: 0, ms: 0, mismatchSample: [], transient: 0 }

  const checkViews = async () => {
    for (const side of ['A', 'B'] as const) {
      res.viewChecks++
      let want = JSON.stringify(project(docs[side]))
      let got = JSON.stringify(normalize(ed[side].getJSON() as PMJson))
      if (want !== got) {
        // the binding writes the editor's own follow-up transactions (block ids) to the Y.Doc a moment later: look again
        await settle(80)
        want = JSON.stringify(project(docs[side]))
        got = JSON.stringify(normalize(ed[side].getJSON() as PMJson))
        if (want === got) { res.transient++; continue }
      }
      if (want !== got) {
        res.viewMismatches++
        if (res.mismatchSample.length < 3) res.mismatchSample.push((firstDiff(project(docs[side]), normalize(ed[side].getJSON() as PMJson)) ?? '?').slice(0, 60) + ' LAST-OPS ' + log.join(','))
        // can a fresh view on the same Y.Doc show what the document says? (ROADMAP M1: rerender fixes it)
        const fresh = createEditor(docs[side])
        if (JSON.stringify(normalize(fresh.getJSON() as PMJson)) === want) res.fixedByRerender++
        fresh.destroy()
      }
    }
  }

  const blockStarts = (e: (typeof ed)['A']) => {
    const out: { from: number; to: number }[] = []
    e.state.doc.descendants((node, pos) => { if (node.isTextblock) out.push({ from: pos + 1, to: pos + 1 + node.content.size }) })
    return out
  }

  const log: string[] = []
  const op = (side: 'A' | 'B') => {
    const e = ed[side]
    const blocks = blockStarts(e)
    if (!blocks.length) return
    const blk = pick(rng, blocks)
    const pos = blk.from + Math.floor(rng() * (blk.to - blk.from + 1))
    e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(pos))).setMeta('addToHistory', false))
    const r = rng()
    // 0-8 text and structure, 9-10 undo/redo, 11-16 the M8a blocks
    const paste = (window as unknown as { __fuzzPaste?: boolean }).__fuzzPaste ? [17] : [] // STRESS only (FUZZ_PASTE=1): a multi-block paste at a random caret
    const pool = withUndo ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, ...paste] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, ...paste]
    const k = pool[Math.floor(r * pool.length)]!
    log.push(`${side}${k}`); if (log.length > 14) log.shift()
    switch (k) {
      case 0: case 1: case 2: e.view.dispatch(e.state.tr.insertText(word(rng) + ' ')); break
      case 3: { const to = Math.min(blk.to, pos + 1 + Math.floor(rng() * 4)); if (to > pos) e.view.dispatch(e.state.tr.delete(pos, to)); break }
      case 4: e.commands.splitBlock(); break
      case 5: e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(blk.from)))); e.commands.joinBackward(); break
      case 6: rng() < 0.5 ? e.commands.liftListItem('listItem') : e.commands.sinkListItem('listItem'); break
      case 7: {
        const top = e.state.doc.childCount
        if (top < 2) break
        const i = Math.floor(rng() * top), j = Math.floor(rng() * top)
        if (i === j) break
        let from = 0
        for (let n = 0; n < i; n++) from += e.state.doc.child(n).nodeSize
        const node = e.state.doc.child(i)
        let target = 0
        for (let n = 0; n < j + (j > i ? 1 : 0); n++) target += e.state.doc.child(n).nodeSize
        const tr = e.state.tr
        tr.delete(from, from + node.nodeSize)
        tr.insert(tr.mapping.map(target), node)
        e.view.dispatch(tr)
        break
      }
      case 8: rng() < 0.7 ? setDir(e, pick(rng, DIRS)) : e.commands.addRowAfter(); break
      case 9: e.commands.undo(); break
      case 10: e.commands.redo(); break
      case 11: { // at a RANDOM caret (inside text, a cell, a list item...): the command itself must put the block on an empty line
        const c = [() => e.commands.insertCallout(pick(rng, ['bulb', 'warning', 'info'])), () => e.commands.insertToggle(), () => e.commands.insertLayout(rng() < 0.5 ? 2 : 3), () => e.commands.insertMathInline('y^2'), () => e.commands.insertMathBlock('z'), () => e.commands.insertImagePlaceholder('جا')]; pick(rng, c)(); break }
      case 12: { // delete a whole top-level block
        const top = e.state.doc.childCount
        if (top < 3) break
        const i = Math.floor(rng() * top)
        let from = 0
        for (let n = 0; n < i; n++) from += e.state.doc.child(n).nodeSize
        e.view.dispatch(e.state.tr.delete(from, from + e.state.doc.child(i).nodeSize))
        break
      }
      case 13: { // change an attribute of a callout, toggle, column group, table or text alignment
        const found: { pos: number; node: ReturnType<typeof e.state.doc.nodeAt> }[] = []
        e.state.doc.descendants((n, pos) => { if (['callout', 'toggle', 'layoutColumn', 'table', 'paragraph', 'image', 'mathBlock'].includes(n.type.name)) found.push({ pos, node: n }) })
        if (!found.length) break
        const t = pick(rng, found)
        const a = t.node!.attrs
        const patch = t.node!.type.name === 'callout' ? { icon: pick(rng, ['bulb', 'warning', 'flame', 'pin']) } : t.node!.type.name === 'toggle' ? { open: !a.open } : t.node!.type.name === 'layoutColumn' ? { width: Math.floor(rng() * 4) * 10 } : t.node!.type.name === 'table' ? { tableAlign: pick(rng, ['', 'left', 'center', 'right']), tableWidth: pick(rng, [0, 50, 75]) } : t.node!.type.name === 'image' ? { width: pick(rng, [0, 25, 50]), align: pick(rng, ['', 'start', 'center', 'end']) } : t.node!.type.name === 'mathBlock' ? { latex: word(rng) } : { textAlign: pick(rng, ['', 'center', 'right']) }
        e.view.dispatch(e.state.tr.setNodeMarkup(t.pos, undefined, { ...a, ...patch }))
        break
      }
      case 14: e.commands.setColumnWidths([0, 0].concat(rng() < 0.5 ? [] : [0]).map(() => Math.floor(rng() * 5) * 10)); break
      case 15: e.commands.setTextAlign(pick(rng, ['left', 'center', 'right', 'justify'] as const)); break
      case 16: e.commands.setDirection(pick(rng, DIRS)); break
      case 17: { // PASTE of several blocks at the random caret (a web page, Word, an AI chat), through the editor's own paste path
        const html = pick(rng, ['<h2>عنوان</h2><p>پاراگراف یک</p><p>دو</p>', '<ul><li>الف</li><li>ب</li></ul><p>پایان</p>', '<blockquote><p>نقل</p></blockquote><p>x</p>', '<table><tr><td>a</td><td>b</td></tr></table>', '<p>یک</p><pre><code>code</code></pre><ol><li>1</li></ol>'])
        e.view.pasteHTML(html)
        break
      }
    }
  }

  for (let s = 0; s < steps; s++) {
    const side = rng() < 0.5 ? 'A' : 'B'
    try { op(side) } catch (err) {
      if (err instanceof RangeError) res.rangeErrors++
      else { res.otherErrors++; if (res.errorSample.length < 3) res.errorSample.push(String((err as Error).message ?? err).slice(0, 160)) }
    }
    if (rng() < 0.5) {
      try { relay.deliverRandom(rng) } catch (err) { res.otherErrors++; if (res.errorSample.length < 3) res.errorSample.push('deliver: ' + String(err).slice(0, 160)) }
    }
    if (s % checkEvery === 0) await checkViews()
  }
  relay.flush()
  relay.flush()
  await settle()
  relay.flush()
  await checkViews()

  const pa = project(a), pb = project(b)
  res.docsEqual = JSON.stringify(pa) === JSON.stringify(pb)
  const ids: string[] = []
  const walk = (n: PMJson) => { if (n.attrs && 'blockId' in n.attrs) ids.push(String(n.attrs.blockId)); n.content?.forEach(walk) }
  walk(pa)
  res.idsOk = ids.every(isBlockId) && new Set(ids).size === ids.length
  for (const [, v] of attrValues(pa)) if (v === null || v === undefined) res.nullAttrs++
  res.sizeA = Y.encodeStateAsUpdate(a).length
  ed.A.destroy(); ed.B.destroy()
  res.ms = Math.round(performance.now() - t0)
  return res
}

/** ROADMAP M1 criterion 7: 100 paragraphs, 30 undo/redo cycles; size of the encoded state. */
export function runSizeTest(): { paragraphs: number; cycles: number; bytes: number; bytesBefore: number } {
  const rng = mulberry32(7)
  const doc = new Y.Doc()
  const json: PMJson = { type: 'doc', content: Array.from({ length: 100 }, (_, i) => para(`پاراگراف شمارهٔ ${i} با کمی متن فارسی و English`)) }
  prosemirrorJSONToYXmlFragment(schema, normalize(json), doc.getXmlFragment(BODY))
  const bytesBefore = Y.encodeStateAsUpdate(doc).length
  const e = createEditor(doc)
  for (let c = 0; c < 30; c++) {
    for (let k = 0; k < 3; k++) {
      const blocks: { from: number; to: number }[] = []
      e.state.doc.descendants((node, pos) => { if (node.isTextblock) blocks.push({ from: pos + 1, to: pos + 1 + node.content.size }) })
      const blk = pick(rng, blocks)
      e.view.dispatch(e.state.tr.insertText(word(rng) + ' ', blk.from + Math.floor(rng() * (blk.to - blk.from + 1))))
    }
    for (let k = 0; k < 3; k++) e.commands.undo()
    for (let k = 0; k < 3; k++) e.commands.redo()
  }
  const bytes = Y.encodeStateAsUpdate(doc).length
  e.destroy()
  return { paragraphs: 100, cycles: 30, bytes, bytesBefore }
}
