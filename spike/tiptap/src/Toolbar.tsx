import type { ChainedCommands } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
export function Toolbar({ editor, diagram }: { editor: Editor; diagram?: { from: number; to: number; code: string } | null }) {
  const { open, menu } = useMenu()
  const B = ({ label, name, icon, on, run, primary }: { label: string; name?: string; icon: ReactNode; on?: boolean; run: (c: Chain) => Chain; primary?: boolean }) => (
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
  const menuItem = (label: string, icon: string, fn: () => unknown, on?: boolean, more: { hint?: string; danger?: boolean } = {}): MenuItem => ({ label, icon: <Icon name={icon} />, hint: more.hint ?? keysOf(label), checked: on, danger: more.danger, onSelect: () => void fn() })
  const dropdown = (label: string, icon: string, items: () => MenuItem[]) => (
    <button
      type="button"
      className="ds-icon-btn tb-btn tb-btn--menu"
      title={label === 'Line direction' ? t(label) + '  ' + [keysOf('Line direction: left-to-right'), keysOf('Line direction: right-to-left')].filter(Boolean).join(' · ') : tip(label)}
      aria-label={t(label)}
      aria-haspopup="menu"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => open(items(), e.currentTarget)}
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
        <B primary label="Open the “/” menu" icon={<Icon name="plus" size={16} />} run={(c) => c.setTextSelection(editor.state.selection.to).insertContent('/')} />
        <span className="tb-sep" />
        <B label="Heading 1" icon={<span className="tb-tx">H1</span>} on={is('heading', { level: 1 })} run={(c) => c.toggleHeading({ level: 1 })} />
        <B label="Heading 2" icon={<span className="tb-tx">H2</span>} on={is('heading', { level: 2 })} run={(c) => c.toggleHeading({ level: 2 })} />
        <B label="Heading 3" icon={<span className="tb-tx">H3</span>} on={is('heading', { level: 3 })} run={(c) => c.toggleHeading({ level: 3 })} />
        <span className="tb-sep" />
        <B label="Bold" icon={<span className="tb-tx tb-tx--bold">B</span>} on={is('bold')} run={(c) => c.toggleBold()} />
        <B label="Italic" icon={<span className="tb-tx tb-tx--italic">I</span>} on={is('italic')} run={(c) => c.toggleItalic()} />
        <B label="Underline" icon={<span className="tb-tx tb-tx--underline">U</span>} on={is('underline')} run={(c) => c.toggleUnderline()} />
        <B label="Bulleted list" icon={<Icon name="list" size={16} />} on={is('bulletList')} run={(c) => c.toggleBulletList()} />
        <span className="tb-sep" />
        {dropdown('Insert image', 'image', imageItems)}
        <TableMenu editor={editor} />
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
              <B key={x.label} label={x.label} icon={<Icon name={x.icon} size={16} />} on={x.on} run={x.fn} />
            ))}
            <span className="tb-sep" />
            <B label="Undo" icon={<Icon name="undo" size={16} />} run={(c) => c.undo()} />
            <B label="Redo" icon={<Icon name="redo" size={16} />} run={(c) => c.redo()} />
          </>
        )}
      </div>
      {menu}
    </div>
  )
}

/** Open/close state for the table dropdown: closes on an outside click or Escape. */
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

const GRID_ROWS = 5
const GRID_COLS = 9

/** Table menu: a size grid to insert a table, then row, column, header, alignment and delete actions for the table the cursor is in. */
function TableMenu({ editor }: { editor: Editor }) {
  const { open, setOpen, ref } = useDropdown()
  const [hover, setHover] = useState({ r: 3, c: 3 })
  const inTable = editor.isActive('table')
  const run = (fn: (c: Chain) => Chain) => (fn(editor.chain().focus()).run(), setOpen(false))
  const insert = (rows: number, cols: number) => run((c) => c.insertTable({ rows, cols, withHeaderRow: true }))
  const Item = ({ icon, label, onClick, danger, off, on, hint }: { icon: string; label: string; onClick: () => void; danger?: boolean; off?: boolean; on?: boolean; hint?: string }) => (
    <button type="button" className="ds-menu-item" role={on === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={on} data-danger={danger || undefined} disabled={off} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name={icon} />
      <span className="ds-menu-label">{label}</span>
      {on && <Icon name="check" size={14} />}
      {hint && <kbd className="ds-menu-hint">{hint}</kbd>}
    </button>
  )
  return (
    <div className="tb-dd" ref={ref}>
      <button
        type="button"
        className="ds-icon-btn tb-btn tb-btn--menu"
        aria-pressed={open}
        title={tip('Insert table')}
        aria-label={t('Table')}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <Icon name="table" size={16} />
        <Icon name="chevron-down" size={10} />
      </button>
      {open && (
        <div className="ds-pop ds-menu tb-table-menu" role="menu">
          <div className="tb-grid" onMouseLeave={() => setHover({ r: 3, c: 3 })}>
            {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
              const r = Math.floor(i / GRID_COLS) + 1
              const c = (i % GRID_COLS) + 1
              return <span key={i} className={r <= hover.r && c <= hover.c ? 'on' : ''} onMouseEnter={() => setHover({ r, c })} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(r, c)} />
            })}
          </div>
          <div className="tb-grid-size">
            {hover.r} × {hover.c}
          </div>
          <div className="ds-menu-sep" role="separator" />
          <Item icon="table" label={t('Insert table')} hint={keysOf('Insert table')} onClick={() => insert(hover.r, hover.c)} />
          <Item icon="plus" label={t('Insert row above')} off={!inTable} onClick={() => run((c) => c.addRowBefore())} />
          <Item icon="plus" label={t('Insert row below')} off={!inTable} onClick={() => run((c) => c.addRowAfter())} />
          <Item icon="plus" label={t('Insert column left')} off={!inTable} onClick={() => run((c) => c.addColumnBefore())} />
          <Item icon="plus" label={t('Insert column right')} off={!inTable} onClick={() => run((c) => c.addColumnAfter())} />
          <div className="ds-menu-sep" role="separator" />
          <Item icon="table" label={t('Header row')} on={inTable && hasHeaderRow(editor)} off={!inTable} onClick={() => run((c) => c.toggleHeaderRow())} />
          <Item icon="table" label={t('Header column')} on={inTable && hasHeaderColumn(editor)} off={!inTable} onClick={() => run((c) => c.toggleHeaderColumn())} />
          <div className="ds-menu-sep" role="separator" />
          <Item icon="align-left" label={t('Align table left')} off={!inTable} onClick={() => run((c) => c.setTableAlign('left'))} />
          <Item icon="align-center" label={t('Center table')} off={!inTable} onClick={() => run((c) => c.setTableAlign('center'))} />
          <Item icon="align-right" label={t('Align table right')} off={!inTable} onClick={() => run((c) => c.setTableAlign('right'))} />
          <Item icon="maximize" label={t('Full-width table')} off={!inTable} onClick={() => run((c) => c.setTableAlign(null).setTableWidth(100))} />
          <div className="ds-menu-sep" role="separator" />
          <Item danger icon="trash" label={t('Delete table')} off={!inTable} onClick={() => run((c) => c.deleteTable())} />
        </div>
      )}
    </div>
  )
}
