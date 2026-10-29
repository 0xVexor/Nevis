import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { MenuItem, MenuLabel, MenuSep, Popover } from './ui'
import * as Ic from './icons'
import { t } from './i18n'
import { confirmDialog } from './dialog'
import { ancestor, blockRange, equalWidths, GROUP, validWidths, type BlockRange } from './editor/layoutModel'
import { LAYOUT_CANCEL } from './editor/layout'
import { SNAP_PICK, type SnapPickRequest } from './editor/dragHandle'
import { directionalSnapTarget, fitsSnapColumns, planSnap, snapKey, verticalSnapTarget, type SnapTarget } from './editor/snapModel'
import { snapContext, snapDestinations } from './editor/snapTargets'

interface MoveMenu { rect: DOMRect; doc: Editor['state']['doc']; range: BlockRange }

/** No permanent layout toolbar: the grip/keyboard menu exposes only contextual actions. */
export function LayoutControls({ editor }: { editor: Editor }) {
  const [menu, setMenu] = useState<MoveMenu | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const pendingFrame = useRef(0)
  const close = () => { setMenu(null); if (!editor.isDestroyed) editor.commands.focus() }
  useEffect(() => {
    const open = (event: Event) => {
      if (!editor.isEditable || editor.view.composing) return
      const range = blockRange(editor.state)
      if (!range) return
      editor.view.dom.dispatchEvent(new Event(LAYOUT_CANCEL))
      const supplied = (event as CustomEvent<DOMRect>).detail
      const coords = editor.view.coordsAtPos(range.from)
      setMenu({ range, doc: editor.state.doc, rect: supplied || new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top) })
    }
    const changed = () => setMenu((previous) => previous && (previous.doc !== editor.state.doc || !editor.isEditable) ? null : previous)
    const cancel = () => {
      cancelAnimationFrame(pendingFrame.current)
      pendingFrame.current = 0
      setMenu(null)
    }
    const escapePending = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pendingFrame.current) { cancel(); if (!editor.isDestroyed) editor.commands.focus() }
    }
    editor.view.dom.addEventListener('layout-move-menu', open)
    editor.view.dom.addEventListener(LAYOUT_CANCEL, cancel)
    window.addEventListener('keydown', escapePending)
    editor.on('transaction', changed)
    return () => {
      cancelAnimationFrame(pendingFrame.current)
      editor.view.dom.removeEventListener('layout-move-menu', open)
      editor.view.dom.removeEventListener(LAYOUT_CANCEL, cancel)
      window.removeEventListener('keydown', escapePending)
      editor.off('transaction', changed)
    }
  }, [editor])
  useEffect(() => {
    if (!menu) return
    const frame = requestAnimationFrame(() => {
      ref.current?.querySelectorAll('button.menu-item').forEach((button) => button.setAttribute('role', 'menuitem'))
      ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [menu])
  if (!menu || editor.isDestroyed || !editor.isEditable || menu.doc !== editor.state.doc) return null
  const valid = () => !editor.isDestroyed && editor.isEditable && !editor.view.composing && editor.state.doc === menu.doc
  const move = (mode: SnapPickRequest['mode']) => {
    if (!valid()) { setMenu(null); return }
    const detail: SnapPickRequest = { mode, range: menu.range, doc: menu.doc }
    setMenu(null)
    // Let Popover unmount before moving focus to the in-page destination picker.
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = 0
      if (valid()) editor.view.dom.dispatchEvent(new CustomEvent(SNAP_PICK, { detail }))
    })
  }
  const selectedGroup = menu.range.nodes.length === 1 && menu.range.nodes[0].type.name === GROUP
  const group = selectedGroup ? { node: menu.range.nodes[0], pos: menu.range.from }
    : ancestor(menu.doc.resolve(menu.range.from), GROUP)
  const run = (action: () => void) => { setMenu(null); if (valid()) { action(); editor.commands.focus() } }
  const remove = async () => {
    setMenu(null)
    if (!group || !valid()) return
    const ok = await confirmDialog({
      title: t('Delete layout and content'),
      message: t('Delete this layout with {n} columns and all its content? You can undo this action.', { n: group.node.childCount }),
      confirmLabel: t('Delete'), danger: true,
    })
    if (ok && valid()) { editor.commands.deleteLayout(group.pos); editor.commands.focus() }
  }
  const before = verticalSnapTarget(editor.state, menu.range, 'up')
  const after = verticalSnapTarget(editor.state, menu.range, 'down')
  const context = snapContext(editor.view)
  const left = directionalSnapTarget(editor.state, menu.range, 'left', context)
  const right = directionalSnapTarget(editor.state, menu.range, 'right', context)
  const destinations = snapDestinations(editor.view, menu.range)
  const available = (target: SnapTarget | null | undefined) => {
    if (!target) return false
    const result = planSnap(editor.state, menu.range, target, context)
    if (!result.plan) return false
    if (!result.plan.columns) return true
    const destination = destinations.find((d) => d.key === snapKey(target))
    return !!destination && fitsSnapColumns(destination.rect.width, result.plan.columns.widths)
  }
  return <Popover anchor={menu.rect} onClose={close}>
    <div ref={ref} className="menu layout-menu" role="menu">
      <MenuLabel>{t(selectedGroup ? 'Move layout' : 'Move block')}</MenuLabel>
      <MenuItem icon={<Ic.Arrow size={16} />} label={t('Move to…')} hint="Ctrl+Alt+M" onClick={() => move('pick')} />
      <MenuItem disabled={!available(before)} label={t('Move block up')} onClick={() => move('up')} />
      <MenuItem disabled={!available(after)} label={t('Move block down')} onClick={() => move('down')} />
      {!selectedGroup && <>
        <MenuItem disabled={!available(left.target)} label={t('Move left')} onClick={() => move('left')} />
        <MenuItem disabled={!available(right.target)} label={t('Move right')} onClick={() => move('right')} />
      </>}
      {group && <>
        <MenuSep />
        {!selectedGroup && <>
          <MenuItem label={t('Extract above layout')} onClick={() => move('outside-before')} />
          <MenuItem label={t('Extract below layout')} onClick={() => move('outside-after')} />
        </>}
        {!validWidths(group.node.attrs.widths, group.node.childCount) && <MenuItem icon={<Ic.Columns count={group.node.childCount} size={16} />} label={t('Equal widths')} onClick={() => run(() => { editor.commands.setLayoutWidths(equalWidths(group.node.childCount), group.pos) })} />}
        <MenuItem icon={<Ic.Columns count={1} size={16} />} label={t('Convert entire layout to full width')} onClick={() => run(() => { editor.commands.setLayoutColumns(1, group.pos) })} />
        <MenuItem icon={<Ic.Plus size={16} />} label={t('Add full-width text after layout')} onClick={() => run(() => { editor.commands.addAfterLayout(group.pos) })} />
        {selectedGroup && <MenuItem icon={<Ic.Trash size={16} />} label={t('Delete layout and content')} danger onClick={() => void remove()} />}
      </>}
    </div>
  </Popover>
}
