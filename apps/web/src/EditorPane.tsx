import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { DIRS, createEditor, setDir, type Dir } from '@nevis/editor'
import type { DocHandle } from '@nevis/core'
import type { Workspace } from './workspace'

/** One open page: title + body. The body is the Yjs document of the page; the title is a register. */
export function EditorPane({ ws, id, title }: { ws: Workspace; id: string; title: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'needs-update'>('loading')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [name, setName] = useState(title)
  useEffect(() => setName(title), [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let ed: Editor | null = null
    let handle: DocHandle | null = null
    let dead = false
    setState('loading'); setEditor(null)
    void ws.openDoc(id).then(h => {
      if (dead) return
      handle = h
      if (h.needsUpdate) { setState('needs-update'); return } // ADR-0003 §6: a newer schema is not edited by an older client
      ed = createEditor(h.ydoc, host.current!)
      ;(window as unknown as { __editor?: Editor }).__editor = ed
      setEditor(ed); setState('ready')
    })
    return () => { dead = true; ed?.destroy(); if (handle) void ws.closeDoc(id) }
  }, [ws, id])

  const diverged = ws.diverged.has(id)
  useEffect(() => { editor?.setEditable(!diverged) }, [editor, diverged])
  if (state === 'needs-update') return <section className="pane"><p role="alert" data-testid="needs-update">این صفحه با نسخهٔ تازه‌تری از برنامه ساخته شده؛ به‌روزرسانی لازم است.</p></section>
  return (
    <section className="pane">
      <input className="page-title" data-testid="title" value={name} placeholder="بدون عنوان" onChange={e => { setName(e.target.value); ws.setTitle(id, e.target.value) }} />
      {editor && (
        <div className="bar" role="toolbar">
          <button onClick={() => editor.chain().focus().toggleBold().run()}>پررنگ</button>
          <button onClick={() => editor.chain().focus().toggleItalic().run()}>کج</button>
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>تیتر</button>
          <button onClick={() => editor.chain().focus().toggleBulletList().run()}>فهرست</button>
          {DIRS.map(d => <button key={d} onClick={() => { setDir(editor, d as Dir); editor.commands.focus() }}>{d}</button>)}
          <button onClick={() => editor.chain().focus().undo().run()}>واگرد</button>
        </div>
      )}
      {diverged && (
        <p role="alert" className="err" data-testid="too-large">
          آخرین ویرایش بیش از حد بزرگ بود و ذخیره نشد؛ هر چه بعد از آن نوشته شود هم ذخیره نمی‌شود. <button onClick={() => void ws.reopenDoc(id)}>باز کردن دوباره از آخرین نسخهٔ ذخیره‌شده</button>
        </p>
      )}
      <div className="editor" data-testid="editor" ref={host} />
    </section>
  )
}
