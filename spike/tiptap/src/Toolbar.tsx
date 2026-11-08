import type { ChainedCommands } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { alertDialog } from './dialog'
import { hasHeaderColumn, hasHeaderRow } from './editor/tableHeader'
import { linkSelection } from './editor/slash'
import { editLink } from './editor/linkPrompt'
import { Icon, useMenu, type MenuItem } from './design-system'
import { insertImageFromUrl, insertImages, pickImages } from './editor/image'
import { commandBinding } from './shortcutCommands'
import { shortcutLabel } from './shortcuts'
import { t } from './i18n'

type Chain = ChainedCommands

/** The command's name and its current shortcut (Settings can change it), for a tooltip or a menu hint. */
const keysOf = (label: string) => {
  const keys = commandBinding(label)?.keys[0]
  return keys ? shortcutLabel(keys) : undefined
}
const tip = (label: string) => {
  const keys = keysOf(label)
  return t(label) + (keys ? '  ' + keys : '')
}

/**
 * The formatting bar above the page: one raised strip of design-system icon buttons in groups, each with its shortcut in the tooltip.
 * Less-used commands fold into "More" when the page is narrow. Dropdowns are design-system menus.
 */
/** One button of the bar. Defined at module level so the bar's per-keystroke re-render updates the buttons instead of remounting them. */
function B({ editor, label, name, icon, on, run, primary }: { editor: Editor; label: string; name?: string; icon: ReactNode; on?: boolean; run: (c: Chain) => Chain; primary?: boolean }) {
  return (
    <button
      type="button"
      className={'ds-icon-btn tb-btn' + (primary ? ' tb-btn--primary' : '')}
      aria-pressed={on === undefined ? undefined : on}
      title={name ?? tip(label)}
      aria-label={name ?? tip(label)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => run(editor.chain().focus()).run()}
    >
      {icon}
    </button>
  )
}

export function Toolbar({ editor, diagram }: { editor: Editor; diagram?: { from: number; to: number; code: string } | null }) {
  const { open, close, menu } = useMenu()
  // re-render on every transaction so the active states (bold, heading, …) follow the selection
  const [, tick] = useState(0)
  useEffect(() => {
    const bump = () => tick((n) => n + 1)
    editor.on('transaction', bump)
    return () => void editor.off('transaction', bump)
  }, [editor])
  const is = (name: string, attrs?: object) => editor.isActive(name, attrs)
  const wrap = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  // the width the full bar needs, measured whenever it is shown in full; narrower than that, the rest folds into More
  const needed = useRef(0)
  useLayoutEffect(() => {
    const el = wrap.current,
      bar = pill.current
    if (compact || !el || !bar) return
    const style = getComputedStyle(bar)
    const items = [...bar.children] as HTMLElement[]
    needed.current = items.reduce((w, item) => w + item.offsetWidth, 0) + parseFloat(style.columnGap || '0') * (items.length - 1) + parseFloat(style.paddingInlineStart) + parseFloat(style.paddingInlineEnd) + 2
    if (needed.current > el.clientWidth) setCompact(true)
  })
  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < needed.current))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const run = (fn: (c: Chain) => Chain) => () => fn(editor.chain().focus()).run()
  const menuItem = (label: string, icon: string, fn: () => unknown, on?: boolean, more: { hint?: string; danger?: boolean; disabled?: boolean } = {}): MenuItem => ({ label, icon: <Icon name={icon} />, hint: more.hint ?? keysOf(label), checked: on, danger: more.danger, disabled: more.disabled, onSelect: () => void fn() })
  const dropdown = (label: string, icon: string, items: () => MenuItem[], header?: () => ReactNode) => (
    <button
      type="button"
      className="ds-icon-btn tb-btn tb-btn--menu"
      title={label === 'Line direction' ? t(label) + '  ' + [keysOf('Line direction: left-to-right'), keysOf('Line direction: right-to-left')].filter(Boolean).join(' · ') : tip(label)}
      aria-label={t(label)}
      aria-haspopup="menu"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => open(items(), e.currentTarget, header?.())}
    >
      <Icon name={icon} size={16} />
      <Icon name="chevron-down" size={10} />
    </button>
  )
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
  const imageItems = (): MenuItem[] => [
    menuItem('Upload from device', 'upload', () => pickImages(editor), undefined, { hint: keysOf('Insert image') }),
    menuItem('Paste from clipboard', 'clipboard', pasteImage),
    menuItem('Add image from link', 'link', () => insertImageFromUrl(editor)),
    ...(is('image') ? [{ kind: 'sep' } as MenuItem, menuItem('Remove image', 'trash', run((c) => c.deleteSelection()), undefined, { danger: true })] : []),
  ]
  const dir = editor.getAttributes('paragraph').dir ?? editor.getAttributes('heading').dir
  const dirItems = (): MenuItem[] => [
    menuItem('Line direction: left-to-right', 'arrow-right', run((c) => c.setDirection('ltr')), dir === 'ltr'),
    menuItem('Line direction: right-to-left', 'arrow-left', run((c) => c.setDirection('rtl')), dir === 'rtl'),
  ]
  const align: 'left' | 'center' | 'right' | undefined = editor.getAttributes('paragraph').textAlign ?? editor.getAttributes('heading').textAlign
  const alignItems = (): MenuItem[] => [
    menuItem('Align left', 'align-left', run((c) => c.setTextAlign('left')), align === 'left'),
    menuItem('Center', 'align-center', run((c) => c.setTextAlign('center')), align === 'center'),
    menuItem('Align right', 'align-right', run((c) => c.setTextAlign('right')), align === 'right'),
  ]
  // the table menu: a size grid above the row, column, header and alignment actions; "Insert table" uses the size picked in the grid
  const tableSize = useRef(GRID_START)
  const insertTable = (r: number, c: number) => editor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: true }).run()
  const tableGrid = () => {
    tableSize.current = GRID_START
    return <TableGrid onChange={(size) => (tableSize.current = size)} onPick={(r, c) => (close(), insertTable(r, c))} />
  }
  const tableItems = (): MenuItem[] => {
    const off = !is('table')
    const act = (label: string, icon: string, fn: (c: Chain) => Chain, more: { on?: boolean; danger?: boolean } = {}) => menuItem(label, icon, run(fn), more.on, { danger: more.danger, disabled: off })
    return [
      { kind: 'sep' },
      menuItem('Insert table', 'table', () => insertTable(tableSize.current.r, tableSize.current.c)),
      act('Insert row above', 'plus', (c) => c.addRowBefore()),
      act('Insert row below', 'plus', (c) => c.addRowAfter()),
      act('Insert column left', 'plus', (c) => c.addColumnBefore()),
      act('Insert column right', 'plus', (c) => c.addColumnAfter()),
      { kind: 'sep' },
      act('Header row', 'table', (c) => c.toggleHeaderRow(), { on: !off && hasHeaderRow(editor) }),
      act('Header column', 'table', (c) => c.toggleHeaderColumn(), { on: !off && hasHeaderColumn(editor) }),
      { kind: 'sep' },
      act('Align table left', 'align-left', (c) => c.setTableAlign('left')),
      act('Center table', 'align-center', (c) => c.setTableAlign('center')),
      act('Align table right', 'align-right', (c) => c.setTableAlign('right')),
      act('Full-width table', 'maximize', (c) => c.setTableAlign(null).setTableWidth(100)),
      { kind: 'sep' },
      act('Delete table', 'trash', (c) => c.deleteTable(), { danger: true }),
    ]
  }
  // less-used commands: in the bar when there is room, otherwise in "More"
  const extras: { label: string; icon: string; on?: boolean; fn: (c: Chain) => Chain }[] = [
    { label: 'Strikethrough', icon: 'strikethrough', on: is('strike'), fn: (c) => c.toggleStrike() },
    { label: 'Numbered list', icon: 'list-ordered', on: is('orderedList'), fn: (c) => c.toggleOrderedList() },
    { label: 'Checklist', icon: 'checklist', on: is('taskList'), fn: (c) => c.toggleTaskList() },
    { label: 'Quote', icon: 'quote', on: is('blockquote'), fn: (c) => c.toggleBlockquote() },
    { label: 'Inline code', icon: 'code', on: is('code'), fn: (c) => c.toggleCode() },
    { label: 'Code block', icon: 'code-block', on: is('codeBlock'), fn: (c) => c.toggleCodeBlock() },
    { label: 'Link', icon: 'link', on: is('link'), fn: (c) => (editLink(editor), c) },
    { label: 'Link to page', icon: 'mention', fn: (c) => linkSelection(c, editor) },
    ...(diagram
      ? [{ label: 'Turn the selected text into a Mermaid diagram', icon: 'diagram', fn: (c: Chain) => c.insertContentAt({ from: diagram.from, to: diagram.to }, { type: 'mermaid', attrs: { code: diagram.code } }) }]
      : []),
  ]
  return (
    <div className={'toolbar' + (menu ? ' is-open' : '')} role="toolbar" aria-label={t('Formatting')} ref={wrap}>
      <div className="tb-pill" ref={pill}>
        <B editor={editor} primary label="Open the “/” menu" icon={<Icon name="plus" size={16} />} run={(c) => c.setTextSelection(editor.state.selection.to).insertContent('/')} />
        <span className="tb-sep" />
        <B editor={editor} label="Heading 1" icon={<span className="tb-tx">H1</span>} on={is('heading', { level: 1 })} run={(c) => c.toggleHeading({ level: 1 })} />
        <B editor={editor} label="Heading 2" icon={<span className="tb-tx">H2</span>} on={is('heading', { level: 2 })} run={(c) => c.toggleHeading({ level: 2 })} />
        <B editor={editor} label="Heading 3" icon={<span className="tb-tx">H3</span>} on={is('heading', { level: 3 })} run={(c) => c.toggleHeading({ level: 3 })} />
        <span className="tb-sep" />
        <B editor={editor} label="Bold" icon={<span className="tb-tx tb-tx--bold">B</span>} on={is('bold')} run={(c) => c.toggleBold()} />
        <B editor={editor} label="Italic" icon={<span className="tb-tx tb-tx--italic">I</span>} on={is('italic')} run={(c) => c.toggleItalic()} />
        <B editor={editor} label="Underline" icon={<span className="tb-tx tb-tx--underline">U</span>} on={is('underline')} run={(c) => c.toggleUnderline()} />
        <B editor={editor} label="Bulleted list" icon={<Icon name="list" size={16} />} on={is('bulletList')} run={(c) => c.toggleBulletList()} />
        <span className="tb-sep" />
        {dropdown('Insert image', 'image', imageItems)}
        {dropdown('Insert table', 'table', tableItems, tableGrid)}
        {dropdown('Line direction', 'text-direction', dirItems)}
        <span className="tb-sep" />
        {dropdown('Alignment', 'align-' + (align ?? 'left'), alignItems)}
        <span className="tb-sep" />
        {compact ? (
          // narrow: the rest folds into one menu, so the bar keeps to one line
          dropdown('More', 'more-horizontal', () => [...extras.map((x) => menuItem(x.label, x.icon, run(x.fn), x.on)), { kind: 'sep' }, menuItem('Undo', 'undo', run((c) => c.undo())), menuItem('Redo', 'redo', run((c) => c.redo()))])
        ) : (
          <>
            {extras.map((x) => (
              <B editor={editor} key={x.label} label={x.label} icon={<Icon name={x.icon} size={16} />} on={x.on} run={x.fn} />
            ))}
            <span className="tb-sep" />
            <B editor={editor} label="Undo" icon={<Icon name="undo" size={16} />} run={(c) => c.undo()} />
            <B editor={editor} label="Redo" icon={<Icon name="redo" size={16} />} run={(c) => c.redo()} />
          </>
        )}
      </div>
      {menu}
    </div>
  )
}

const GRID_ROWS = 5
const GRID_COLS = 9
const GRID_START = { r: 3, c: 3 }

/**
 * The table size grid at the top of the table menu. The pointer picks a size by hovering; the keyboard moves with the arrows
 * (Up from the first row and Down from the last hand back to the menu) and Enter inserts.
 */
function TableGrid({ onChange, onPick }: { onChange: (size: { r: number; c: number }) => void; onPick: (r: number, c: number) => void }) {
  const [size, setSize] = useState(GRID_START)
  const current = useRef(GRID_START) // read by the keys, so presses faster than a render still add up
  const move = (next: { r: number; c: number }) => ((current.current = next), setSize(next), onChange(next))
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const { r, c } = current.current
    // the grid is laid out left to right in both directions, so Right always adds a column
    const next =
      e.key === 'ArrowRight' ? { r, c: Math.min(GRID_COLS, c + 1) }
      : e.key === 'ArrowLeft' ? { r, c: Math.max(1, c - 1) }
      : e.key === 'ArrowDown' && r < GRID_ROWS ? { r: r + 1, c }
      : e.key === 'ArrowUp' && r > 1 ? { r: r - 1, c }
      : null
    if (next) move(next)
    else if (e.key === 'Enter' || e.key === ' ') onPick(r, c)
    else return
    e.preventDefault()
    e.stopPropagation() // the menu's own arrow keys wait until the grid hands over
  }
  return (
    <>
      <div className="tb-grid" data-menu-item tabIndex={0} role="group" aria-label={`${t('Insert table')} ${size.r} × ${size.c}`} onKeyDown={key} onMouseLeave={() => move(GRID_START)}>
        {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
          const r = Math.floor(i / GRID_COLS) + 1
          const c = (i % GRID_COLS) + 1
          return <span key={i} className={r <= size.r && c <= size.c ? 'on' : ''} onMouseEnter={() => move({ r, c })} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(r, c)} />
        })}
      </div>
      <div className="tb-grid-size" aria-hidden="true">
        {size.r} × {size.c}
      </div>
    </>
  )
}
