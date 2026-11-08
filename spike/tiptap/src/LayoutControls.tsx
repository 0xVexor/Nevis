import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Icon, Menu, type MenuItem } from './design-system'
import { t } from './i18n'
import { confirmDialog } from './dialog'
import { ancestor, blockRange, equalWidths, GROUP, validWidths, type BlockRange } from './editor/layoutModel'
import { LAYOUT_CANCEL } from './editor/layout'
import { SNAP_PICK, type SnapPickRequest } from './editor/dragHandle'
import { directionalSnapTarget, fitsSnapColumns, planSnap, snapKey, verticalSnapTarget, type SnapTarget } from './editor/snapModel'
import { snapContext, snapDestinations } from './editor/snapTargets'

interface MoveMenu {
  rect: DOMRect
  doc: Editor['state']['doc']
  range: BlockRange
}

/** No permanent layout toolbar: the grip/keyboard menu lists only the moves that can happen from here. */
export function LayoutControls({ editor }: { editor: Editor }) {
  const [menu, setMenu] = useState<MoveMenu | null>(null)
  const pendingFrame = useRef(0)
  const close = () => {
    setMenu(null)
    if (!editor.isDestroyed) editor.commands.focus()
  }
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
    const changed = () => setMenu((previous) => (previous && (previous.doc !== editor.state.doc || !editor.isEditable) ? null : previous))
    const cancel = () => {
      cancelAnimationFrame(pendingFrame.current)
      pendingFrame.current = 0
      setMenu(null)
    }
    const escapePending = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pendingFrame.current) {
        cancel()
        if (!editor.isDestroyed) editor.commands.focus()
      }
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
  if (!menu || editor.isDestroyed || !editor.isEditable || menu.doc !== editor.state.doc) return null
  const valid = () => !editor.isDestroyed && editor.isEditable && !editor.view.composing && editor.state.doc === menu.doc
  const move = (mode: SnapPickRequest['mode']) => {
    if (!valid()) {
      setMenu(null)
      return
    }
    const detail: SnapPickRequest = { mode, range: menu.range, doc: menu.doc }
    setMenu(null)
    // Let the menu unmount before moving focus to the in-page destination picker.
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = 0
      if (valid()) editor.view.dom.dispatchEvent(new CustomEvent(SNAP_PICK, { detail }))
    })
  }
  const selectedGroup = menu.range.nodes.length === 1 && menu.range.nodes[0].type.name === GROUP
  const group = selectedGroup ? { node: menu.range.nodes[0], pos: menu.range.from } : ancestor(menu.doc.resolve(menu.range.from), GROUP)
  const run = (action: () => void) => {
    setMenu(null)
    if (valid()) {
      action()
      editor.commands.focus()
    }
  }
  const remove = async () => {
    setMenu(null)
    if (!group || !valid()) return
    const ok = await confirmDialog({
      title: t('Delete layout and content'),
      message: t('Delete this layout with {n} columns and all its content? You can undo this action.', { n: group.node.childCount }),
      confirmLabel: t('Delete'),
      danger: true,
    })
    if (ok && valid()) {
      editor.commands.deleteLayout(group.pos)
      editor.commands.focus()
    }
  }
  const context = snapContext(editor.view)
  const destinations = snapDestinations(editor.view, menu.range)
  const available = (target: SnapTarget | null | undefined) => {
    if (!target) return false
    const result = planSnap(editor.state, menu.range, target, context)
    if (!result.plan) return false
    if (!result.plan.columns) return true
    const destination = destinations.find((d) => d.key === snapKey(target))
    return !!destination && fitsSnapColumns(destination.rect.width, result.plan.columns.widths)
  }
  const icon = (name: string) => <Icon name={name} size={16} />
  // A move that cannot happen from here is left out rather than shown disabled: fewer, real choices.
  const when = (condition: boolean, item: MenuItem): MenuItem[] => (condition ? [item] : [])
  const items: MenuItem[] = [
    { kind: 'head', label: selectedGroup ? 'Move layout' : 'Move block' },
    { label: 'Move to…', icon: icon('move'), hint: 'Ctrl+Alt+M', onSelect: () => move('pick') },
    ...when(available(verticalSnapTarget(editor.state, menu.range, 'up')), { label: 'Move block up', icon: icon('arrow-up'), hint: 'Ctrl+Alt+↑', onSelect: () => move('up') }),
    ...when(available(verticalSnapTarget(editor.state, menu.range, 'down')), { label: 'Move block down', icon: icon('arrow-down'), hint: 'Ctrl+Alt+↓', onSelect: () => move('down') }),
    ...(selectedGroup
      ? []
      : [
          ...when(available(directionalSnapTarget(editor.state, menu.range, 'left', context).target), {
            label: 'Move left',
            icon: icon('arrow-left'),
            hint: 'Ctrl+Alt+←',
            onSelect: () => move('left'),
          }),
          ...when(available(directionalSnapTarget(editor.state, menu.range, 'right', context).target), {
            label: 'Move right',
            icon: icon('arrow-right'),
            hint: 'Ctrl+Alt+→',
            onSelect: () => move('right'),
          }),
        ]),
  ]
  if (group) {
    items.push({ kind: 'sep' }, { kind: 'head', label: 'Layout' })
    if (!selectedGroup)
      items.push(
        { label: 'Extract above layout', icon: icon('arrow-up'), onSelect: () => move('outside-before') },
        { label: 'Extract below layout', icon: icon('arrow-down'), onSelect: () => move('outside-after') },
      )
    if (!validWidths(group.node.attrs.widths, group.node.childCount))
      items.push({ label: 'Equal widths', icon: icon(group.node.childCount === 3 ? 'columns-3' : 'columns'), onSelect: () => run(() => editor.commands.setLayoutWidths(equalWidths(group.node.childCount), group.pos)) })
    items.push(
      { label: 'Convert entire layout to full width', icon: icon('panel-left'), onSelect: () => run(() => editor.commands.setLayoutColumns(1, group.pos)) },
      { label: 'Add full-width text after layout', icon: icon('plus'), hint: 'Ctrl+Alt+Enter', onSelect: () => run(() => editor.commands.addAfterLayout(group.pos)) },
    )
    if (selectedGroup) items.push({ kind: 'sep' }, { label: 'Delete layout and content', icon: icon('trash'), danger: true, onSelect: () => void remove() })
  }
  return <Menu anchor={menu.rect} items={items} onClose={close} autoFocus />
}
