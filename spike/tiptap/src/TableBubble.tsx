import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEditorState } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import * as Ic from './icons'
import { useAnchor } from './editor/useAnchor'
import { hasHeaderColumn, hasHeaderRow } from './editor/tableHeader'
import { t } from './i18n'

/** The DOM table the cursor is in. */
function tableDom(editor: any): HTMLElement | null {
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

function B({ icon, title, on, danger, off, onClick }: { icon: ReactNode; title: string; on?: boolean; danger?: boolean; off?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={'tbb' + (on ? ' on' : '') + (danger ? ' danger' : '')} title={title} aria-label={title} aria-pressed={on} disabled={off} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {icon}
    </button>
  )
}
const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="tbg" role="group" aria-label={label}>
    <span className="tbg-l">{label}</span>
    <div className="tbg-b">{children}</div>
  </div>
)

/**
 * Toolbar for the table the cursor is in: rows, columns, cells, header, direction, size, position.
 * Anchored to the complete frame; useAnchor keeps the drag surface clear while scrolling.
 */
export function TableBubble({ editor }: { editor: any }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }: any) => {
      if (!e || !e.isEditable || !e.isActive('table')) return null
      const a = e.getAttributes('table')
      return { hr: hasHeaderRow(e), hc: hasHeaderColumn(e), w: a.tableWidth ?? 100, align: a.tableAlign ?? null, dir: a.dir ?? null, merge: e.can().mergeCells(), split: e.can().splitCell() }
    },
  })
  const open = !!s
  const box = useAnchor(editor, open, () => tableDom(editor), [s?.w, s?.align])

  if (!open) return null
  const run = (fn: (c: any) => any) => fn(editor.chain().focus()).run()
  return createPortal(
    <div ref={box} className="bubble tbl" role="toolbar" aria-label={t('Table')} dir="ltr" style={{ position: 'fixed', zIndex: 60 }} onMouseDown={(e) => e.preventDefault()}>
      <Group label={t('Row')}>
        <B icon={<Ic.RowAbove />} title={t('Insert row above')} onClick={() => run((c) => c.addRowBefore())} />
        <B icon={<Ic.RowBelow />} title={t('Insert row below')} onClick={() => run((c) => c.addRowAfter())} />
        <B icon={<Ic.RowDelete />} title={t('Delete row')} danger onClick={() => run((c) => c.deleteRow())} />
      </Group>
      <Group label={t('Column')}>
        <B icon={<Ic.ColLeft />} title={t('Insert column left')} onClick={() => run((c) => c.addColumnBefore())} />
        <B icon={<Ic.ColRight />} title={t('Insert column right')} onClick={() => run((c) => c.addColumnAfter())} />
        <B icon={<Ic.ColDelete />} title={t('Delete column')} danger onClick={() => run((c) => c.deleteColumn())} />
      </Group>
      <Group label={t('Cells')}>
        <B icon={<Ic.CellMerge />} title={t('Merge cells')} off={!s?.merge} onClick={() => run((c) => c.mergeCells())} />
        <B icon={<Ic.CellSplit />} title={t('Split cell')} off={!s?.split} onClick={() => run((c) => c.splitCell())} />
        <B icon={<Ic.HeadRow />} title={t('Header row')} on={s?.hr} onClick={() => run((c) => c.toggleHeaderRow())} />
        <B icon={<Ic.HeadCol />} title={t('Header column')} on={s?.hc} onClick={() => run((c) => c.toggleHeaderColumn())} />
      </Group>
      <Group label={t('Direction')}>
        <B icon={<span className="tbb-t">RTL</span>} title={t('Table RTL')} on={s?.dir === 'rtl'} onClick={() => run((c) => c.setTableDirection('rtl'))} />
        <B icon={<span className="tbb-t">LTR</span>} title={t('Table LTR')} on={s?.dir === 'ltr'} onClick={() => run((c) => c.setTableDirection('ltr'))} />
      </Group>
      <Group label={t('Width')}>
        {[50, 75, 100].map((w) => (
          <B key={w} icon={<span className="tbb-t">{w}%</span>} title={t('Table width {w}%', { w })} on={s?.w === w} onClick={() => run((c) => c.setTableWidth(w))} />
        ))}
      </Group>
      <Group label={t('Position')}>
        <B icon={<Ic.AlignLeft size={16} />} title={t('Align table left')} on={s?.align === 'left'} onClick={() => run((c) => c.setTableAlign('left'))} />
        <B icon={<Ic.AlignCenter size={16} />} title={t('Center table')} on={s?.align === 'center'} onClick={() => run((c) => c.setTableAlign('center'))} />
        <B icon={<Ic.AlignRight size={16} />} title={t('Align table right')} on={s?.align === 'right'} onClick={() => run((c) => c.setTableAlign('right'))} />
      </Group>
      <Group label={t('Table')}>
        <B icon={<Ic.TableDelete />} title={t('Delete table')} danger onClick={() => run((c) => c.deleteTable())} />
      </Group>
    </div>,
    document.body,
  )
}
