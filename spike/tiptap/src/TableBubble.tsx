import type { ChainedCommands } from '@tiptap/core'
import { Icon, Toolbar, ToolbarButton, ToolbarGroup, ToolbarSep } from './design-system'
import type { Editor } from '@tiptap/core'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEditorState } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { useAnchor } from './editor/useAnchor'
import { hasHeaderColumn, hasHeaderRow } from './editor/tableHeader'
import { t } from './i18n'

/** The DOM table the cursor is in. */
function tableDom(editor: Editor): HTMLElement | null {
  const selection = editor.state.selection
  if (selection instanceof NodeSelection && selection.node.type.name === 'table') return editor.view.nodeDOM(selection.from) as HTMLElement | null
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') {
      const dom = editor.view.nodeDOM($from.before(d)) as HTMLElement | null
      // Anchor above the WHOLE frame, including its drag surface, rather than over that surface.
      return dom
    }
  }
  return null
}

function B({ icon, title, on, danger, off, text, onClick }: { icon: ReactNode; title: string; on?: boolean; danger?: boolean; off?: boolean; text?: boolean; onClick: () => void }) {
  return (
    <ToolbarButton label={title} pressed={on} danger={danger} text={text} disabled={off} onClick={onClick}>
      {icon}
    </ToolbarButton>
  )
}
const Group = ToolbarGroup

/**
 * Toolbar for the table the cursor is in: rows, columns, cells, header, direction, size, position.
 * Anchored to the complete frame; useAnchor keeps the drag surface clear while scrolling.
 */
export function TableBubble({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e || !e.isEditable || !e.isActive('table')) return null
      const a = e.getAttributes('table')
      return { hr: hasHeaderRow(e), hc: hasHeaderColumn(e), w: a.tableWidth ?? 100, align: a.tableAlign ?? null, dir: a.dir ?? null, merge: e.can().mergeCells(), split: e.can().splitCell() }
    },
  })
  // shown by a click on the table, gone with the next click anywhere else (not on hover, not on a keyboard move into the table)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (el?.closest?.('.bubble.tbl')) return
      setArmed(!!el?.closest?.('.tiptap table'))
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [])
  useEffect(() => {
    if (!s) setArmed(false)
  }, [s])
  const open = !!s && armed
  const box = useAnchor(editor, open, () => tableDom(editor), [s?.w, s?.align])

  if (!open) return null
  const run = (fn: (c: ChainedCommands) => ChainedCommands) => fn(editor.chain().focus()).run()
  return createPortal(
    <Toolbar ref={box} label={t('Table')} style={{ position: 'fixed', zIndex: 'var(--ds-z-float)' }} onMouseDown={(e) => e.preventDefault()}>
      <Group label={t('Row')}>
        <B icon={<Icon name="row-above" size={16} />} title={t('Insert row above')} onClick={() => run((c) => c.addRowBefore())} />
        <B icon={<Icon name="row-below" size={16} />} title={t('Insert row below')} onClick={() => run((c) => c.addRowAfter())} />
        <B icon={<Icon name="row-delete" size={16} />} title={t('Delete row')} danger onClick={() => run((c) => c.deleteRow())} />
      </Group>
      <ToolbarSep />
      <Group label={t('Column')}>
        <B icon={<Icon name="col-left" size={16} />} title={t('Insert column left')} onClick={() => run((c) => c.addColumnBefore())} />
        <B icon={<Icon name="col-right" size={16} />} title={t('Insert column right')} onClick={() => run((c) => c.addColumnAfter())} />
        <B icon={<Icon name="col-delete" size={16} />} title={t('Delete column')} danger onClick={() => run((c) => c.deleteColumn())} />
      </Group>
      <ToolbarSep />
      <Group label={t('Cells')}>
        <B icon={<Icon name="cell-merge" size={16} />} title={t('Merge cells')} off={!s?.merge} onClick={() => run((c) => c.mergeCells())} />
        <B icon={<Icon name="cell-split" size={16} />} title={t('Split cell')} off={!s?.split} onClick={() => run((c) => c.splitCell())} />
        <B icon={<Icon name="head-row" size={16} />} title={t('Header row')} on={s?.hr} onClick={() => run((c) => c.toggleHeaderRow())} />
        <B icon={<Icon name="head-col" size={16} />} title={t('Header column')} on={s?.hc} onClick={() => run((c) => c.toggleHeaderColumn())} />
      </Group>
      <ToolbarSep />
      <Group label={t('Direction')}>
        <B icon={<>RTL</>} text title={t('Table RTL')} on={s?.dir === 'rtl'} onClick={() => run((c) => c.setTableDirection('rtl'))} />
        <B icon={<>LTR</>} text title={t('Table LTR')} on={s?.dir === 'ltr'} onClick={() => run((c) => c.setTableDirection('ltr'))} />
      </Group>
      <ToolbarSep />
      <Group label={t('Width')}>
        {[50, 75, 100].map((w) => (
          <B key={w} icon={<>{w}%</>} text title={t('Table width {w}%', { w })} on={s?.w === w} onClick={() => run((c) => c.setTableWidth(w))} />
        ))}
      </Group>
      <ToolbarSep />
      <Group label={t('Position')}>
        <B icon={<Icon name="align-left" size={16} />} title={t('Align table left')} on={s?.align === 'left'} onClick={() => run((c) => c.setTableAlign('left'))} />
        <B icon={<Icon name="align-center" size={16} />} title={t('Center table')} on={s?.align === 'center'} onClick={() => run((c) => c.setTableAlign('center'))} />
        <B icon={<Icon name="align-right" size={16} />} title={t('Align table right')} on={s?.align === 'right'} onClick={() => run((c) => c.setTableAlign('right'))} />
      </Group>
      <ToolbarSep />
      <Group label={t('Table')}>
        <B icon={<Icon name="table-delete" size={16} />} title={t('Delete table')} danger onClick={() => run((c) => c.deleteTable())} />
      </Group>
    </Toolbar>,
    document.body,
  )
}
