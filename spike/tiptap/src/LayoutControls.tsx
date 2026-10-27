import { useEffect, useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import { MenuItem, MenuLabel, MenuSep, Popover } from './ui'
import * as Ic from './icons'
import { t } from './i18n'
import { confirmDialog } from './dialog'
import { activeGroup, blockRange, groupColumns, NodeSelection } from './editor/layout'
import { COLUMN, GROUP, ancestor, displayWidths, equalWidths } from './editor/layoutModel'
import type { Editor } from '@tiptap/core'

function LayoutPreview({ count }: { count: number }) {
  return <span className="layout-preview" aria-hidden="true"><Ic.Columns count={count} size={18} /></span>
}

export function LayoutInsert({ editor }: { editor: Editor }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const inside = !!ancestor(editor.state.selection.$from, COLUMN)
  return <>
    <button type="button" title={t('Insert Layout')} aria-label={t('Insert Layout')} aria-haspopup="menu" aria-expanded={!!anchor} onMouseDown={(e) => e.preventDefault()} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
      <LayoutPreview count={2} />
    </button>
    {anchor && <Popover anchor={anchor} onClose={() => { setAnchor(null); editor.commands.focus() }}>
      <div className="menu layout-menu" role="menu">
        <MenuLabel>{t('Insert Layout')}</MenuLabel>
        {inside ? <>
          <MenuItem disabled label={t('Layouts cannot be nested.')} onClick={() => {}} />
          <MenuItem icon={<Ic.Plus size={16} />} label={t('Add full-width text after layout')} onClick={() => { setAnchor(null); editor.chain().focus().addAfterLayout().run() }} />
        </> : [2, 3].map((count) => <MenuItem key={count} icon={<LayoutPreview count={count} />} label={t('{n} columns', { n: count })} desc={t('Equal widths')} onClick={() => { setAnchor(null); editor.chain().focus().insertLayout(count).run() }} />)}
      </div>
    </Popover>}
  </>
}

/** Focused group settings, using the same compact toolbar and popover as other editor tools. */
export function LayoutControls({ editor }: { editor: Editor }) {
  const [menu, setMenu] = useState<{ kind: 'layout' | 'move'; rect: DOMRect; doc: Editor['state']['doc'] } | null>(null)
  const focusRef = useRef<HTMLButtonElement>(null)
  const s = useEditorState({ editor, selector: ({ editor: ed }) => {
    const group = activeGroup(ed.state)
    return { pos: group?.pos ?? -1, count: group?.node.childCount ?? 0, widths: group ? displayWidths(group.node) : [], direction: group?.node.attrs.direction ?? null, movable: !!blockRange(ed.state), editable: ed.isEditable }
  } })
  const close = () => { setMenu(null); editor.commands.focus() }
  useEffect(() => {
    const open = (e: Event) => {
      if (!editor.isEditable) return
      const supplied = (e as CustomEvent<DOMRect>).detail
      const coords = editor.view.coordsAtPos(editor.state.selection.from)
      setMenu({ kind: 'move', rect: supplied || new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top), doc: editor.state.doc })
    }
    editor.view.dom.addEventListener('layout-move-menu', open)
    const changed = () => setMenu((prev) => prev && (prev.doc !== editor.state.doc || !editor.isEditable) ? null : prev)
    editor.on('transaction', changed)
    return () => { editor.view.dom.removeEventListener('layout-move-menu', open); editor.off('transaction', changed) }
  }, [editor])
  useEffect(() => {
    if (menu) requestAnimationFrame(() => document.querySelector<HTMLElement>('.layout-menu button:not(:disabled)')?.focus())
  }, [menu])
  if (!s.editable) return null
  const group = activeGroup(editor.state)
  const run = (fn: () => void) => { setMenu(null); fn(); editor.commands.focus() }
  const openMenu = (kind: 'layout' | 'move', rect: DOMRect) => setMenu({ kind, rect, doc: editor.state.doc })
  const deleteGroup = async () => {
    if (!group) return
    const { doc } = editor.state, { pos, node } = group
    setMenu(null)
    let empty = true
    node.descendants((n) => { if (n.isText && n.text?.length || n.isLeaf && !n.isText && n.type.name !== 'paragraph' || !['layoutColumn', 'paragraph', 'text'].includes(n.type.name)) empty = false })
    if (!empty && !await confirmDialog({ title: t('Delete layout and content'), message: t('Delete this layout with {n} columns and all its content? You can undo this action.', { n: node.childCount }), confirmLabel: t('Delete'), danger: true })) return
    // A sync or local edit while confirmation is open invalidates the old position.
    if (editor.isDestroyed || editor.state.doc !== doc) return
    editor.commands.deleteLayout(pos)
    editor.commands.focus()
  }
  const selectedGroup = editor.state.selection instanceof NodeSelection && editor.state.selection.node.type.name === GROUP
  const columns = groupColumns(editor.state.doc)
  const groups = columns.filter((c) => c.column === 1)
  return <>
    {s.count > 0 && <div className="layout-context" role="toolbar" aria-label={t('Layout')}>
      <button ref={focusRef} type="button" className="ghost-btn" aria-haspopup="menu" aria-expanded={menu?.kind === 'layout'} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu('layout', e.currentTarget.getBoundingClientRect())}>
        <LayoutPreview count={s.count} /> {t('{n} columns', { n: s.count })} <Ic.Chevron size={12} />
      </button>
      <button type="button" className="ghost-btn" onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu('move', e.currentTarget.getBoundingClientRect())}><Ic.Arrow size={14} /> {t('Move to Column')}</button>
      <button type="button" className="icon-btn" title={t('Add full-width text after layout')} aria-label={t('Add full-width text after layout')} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().addAfterLayout().run()}><Ic.Plus size={16} /></button>
    </div>}
    {menu && <Popover anchor={menu.rect} onClose={close}>
      <div className="menu layout-menu" role="menu">
        {menu.kind === 'layout' && group ? <>
          <MenuLabel>{t('Columns')}</MenuLabel>
          {[1, 2, 3].map((n) => <MenuItem key={n} icon={<LayoutPreview count={n} />} label={n === 1 ? t('Convert to full width') : t('{n} columns', { n })} desc={n < group.node.childCount && n > 1 ? t('Content from removed columns moves to the last column.') : undefined} onClick={() => run(() => { editor.commands.setLayoutColumns(n, group.pos) })} />)}
          <MenuSep />
          <MenuLabel>{t('Width')}</MenuLabel>
          {(group.node.childCount === 2 ? [[50, 50], [30, 70], [70, 30]] : [equalWidths(3)]).map((widths, i) => <MenuItem key={i} icon={<Ic.AlignLeft size={16} />} label={widths.every((w) => Math.abs(w - widths[0]) < 0.01) ? t('Equal widths') : widths.join(' / ') + '%'} onClick={() => run(() => { editor.commands.setLayoutWidths(widths, group.pos) })} />)}
          <MenuSep />
          <MenuLabel>{t('Layout direction')}</MenuLabel>
          {([null, 'ltr', 'rtl'] as const).map((d) => <MenuItem key={d ?? 'inherit'} icon={s.direction === d ? <Ic.Check size={16} /> : <Ic.Direction size={16} />} label={d === null ? t('Follow page direction') : d.toUpperCase()} onClick={() => run(() => { editor.commands.setLayoutDirection(d, group.pos) })} />)}
          <MenuSep />
          <MenuItem icon={<Ic.Plus size={16} />} label={t('Add full-width text after layout')} onClick={() => run(() => { editor.commands.addAfterLayout(group.pos) })} />
          <MenuItem icon={<Ic.Arrow size={16} />} label={t('Move layout')} desc={t('Use the grip or keyboard to move this layout.')} onClick={() => run(() => { editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, group.pos))) })} />
          <MenuItem icon={<Ic.Trash size={16} />} label={t('Delete layout and content')} danger onClick={() => void deleteGroup()} />
        </> : <>
          <MenuLabel>{t('Move to Column')}</MenuLabel>
          {!s.movable && <div className="layout-menu-note">{t('Select complete blocks from one column.')}</div>}
          {columns.map((col) => <div key={col.pos}>
            <MenuLabel>{t('Layout {group}, column {column}', { group: col.group, column: col.column })} · {col.node.textContent.slice(0, 44) || t('Empty')}</MenuLabel>
            {([false, true]).map((end) => <MenuItem key={String(end)} disabled={!s.movable || selectedGroup} icon={<Ic.Arrow size={14} />} label={t(end ? 'Move to end' : 'Move to start')} onClick={() => run(() => { editor.commands.moveToLayout(col.pos, end) })} />)}
          </div>)}
          {groups.length > 0 && <MenuSep />}
          {groups.flatMap((g) => [false, true].map((after) => <MenuItem key={g.groupPos + String(after)} disabled={!s.movable} icon={<Ic.Arrow size={14} />} label={t(after ? 'Full width after layout {n}' : 'Full width before layout {n}', { n: g.group })} onClick={() => run(() => { editor.commands.moveOutsideLayout(g.groupPos, after) })} />))}
          <MenuSep />
          <MenuItem disabled={!s.movable} icon={<Ic.Arrow size={14} />} label={t('Move block up')} hint="Ctrl+Alt+↑" onClick={() => run(() => { editor.commands.shiftLayoutBlock(-1) })} />
          <MenuItem disabled={!s.movable} icon={<Ic.Arrow size={14} />} label={t('Move block down')} hint="Ctrl+Alt+↓" onClick={() => run(() => { editor.commands.shiftLayoutBlock(1) })} />
        </>}
      </div>
    </Popover>}
  </>
}
