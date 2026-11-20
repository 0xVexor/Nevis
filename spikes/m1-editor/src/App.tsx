import { EditorContent } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { BODY, normalize, project, schema } from '@nevis/schema'
import { DIRS, createEditor, setDir, type Dir } from './editor'
import { initialJson } from './fuzz'
import { Relay, type Side } from './relay'

const FA = ['سلام', 'دنیا', 'نوشتن', 'کتاب', 'می‌خواهم', '۱۲۳', 'گربه', 'برنامه']
const EN = ['hello', 'world', 'sync', 'merge']

interface Demo { relay: Relay; editors: Record<Side, Editor>; docs: Record<Side, Y.Doc> }
declare global { interface Window { __demo?: Demo } }

function makeDemo(): Demo {
  const a = new Y.Doc(), b = new Y.Doc()
  prosemirrorJSONToYXmlFragment(schema, normalize(initialJson()), a.getXmlFragment(BODY))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const relay = new Relay(a, b)
  return { relay, docs: { A: a, B: b }, editors: { A: createEditor(a), B: createEditor(b) } }
}

function Pane({ side, demo, label }: { side: Side; demo: Demo; label: string }) {
  const ed = demo.editors[side]
  return (
    <section className="pane" data-side={side}>
      <h3>{label}</h3>
      <div className="bar">
        {DIRS.map(d => <button key={d} onClick={() => setDir(ed, d as Dir)}>{d}</button>)}
        <button onClick={() => ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run()}>جدول ۳×۳</button>
        <button onClick={() => ed.commands.undo()}>undo</button>
        <button onClick={() => ed.commands.redo()}>redo</button>
      </div>
      <EditorContent editor={ed} className="editor" data-testid={`editor-${side}`} />
    </section>
  )
}

export function App() {
  const demo = useMemo(makeDemo, [])
  window.__demo = demo
  const [delay, setDelay] = useState(0)
  const [off, setOff] = useState({ A: false, B: false })
  const [dup, setDup] = useState(false)
  const [bot, setBot] = useState(false)
  const [hold, setHold] = useState(true)
  const [, force] = useState(0)
  const botRef = useRef(bot)
  botRef.current = bot

  useEffect(() => { demo.relay.delayMs = delay }, [delay, demo])
  useEffect(() => { demo.relay.offline = off }, [off, demo])
  useEffect(() => { demo.relay.duplicate = dup }, [dup, demo])
  useEffect(() => {
    const holdWhile = (side: Side) => () => hold && demo.editors[side].view.composing
    demo.relay.holdWhile = { A: holdWhile('A'), B: holdWhile('B') }
    const max = Number(new URLSearchParams(location.search).get('holdMax'))
    if (max > 0) demo.relay.holdMaxMs = max
  }, [hold, demo])
  useEffect(() => {
    const id = setInterval(() => { demo.relay.tick(); force(n => n + 1) }, 50)
    return () => clearInterval(id)
  }, [demo])
  useEffect(() => {
    // the bot types in B every 200 ms: a Persian or English word at a random place
    const id = setInterval(() => {
      if (!botRef.current) return
      const e = demo.editors.B
      const spots: number[] = []
      const onlyFirst = new URLSearchParams(location.search).has('botFirst') // stress: the bot types in the same paragraph the person is composing in
      e.state.doc.descendants((node, pos) => { if (node.isTextblock && (!onlyFirst || spots.length === 0)) spots.push(pos + 1 + Math.floor(Math.random() * (node.content.size + 1))) })
      const pos = spots[Math.floor(Math.random() * spots.length)]
      if (pos === undefined) return
      const w = Math.random() < 0.6 ? FA[Math.floor(Math.random() * FA.length)]! : EN[Math.floor(Math.random() * EN.length)]!
      e.view.dispatch(e.state.tr.insertText(w + ' ', pos).setMeta('addToHistory', true))
    }, 200)
    return () => clearInterval(id)
  }, [demo])

  const pa = JSON.stringify(project(demo.docs.A), null, 1)
  const pb = JSON.stringify(project(demo.docs.B), null, 1)
  const pending = demo.relay.pending()
  const converged = pa === pb && pending.A === 0 && pending.B === 0
  const sizeA = Y.encodeStateAsUpdate(demo.docs.A).length, sizeB = Y.encodeStateAsUpdate(demo.docs.B).length

  return (
    <main dir="rtl">
      <h1>M1 — دو ادیتور، یک سند</h1>
      <div className="controls">
        <label>تأخیر: {delay}ms <input type="range" min={0} max={2000} step={100} value={delay} onChange={e => setDelay(+e.target.value)} /></label>
        <label><input type="checkbox" checked={off.A} onChange={e => setOff({ ...off, A: e.target.checked })} /> A آفلاین</label>
        <label><input type="checkbox" checked={off.B} onChange={e => setOff({ ...off, B: e.target.checked })} /> B آفلاین</label>
        <label><input type="checkbox" checked={dup} onChange={e => setDup(e.target.checked)} /> تحویل تکراری</label>
        <label><input type="checkbox" checked={bot} onChange={e => setBot(e.target.checked)} /> ربات تایپ در B</label>
        <label title="update دوردست را تا پایان composition نگه می‌دارد"><input type="checkbox" checked={hold} onChange={e => setHold(e.target.checked)} /> صف composition</label>
        <strong data-testid="converged" data-ok={converged}>{converged ? 'همگرا ✓' : 'همگرا ✗'}</strong>
        <span>در صف: A→B {pending.A}، B→A {pending.B}</span>
        <span>اندازه: A {sizeA}B · B {sizeB}B</span>
      </div>
      <div className="panes">
        <Pane side="A" demo={demo} label="A" />
        <Pane side="B" demo={demo} label="B" />
      </div>
      <details open><summary>projection (JSON ProseMirror)</summary>
        <div className="panes"><pre dir="ltr" data-testid="proj-A">{pa}</pre><pre dir="ltr" data-testid="proj-B">{pb}</pre></div>
      </details>
    </main>
  )
}
