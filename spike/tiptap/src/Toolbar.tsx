import { useEffect, useRef, useState, type ReactNode } from 'react'
import { alertDialog, promptDialog } from './dialog'
import { hasHeaderColumn, hasHeaderRow } from './editor/tableHeader'
import { linkSelection } from './editor/slash'
import * as Ic from './icons'
import { insertImageFromUrl, insertImages, pickImages } from './editor/image'
import { t } from './i18n'
import { LayoutInsert } from './LayoutControls'

type Chain = any

/** Fixed formatting bar above the page (as in the mockups): one floating pill. The same commands as the floating text menu. */
export function Toolbar({ editor, diagram }: { editor: any; diagram?: { from: number; to: number; code: string } | null }) {
  const B = ({ label, title, on, run, cls }: { label: ReactNode; title: string; on?: boolean; run: (c: Chain) => Chain; cls?: string }) => (
    <button className={(on ? 'on ' : '') + (cls ?? '')} title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={() => run(editor.chain().focus()).run()}>
      {label}
    </button>
  )
  // re-render on every transaction so the active states (bold, heading, …) follow the selection
  const [, tick] = useState(0)
  useEffect(() => {
    const bump = () => tick((n) => n + 1)
    editor.on('transaction', bump)
    return () => void editor.off('transaction', bump)
  }, [editor])
  const is = (name: string, attrs?: object) => editor.isActive(name, attrs)
  const wrap = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < 700))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const link = (c: Chain) => {
    const prev = editor.getAttributes('link').href ?? ''
    void promptDialog({ title: t('Link'), message: t('Link URL (empty = remove link)'), initial: prev, placeholder: 'https://', ltr: true }).then((url) => {
      if (url === null) return
      const ch = editor.chain().focus()
      ;(url ? ch.setLink({ href: url }) : ch.unsetLink()).run()
    })
    return c
  }
  // Less-used commands: inline in the bar when there is room, otherwise folded into the "more" dropdown.
  const extras = [
    { key: 'strike', icon: <s>S</s>, title: t('Strikethrough'), on: is('strike'), run: (c: Chain) => c.toggleStrike() },
    { key: 'ol', icon: <Ic.OrderedList size={16} />, title: t('Numbered list'), on: is('orderedList'), run: (c: Chain) => c.toggleOrderedList() },
    { key: 'task', icon: <Ic.Checklist size={16} />, title: t('Checklist'), on: is('taskList'), run: (c: Chain) => c.toggleTaskList() },
    { key: 'quote', icon: <Ic.Quote size={16} />, title: t('Quote'), on: is('blockquote'), run: (c: Chain) => c.toggleBlockquote() },
    { key: 'code', icon: <Ic.Code size={16} />, title: t('Inline code'), on: is('code'), run: (c: Chain) => c.toggleCode() },
    { key: 'link', icon: <Ic.Link size={16} />, title: t('Link'), on: is('link'), run: link },
    { key: 'at', icon: <Ic.At size={16} />, title: t('Link to page'), run: (c: Chain) => linkSelection(c, editor) },
    { key: 'cb', icon: <span className="tb-tx">{'{ }'}</span>, title: t('Code block'), on: is('codeBlock'), run: (c: Chain) => c.toggleCodeBlock() },
    ...(diagram ? [{ key: 'diagram', icon: <Ic.Diagram size={16} />, title: t('Turn the selected text into a Mermaid diagram'), run: (c: Chain) => c.insertContentAt({ from: diagram.from, to: diagram.to }, { type: 'mermaid', attrs: { code: diagram.code } }) }] : []),
    { key: 'undo', icon: <Ic.Undo size={16} />, title: t('Undo  Ctrl+Z'), run: (c: Chain) => c.undo() },
    { key: 'redo', icon: <Ic.Redo size={16} />, title: t('Redo  Ctrl+Y'), run: (c: Chain) => c.redo() },
  ]
  return (
    <div className="toolbar" role="toolbar" aria-label={t('Formatting')} ref={wrap}>
      <div className="tb-pill">
        <B cls="tb-add" label={<Ic.Plus size={16} />} title={t('Add block ( / )')} run={(c) => c.setTextSelection(editor.state.selection.to).insertContent('/')} />
        <span className="sep" />
        <B label="H1" title={t('Heading 1')} on={is('heading', { level: 1 })} run={(c) => c.toggleHeading({ level: 1 })} />
        <B label="H2" title={t('Heading 2')} on={is('heading', { level: 2 })} run={(c) => c.toggleHeading({ level: 2 })} />
        <B label="H3" title={t('Heading 3')} on={is('heading', { level: 3 })} run={(c) => c.toggleHeading({ level: 3 })} />
        <span className="sep" />
        <B label={<b>B</b>} title={t('Bold  Ctrl+B')} on={is('bold')} run={(c) => c.toggleBold()} />
        <B label={<i>I</i>} title={t('Italic  Ctrl+I')} on={is('italic')} run={(c) => c.toggleItalic()} />
        <B label={<u>U</u>} title={t('Underline  Ctrl+U')} on={is('underline')} run={(c) => c.toggleUnderline()} />
        <B label={<Ic.List size={16} />} title={t('Bulleted list')} on={is('bulletList')} run={(c) => c.toggleBulletList()} />
        <span className="sep" />
        <ImageMenu editor={editor} />
        <TableMenu editor={editor} />
        <LayoutInsert editor={editor} />
        <DirMenu editor={editor} />
        <span className="sep" />
        {(['left', 'center', 'right'] as const).map((a) => (
          <B key={a} label={{ left: <Ic.AlignLeft size={16} />, center: <Ic.AlignCenter size={16} />, right: <Ic.AlignRight size={16} /> }[a]} title={t({ left: 'Align left', center: 'Center', right: 'Align right' }[a])} on={editor.getAttributes('paragraph').textAlign === a || editor.getAttributes('heading').textAlign === a} run={(c) => c.setTextAlign(a)} />
        ))}
        <span className="sep" />
        {compact ? <MoreMenu editor={editor} items={extras} /> : extras.map(({ key, icon, title, on, run }) => <B key={key} label={icon} title={title} on={on} run={run} />)}
      </div>
    </div>
  )
}

/** "More" dropdown: the commands that did not fit in the bar. */
function MoreMenu({ editor, items }: { editor: any; items: { key: string; icon: ReactNode; title: string; on?: boolean; run: (c: Chain) => Chain }[] }) {
  const { open, setOpen, ref } = useDropdown()
  return (
    <div className="tb-dd" ref={ref}>
      <button className={open ? 'on' : ''} title={t('More')} aria-label={t('More')} aria-haspopup="menu" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <Ic.Dots size={16} />
      </button>
      {open && (
        <div className="tb-menu" role="menu">
          {items.map((it) => (
            <button key={it.key} className={'tb-mi' + (it.on ? ' on' : '')} role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => (it.run(editor.chain().focus()).run(), setOpen(false))}>
              <span className="tb-mi-ic">{it.icon}</span>
              <span className="tb-mi-l">{it.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Open/close state for a toolbar dropdown: closes on an outside click or Escape. */
function useDropdown() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => (document.removeEventListener('mousedown', off), document.removeEventListener('keydown', esc))
  }, [open])
  return { open, setOpen, ref }
}

/** Direction picker: one button that opens a small menu with LTR / RTL (replaces the two separate buttons). */
function DirMenu({ editor }: { editor: any }) {
  const { open, setOpen, ref } = useDropdown()
  const cur = editor.getAttributes('paragraph').dir ?? editor.getAttributes('heading').dir
  const pick = (d: 'ltr' | 'rtl') => (editor.chain().focus().setDirection(d).run(), setOpen(false))
  const Item = ({ d, label }: { d: 'ltr' | 'rtl'; label: string }) => (
    <button className={'tb-mi' + (cur === d ? ' on' : '')} role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(d)}>
      <span className="tb-mi-ic"><Ic.Direction size={16} /></span>
      <span className="tb-mi-l">{label}</span>
      {cur === d && <Ic.Check size={14} />}
    </button>
  )
  return (
    <div className="tb-dd" ref={ref}>
      <button className={open ? 'on' : ''} title={t('Line direction')} aria-label={t('Line direction')} aria-haspopup="menu" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <Ic.Direction size={16} />
        <span className="tb-chev"><Ic.Chevron size={12} /></span>
      </button>
      {open && (
        <div className="tb-menu" role="menu">
          <Item d="ltr" label="LTR (Left to right)" />
          <Item d="rtl" label="RTL (Right to left)" />
        </div>
      )}
    </div>
  )
}

const GRID_ROWS = 5
const GRID_COLS = 9

/** Table menu: size grid to insert a table, plus row/column/delete actions for the table the cursor is in. */
function TableMenu({ editor }: { editor: any }) {
  const { open, setOpen, ref } = useDropdown()
  const [hover, setHover] = useState({ r: 3, c: 3 })
  const inTable = editor.isActive('table')
  const run = (fn: (c: Chain) => Chain) => (fn(editor.chain().focus()).run(), setOpen(false))
  const insert = (rows: number, cols: number) => run((c) => c.insertTable({ rows, cols, withHeaderRow: true }))
  const Item = ({ icon, label, onClick, danger, off, on }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; off?: boolean; on?: boolean }) => (
    <button className={'tb-mi' + (danger ? ' danger' : '') + (on ? ' on' : '')} role="menuitemcheckbox" aria-checked={on} disabled={off} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <span className="tb-mi-ic">{icon}</span>
      <span className="tb-mi-l">{label}</span>
      {on && <Ic.Check size={14} />}
    </button>
  )
  return (
    <div className="tb-dd" ref={ref}>
      <button className={open ? 'on' : ''} title={t('Table')} aria-label={t('Table')} aria-haspopup="menu" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <Ic.Table size={16} />
      </button>
      {open && (
        <div className="tb-menu tb-table-menu" role="menu">
          <div className="tb-grid" onMouseLeave={() => setHover({ r: 3, c: 3 })}>
            {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
              const r = Math.floor(i / GRID_COLS) + 1
              const c = (i % GRID_COLS) + 1
              return <span key={i} className={r <= hover.r && c <= hover.c ? 'on' : ''} onMouseEnter={() => setHover({ r, c })} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(r, c)} />
            })}
          </div>
          <div className="tb-grid-size">{hover.r} × {hover.c}</div>
          <div className="tb-msep" />
          <Item icon={<Ic.Table size={16} />} label={t('Insert table')} onClick={() => insert(hover.r, hover.c)} />
          <Item icon={<Ic.Plus size={16} />} label={t('Insert row above')} off={!inTable} onClick={() => run((c) => c.addRowBefore())} />
          <Item icon={<Ic.Plus size={16} />} label={t('Insert row below')} off={!inTable} onClick={() => run((c) => c.addRowAfter())} />
          <Item icon={<Ic.Plus size={16} />} label={t('Insert column left')} off={!inTable} onClick={() => run((c) => c.addColumnBefore())} />
          <Item icon={<Ic.Plus size={16} />} label={t('Insert column right')} off={!inTable} onClick={() => run((c) => c.addColumnAfter())} />
          <div className="tb-msep" />
          <Item icon={<Ic.Table size={16} />} label={t('Header row')} on={inTable && hasHeaderRow(editor)} off={!inTable} onClick={() => run((c) => c.toggleHeaderRow())} />
          <Item icon={<Ic.Table size={16} />} label={t('Header column')} on={inTable && hasHeaderColumn(editor)} off={!inTable} onClick={() => run((c) => c.toggleHeaderColumn())} />
          <div className="tb-msep" />
          <Item icon={<Ic.AlignLeft size={16} />} label={t('Align table left')} off={!inTable} onClick={() => run((c) => c.setTableAlign('left'))} />
          <Item icon={<Ic.AlignCenter size={16} />} label={t('Center table')} off={!inTable} onClick={() => run((c) => c.setTableAlign('center'))} />
          <Item icon={<Ic.AlignRight size={16} />} label={t('Align table right')} off={!inTable} onClick={() => run((c) => c.setTableAlign('right'))} />
          <Item icon="▭" label={t('Full-width table')} off={!inTable} onClick={() => run((c) => c.setTableAlign(null).setTableWidth(100))} />
          <div className="tb-msep" />
          <Item danger icon={<Ic.Trash size={16} />} label={t('Delete table')} off={!inTable} onClick={() => run((c) => c.deleteTable())} />
        </div>
      )}
    </div>
  )
}

/** Image menu: upload from the device, paste from the clipboard, add by URL, or remove the selected image. */
function ImageMenu({ editor }: { editor: any }) {
  const { open, setOpen, ref } = useDropdown()
  const isImg = editor.isActive('image')
  const done = (fn: () => unknown) => (setOpen(false), void fn())
  const pasteImage = async () => {
    try {
      const out: File[] = []
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((x) => x.startsWith('image/'))
        if (type) out.push(new File([await item.getType(type)], 'pasted.' + type.split('/')[1], { type }))
      }
      if (out.length) await insertImages(editor, out)
      else void alertDialog({ title: t('No image on the clipboard') })
    } catch {
      void alertDialog({ title: t('No image on the clipboard') })
    }
  }
  const Item = ({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) => (
    <button className={'tb-mi' + (danger ? ' danger' : '')} role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <span className="tb-mi-ic">{icon}</span>
      <span className="tb-mi-l">{label}</span>
    </button>
  )
  return (
    <div className="tb-dd" ref={ref}>
      <button className={open ? 'on' : ''} title={t('Image')} aria-label={t('Image')} aria-haspopup="menu" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <Ic.Image size={16} />
      </button>
      {open && (
        <div className="tb-menu" role="menu">
          <Item icon={<Ic.Upload size={16} />} label={t('Upload from device')} onClick={() => done(() => pickImages(editor))} />
          <Item icon={<Ic.Page size={16} />} label={t('Paste from clipboard')} onClick={() => done(pasteImage)} />
          <Item icon={<Ic.Link size={16} />} label={t('Add image from link')} onClick={() => done(() => insertImageFromUrl(editor))} />
          {isImg && <div className="tb-msep" />}
          {isImg && <Item danger icon={<Ic.Trash size={16} />} label={t('Remove image')} onClick={() => done(() => editor.chain().focus().deleteSelection().run())} />}
        </div>
      )}
    </div>
  )
}
