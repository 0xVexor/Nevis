// The table: virtualized rows, keyboard-first cell selection and editing, TSV + typed clipboard, resizable / reorderable /
// freezable columns, grouping, sub-items, totals. Every change is a command; nothing here writes pages directly.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyEvent } from 'react'
import type { Cell, Definition, Id, Json } from '../model/types.ts'
import { DESCRIPTORS, cellToText, defaultCell, parseCellText } from '../props/registry.ts'
import { cfgOf, type RollupAggregation } from '../props/config.ts'
import { NONE_GROUP } from '../query/engine.ts'
import type { Row } from '../state.ts'
import { matchKey } from '../text.ts'
import { Popover, MenuItem, MenuSep } from '../../ui'
import { confirmDialog } from '../../dialog'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { CellView, useNav } from './CellView'
import { InlineCellEditor, PopoverEditor, isInlineKind, isPopoverKind } from './CellEditor'
import { KindIcon, errorText, plainTitle } from './common'
import { NewPropertyPopover, PropertyMenu, aggLabel } from './PropertyEditor'
import { useViewQuery } from './useViewQuery'
import type { ViewProps } from './viewTypes'
import { PageIcon } from '../../PageIcon'
import { repo } from '../../store'

const DEFAULT_W = 200
const TITLE_W = 280
const HANDLE_W = 34
const ROW_H = { compact: 36, normal: 52 }

type Item = { t: 'row'; id: Id; depth: number; context: boolean; r: number } | { t: 'group'; key: string; label: string; count: number; collapsed: boolean; memberId: Id | null }
type Sel = { r1: number; c1: number; r2: number; c2: number }
type Edit = { r: number; c: number; rect?: DOMRect; initial?: string }

const TOTAL_OPS: Record<string, RollupAggregation[]> = {
  number: ['sum', 'average', 'median', 'min', 'max', 'range', 'count_values', 'count_empty', 'count_not_empty', 'percent_empty', 'percent_not_empty'],
  checkbox: ['checked', 'unchecked', 'percent_checked', 'percent_unchecked'],
  date: ['earliest_date', 'latest_date', 'date_range', 'count_empty', 'count_not_empty'],
  any: ['count_all', 'count_values', 'count_unique', 'count_empty', 'count_not_empty', 'percent_empty', 'percent_not_empty'],
}

function tsvEscape(s: string) {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let f = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c
    } else if (c === '"' && f === '') q = true
    else if (c === '\t') (row.push(f), (f = ''))
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(f); rows.push(row); row = []; f = ''
    } else f += c
  }
  if (f !== '' || row.length) (row.push(f), rows.push(row))
  return rows
}

const CellBox = memo(function CellBox(p: { svc: ViewProps['svc']; rs: ViewProps['ctl']['rs']; row: Row; def: Definition; version: number }) {
  return <CellView svc={p.svc} rs={p.rs} row={p.row} def={p.def} />
})

export function TableView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const scroller = useRef<HTMLDivElement>(null)
  const [want, setWant] = useState(500)
  const [collapsedG, setCollapsedG] = useState<Set<string>>(new Set())
  const [collapsedR, setCollapsedR] = useState<Set<Id>>(new Set())
  const [active, setActive] = useState<{ r: number; c: number } | null>(null)
  const [sel, setSel] = useState<Sel | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<{ def: Definition; rect: DOMRect } | null>(null)
  const [newProp, setNewProp] = useState<DOMRect | null>(null)
  const [rowMenu, setRowMenu] = useState<{ id: Id; rect: DOMRect } | null>(null)
  const [totalMenu, setTotalMenu] = useState<{ def: Definition; rect: DOMRect } | null>(null)
  const [resizing, setResizing] = useState<Record<Id, number>>({})
  const [pinned, setPinned] = useState<Id | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const [dragRow, setDragRow] = useState<Id | null>(null)
  const [dragCol, setDragCol] = useState<Id | null>(null)
  const dragColRef = useRef<Id | null>(null) // read by the drag handlers synchronously: state lags behind the first dragover
  const [dropAt, setDropAt] = useState<{ id: Id; after: boolean } | null>(null)
  const [checked, setChecked] = useState<Set<Id>>(new Set())
  const mouseDown = useRef(false)

  // columns --------------------------------------------------------------------------------------------------------------
  const allProps = svc.state.props(view.sourceId!)
  const visibleIds = (cfg.visibleProperties as Id[] | undefined) ?? allProps.map((p) => p.id)
  const cols: Definition[] = useMemo(() => {
    const byId = new Map(allProps.map((p) => [p.id, p]))
    const list = visibleIds.map((id) => byId.get(id)).filter((d): d is Definition => !!d && svc.access().canReadProperty(svc.principalId, d))
    const title = allProps.find((p) => p.kind === 'title')!
    return list.some((d) => d.kind === 'title') ? list : [title, ...list]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc, view, svc.getVersion()])
  const widths = (cfg.widths as Record<Id, number> | undefined) ?? {}
  const wOf = (d: Definition) => resizing[d.id] ?? widths[d.id] ?? (d.kind === 'title' ? TITLE_W : DEFAULT_W)
  const frozenId = cfg.frozenThrough as Id | null | undefined
  const frozenIdx = frozenId ? cols.findIndex((c) => c.id === frozenId) : -1
  const offsets = useMemo(() => {
    let x = HANDLE_W
    return cols.map((d) => { const o = x; x += wOf(d); return o })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, widths, resizing])
  const gridCols = `${HANDLE_W}px ${cols.map((d) => wOf(d) + 'px').join(' ')} 44px`

  // data -----------------------------------------------------------------------------------------------------------------
  const group = (cfg.group as { propertyId: Id; mode?: string } | null | undefined) ?? null
  const totals = (cfg.totals as Record<Id, RollupAggregation> | undefined) ?? {}
  const subItemsOn = (svc.state.get('source', view.sourceId!)?.settings as { subItems?: boolean } | undefined)?.subItems !== false && svc.state.snapshot().childrenOf.size > 0
  const nested = subItemsOn && cfg.subItems === 'nested'
  const qopts = useMemo(() => ({
    search: ctl.search, personal: ctl.personal, want, group: group as never, totals, subItems: nested ? ({ mode: 'nested', include: 'all' } as const) : cfg.subItems === 'parents' ? ({ mode: 'flat', include: 'parents' } as const) : cfg.subItems === 'children' ? ({ mode: 'flat', include: 'children' } as const) : undefined,
  }), [ctl.search, ctl.personal, want, group?.propertyId, group?.mode, JSON.stringify(totals), nested, cfg.subItems]) // eslint-disable-line react-hooks/exhaustive-deps
  const q = useViewQuery(svc, view, qopts)
  const rs = ctl.rs
  const hasSorts = q.sorts.length > 0
  const density = (cfg.density as string) ?? 'compact'
  const wrap = !!cfg.wrap || density === 'relaxed'
  const rowH = density === 'normal' ? ROW_H.normal : ROW_H.compact

  const items: Item[] = useMemo(() => {
    const out: Item[] = []
    let r = 0
    const byId = new Map(q.rows.map((x) => [x.pageId, x]))
    const pushRows = (ids: Id[]) => {
      let hiddenDepth = Infinity
      for (const id of ids) {
        const qr = byId.get(id)
        if (!qr) continue
        const depth = qr.depth ?? 0
        if (depth > hiddenDepth) continue
        hiddenDepth = collapsedR.has(id) ? depth : Infinity
        out.push({ t: 'row', id, depth, context: !!qr.context, r: r++ })
      }
    }
    if (q.groups.length) {
      for (const g of q.groups) {
        const collapsed = collapsedG.has(g.key)
        out.push({ t: 'group', key: g.key, label: g.key === NONE_GROUP ? t('No value') : g.label, count: g.count, collapsed, memberId: g.memberId })
        if (!collapsed) pushRows(g.pageIds)
      }
    } else pushRows(q.rows.map((x) => x.pageId))
    // an edited / new row stays visible until its editor closes, even if the filter no longer matches it
    if (pinned && !out.some((i) => i.t === 'row' && i.id === pinned) && svc.state.row(pinned)) out.push({ t: 'row', id: pinned, depth: 0, context: false, r: r++ })
    return out
  }, [q.rows, q.groups, collapsedG, collapsedR, pinned, svc]) // eslint-disable-line react-hooks/exhaustive-deps
  const rowItems = items.filter((i): i is Extract<Item, { t: 'row' }> => i.t === 'row')
  const rowCount = rowItems.length

  // virtualization (fixed row height, no grouping / wrapping) ---------------------------------------------------------------
  const virtual = !wrap && !q.groups.length && rowCount > 150
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowH) - 8) : 0
  const end = virtual ? Math.min(items.length, Math.ceil((scrollTop + viewH) / rowH) + 8) : items.length
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    setViewH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const onScroll = useCallback(() => {
    const el = scroller.current!
    setScrollTop(el.scrollTop)
    if (q.hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - 400) setWant((w) => w + 500)
  }, [q.hasMore])

  // helpers ---------------------------------------------------------------------------------------------------------------
  const rowAt = (r: number): Row | undefined => {
    const it = rowItems[r]
    return it ? svc.state.row(it.id) : undefined
  }
  const cellEl = (r: number, c: number) => scroller.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`) ?? null
  const rtl = () => (scroller.current ? getComputedStyle(scroller.current).direction === 'rtl' : false)
  const focusGrid = () => scroller.current?.focus({ preventScroll: true })
  const reveal = (r: number) => {
    const el = scroller.current
    if (!el) return
    const top = r * rowH
    if (virtual) {
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + rowH > el.scrollTop + el.clientHeight - 48) el.scrollTop = top + rowH - el.clientHeight + 48
    } else cellEl(r, 0)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  const moveTo = (r: number, c: number, extend = false) => {
    const rr = Math.max(0, Math.min(rowCount - 1, r))
    const cc = Math.max(0, Math.min(cols.length - 1, c))
    setActive({ r: rr, c: cc })
    setSel((s) => (extend && s ? { ...s, r2: rr, c2: cc } : { r1: rr, c1: cc, r2: rr, c2: cc }))
    reveal(rr)
  }
  const sorted = (s: Sel) => ({ r1: Math.min(s.r1, s.r2), r2: Math.max(s.r1, s.r2), c1: Math.min(s.c1, s.c2), c2: Math.max(s.c1, s.c2) })
  const selected = sel ? sorted(sel) : null

  // editing ---------------------------------------------------------------------------------------------------------------
  const closeEdit = () => {
    const id = edit ? rowItems[edit.r]?.id : null
    setEdit(null)
    if (id && pinned === id) {
      window.setTimeout(() => {
        setPinned(null)
        if (!svc.query(view.sourceId!, { filter: q.filter, sorts: q.sorts, search: ctl.search, limit: 500 }).matchIds.includes(id) && svc.state.row(id))
          ctl.notice(t('Saved; this item is outside the current view.'), { label: t('Clear filters'), run: () => ctl.setPersonal({ filter: null, sorts: null }) })
      }, 0)
    }
    focusGrid()
  }
  const begin = (r: number, c: number, initial?: string) => {
    const row = rowAt(r)
    const def = cols[c]
    if (!row || !def) return
    if (!ctl.canEditRows && def.kind !== 'button') return ctl.notice(t('You can view this database but not edit it.'))
    const el = cellEl(r, c)
    const rect = el?.getBoundingClientRect()
    if (def.kind === 'checkbox') {
      const cur = row.ext.cells[def.id]?.value
      void svc.tryExec([{ type: 'row.patch', payload: { pageId: row.page.id, cellChanges: { [def.id]: { kind: 'checkbox', value: !(cur?.kind === 'checkbox' && cur.value) } } } }]).then((r2) => !r2.ok && ctl.notice(errorText(r2.code, r2.message)))
      return
    }
    if (def.kind === 'button') return nav.runButton(row, def)
    if (!DESCRIPTORS[def.kind].writable) return ctl.notice(readOnlyWhy(def))
    setPinned(row.page.id)
    setEdit({ r, c, rect, initial })
  }
  const readOnlyWhy = (d: Definition) => d.kind === 'formula' ? t('This is a formula result; change the formula instead.') : d.kind === 'rollup' ? t('This is a rollup; it follows the related items.') : d.kind === 'unique_id' ? t('IDs are assigned automatically and never change.') : t('This value is set by the system.')

  const clearSelection = async () => {
    if (!selected) return
    const patches: { pageId: Id; cellChanges: Record<Id, Json> }[] = []
    const extra: { type: string; payload: Json }[] = []
    for (let r = selected.r1; r <= selected.r2; r++) {
      const row = rowAt(r)
      if (!row) continue
      const cc: Record<Id, Json> = {}
      for (let c = selected.c1; c <= selected.c2; c++) {
        const d = cols[c]
        if (d.kind === 'relation') extra.push({ type: 'relation.replace', payload: { propertyId: d.id, fromPageId: row.page.id, orderedTargetPageIds: [] } })
        else if (DESCRIPTORS[d.kind].writable && d.kind !== 'title') cc[d.id] = null
        else if (d.kind === 'title') cc[d.id] = null
      }
      const real: Record<Id, Json> = {}
      for (const [k, v] of Object.entries(cc)) if (cols.find((x) => x.id === k)?.kind !== 'title') real[k] = v
      if (Object.keys(real).length) patches.push({ pageId: row.page.id, cellChanges: real })
    }
    const r = await svc.tryExec([...(patches.length ? [{ type: 'row.patch_bulk', payload: { patches } as Json }] : []), ...extra])
    if (!r.ok) ctl.notice(errorText(r.code, r.message))
  }

  const fillDown = async () => {
    if (!selected || selected.r2 === selected.r1) return
    const src = rowAt(selected.r1)
    if (!src) return
    const patches: { pageId: Id; cellChanges: Record<Id, Json> }[] = []
    for (let r = selected.r1 + 1; r <= selected.r2; r++) {
      const row = rowAt(r)
      if (!row) continue
      const cc: Record<Id, Json> = {}
      for (let c = selected.c1; c <= selected.c2; c++) {
        const d = cols[c]
        if (!DESCRIPTORS[d.kind].writable || d.kind === 'title') continue
        cc[d.id] = (src.ext.cells[d.id]?.value ?? null) as unknown as Json
      }
      if (Object.keys(cc).length) patches.push({ pageId: row.page.id, cellChanges: cc })
    }
    if (patches.length) {
      const r = await svc.tryExec([{ type: 'row.patch_bulk', payload: { patches } }])
      if (!r.ok) ctl.notice(errorText(r.code, r.message))
    }
  }

  // clipboard -------------------------------------------------------------------------------------------------------------
  const onCopy = (e: React.ClipboardEvent | ClipboardEvent, cut = false) => {
    if (!selected || edit) return
    const lines: string[] = []
    const typed: (Cell | null)[][] = []
    for (let r = selected.r1; r <= selected.r2; r++) {
      const row = rowAt(r)
      const cells: string[] = []
      const tcells: (Cell | null)[] = []
      for (let c = selected.c1; c <= selected.c2; c++) {
        const d = cols[c]
        let txt = ''
        if (row) {
          if (d.kind === 'title') txt = row.page.title
          else if (d.kind === 'relation') txt = rs.relationTargets(row, d).filter((x) => x.state === 'live').map((x) => rs.title(x.pageId) ?? '').join(', ')
          else if (DESCRIPTORS[d.kind].cellKind) txt = cellToText(d, row.ext.cells[d.id]?.value ?? defaultCell(d), { personName: (id) => rs.access.principal(id)?.displayName ?? id })
          else { const v = rs.value(row, d); txt = v.c === 'text' ? v.text : v.c === 'number' ? String(v.n) : v.c === 'bool' ? String(v.b) : v.c === 'date' ? v.v.start : '' }
        }
        cells.push(tsvEscape(txt))
        tcells.push(row && DESCRIPTORS[d.kind].cellKind ? (row.ext.cells[d.id]?.value ?? defaultCell(d) ?? null) : null)
      }
      lines.push(cells.join('\t'))
      typed.push(tcells)
    }
    const cd = (e as ClipboardEvent).clipboardData
    if (!cd) return
    cd.setData('text/plain', lines.join('\n'))
    cd.setData('application/x-noviq-cells', JSON.stringify({ sourceId: view.sourceId, props: cols.slice(selected.c1, selected.c2 + 1).map((d) => d.id), cells: typed }))
    e.preventDefault()
    if (cut) void clearSelection()
  }

  const onPaste = async (e: React.ClipboardEvent) => {
    if (edit || !active) return
    const cd = e.clipboardData
    const text = cd.getData('text/plain')
    if (!text && !cd.getData('application/x-noviq-cells')) return
    e.preventDefault()
    let internal: { sourceId: Id; props: Id[]; cells: (Cell | null)[][] } | null = null
    try { const raw = cd.getData('application/x-noviq-cells'); internal = raw ? JSON.parse(raw) : null } catch { internal = null }
    const grid = text ? parseTsv(text.replace(/\n$/, '')) : internal!.cells.map((r) => r.map(() => ''))
    const rowsNeeded = active.r + grid.length - rowCount
    type Plan = { pageId: Id | null; newIdx: number | null; cell: Id; value: Cell | null; rel?: Id[] }
    const problems: string[] = []
    const plans: Plan[] = []
    const newIds: Id[] = Array.from({ length: Math.max(0, rowsNeeded) }, () => crypto.randomUUID())
    grid.forEach((line, i) => {
      const rowIdx = active.r + i
      const row = rowAt(rowIdx)
      line.forEach((txt, j) => {
        const cIdx = active.c + j
        const d = cols[cIdx]
        if (!d) return
        if (d.kind === 'title') { plans.push({ pageId: row?.page.id ?? null, newIdx: row ? null : rowIdx - rowCount, cell: d.id, value: null, rel: undefined, ...{ title: txt } } as Plan); return }
        if (!DESCRIPTORS[d.kind].writable && d.kind !== 'relation') { if (txt) problems.push(`${plainTitle(row?.page.title)} · ${d.name}: ${readOnlyWhy(d)}`); return }
        try {
          if (d.kind === 'relation') {
            const rel = svc.state.relationOf(d.id)
            const target = rel ? (rel.propertyId === d.id ? rel.targetSourceId : rel.sourceId) : null
            const ids: Id[] = []
            for (const label of txt.split(',').map((s) => s.trim()).filter(Boolean)) {
              const hits = target ? svc.state.rows(target).filter((r) => matchKey(r.page.title) === matchKey(label)) : []
              if (hits.length !== 1) throw new Error(hits.length ? t('“{n}” matches several items', { n: label }) : t('“{n}” was not found', { n: label }))
              ids.push(hits[0].page.id)
            }
            plans.push({ pageId: row?.page.id ?? null, newIdx: row ? null : rowIdx - rowCount, cell: d.id, value: null, rel: ids })
            return
          }
          const ic = internal && internal.sourceId === view.sourceId ? internal.cells[i]?.[j] : undefined
          const srcDef = internal && internal.props[j] ? svc.state.prop(internal.props[j]) : undefined
          const v: Cell | null = ic !== undefined && srcDef && srcDef.id === d.id ? ic : txt.trim() === '' ? null : parseCellText(d, txt, { listDelimiter: ', ', zone: svc.zone })
          plans.push({ pageId: row?.page.id ?? null, newIdx: row ? null : rowIdx - rowCount, cell: d.id, value: v })
        } catch (err) {
          problems.push(`${plainTitle(row?.page.title)} · ${d.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    })
    if (problems.length) {
      const skip = await confirmDialog({ title: t('{n} cell(s) cannot take the pasted value', { n: problems.length }), message: problems.slice(0, 6).join('\n') + (problems.length > 6 ? '\n…' : '') + '\n\n' + t('Paste the rest and skip these?'), confirmLabel: t('Skip them and paste') })
      if (!skip) return // atomic by default: nothing is pasted
    }
    if (rowsNeeded > 0 && !(await confirmDialog({ title: t('Create {n} new row(s)?', { n: rowsNeeded }), message: t('The pasted data is longer than the table. New rows are added at the end.'), confirmLabel: t('Create rows') }))) return
    const cmds: { type: string; payload: Json }[] = []
    newIds.forEach((id) => cmds.push({ type: 'row.create', payload: { id, sourceId: view.sourceId!, viewId: view.id } }))
    const patches = new Map<Id, { pageId: Id; cellChanges: Record<Id, Json>; title?: string }>()
    const rels: { type: string; payload: Json }[] = []
    for (const p of plans) {
      const pid = p.pageId ?? newIds[p.newIdx ?? 0]
      if (!pid) continue
      const e2 = patches.get(pid) ?? patches.set(pid, { pageId: pid, cellChanges: {} }).get(pid)!
      if ('title' in p) e2.title = (p as unknown as { title: string }).title
      else if (p.rel) rels.push({ type: 'relation.replace', payload: { propertyId: p.cell, fromPageId: pid, orderedTargetPageIds: p.rel } })
      else e2.cellChanges[p.cell] = p.value as unknown as Json
    }
    if (patches.size) cmds.push({ type: 'row.patch_bulk', payload: { patches: [...patches.values()] as unknown as Json } })
    cmds.push(...rels)
    const r = await svc.tryExec(cmds) // one batch: either every cell lands or none does
    if (!r.ok) ctl.notice(errorText(r.code, r.message))
  }

  // keyboard --------------------------------------------------------------------------------------------------------------
  const onKeyDown = (e: RKeyEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return // keys typed inside an editor belong to the editor
    if (e.nativeEvent.isComposing) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); void svc.undo().then((r) => !r.ok && r.conflicts.length && ctl.notice(t('Some fields changed since; undo was not applied.'))); return }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel({ r1: 0, c1: 0, r2: rowCount - 1, c2: cols.length - 1 }); return }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); void fillDown(); return }
    if (mod || e.altKey) return
    if (!active) { if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key) && rowCount) { e.preventDefault(); moveTo(0, 0) } return }
    const { r, c } = active
    const ext = e.shiftKey
    const dx = rtl() ? -1 : 1
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveTo(r + 1, c, ext); break
      case 'ArrowUp': e.preventDefault(); moveTo(r - 1, c, ext); break
      case 'ArrowRight': e.preventDefault(); moveTo(r, c + dx, ext); break // physical direction: mirrored in RTL
      case 'ArrowLeft': e.preventDefault(); moveTo(r, c - dx, ext); break
      case 'Tab': {
        e.preventDefault()
        // logical order (not physical), wrapping to the next / previous row
        let nr = r, nc = c + (e.shiftKey ? -1 : 1)
        if (nc >= cols.length) (nc = 0, nr++)
        if (nc < 0) (nc = cols.length - 1, nr--)
        moveTo(nr, nc)
        break
      }
      case 'Enter': case 'F2': e.preventDefault(); begin(r, c); break
      case ' ': if (cols[c]?.kind === 'checkbox') { e.preventDefault(); begin(r, c) } break
      case 'Delete': case 'Backspace': e.preventDefault(); void clearSelection(); break
      case 'Escape': setSel(active ? { r1: active.r, c1: active.c, r2: active.r, c2: active.c } : null); break
      case 'Home': e.preventDefault(); moveTo(r, 0, ext); break
      case 'End': e.preventDefault(); moveTo(r, cols.length - 1, ext); break
      case 'PageDown': e.preventDefault(); moveTo(r + 10, c, ext); break
      case 'PageUp': e.preventDefault(); moveTo(r - 10, c, ext); break
      default:
        if (e.key.length === 1 && isInlineKind(cols[c]?.kind) && DESCRIPTORS[cols[c].kind].writable) { e.preventDefault(); begin(r, c, e.key) }
    }
  }

  // mouse -----------------------------------------------------------------------------------------------------------------
  useEffect(() => {
    const up = () => (mouseDown.current = false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // column resize ---------------------------------------------------------------------------------------------------------
  const startResize = (e: React.PointerEvent, d: Definition) => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const w0 = wOf(d)
    const sign = rtl() ? -1 : 1
    const move = (ev: PointerEvent) => setResizing((r) => ({ ...r, [d.id]: Math.max(80, Math.min(1200, w0 + (ev.clientX - x0) * sign)) }))
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const w = Math.max(80, Math.min(1200, w0 + (ev.clientX - x0) * sign))
      setResizing((r) => { const n = { ...r }; delete n[d.id]; return n })
      if (ctl.canSchema && w !== w0) void ctl.patch({ widths: { ...widths, [d.id]: Math.round(w) } })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const endColDrag = () => (dragColRef.current = null, setDragCol(null), setDropAt(null))
  /** Dragging forward drops after the target, backward before it, so a column can move one place in either direction. */
  const dropsAfter = (target: Definition) => {
    const from = cols.findIndex((c) => c.id === dragColRef.current)
    return from >= 0 && from < cols.findIndex((c) => c.id === target.id)
  }
  const dropColumn = (target: Definition) => {
    const drag = dragColRef.current
    const after = dropsAfter(target)
    endColDrag()
    if (!drag || drag === target.id || !ctl.canSchema) return
    const ids = cols.map((c) => c.id).filter((id) => id !== drag)
    ids.splice(ids.indexOf(target.id) + (after ? 1 : 0), 0, drag)
    // the title stays the first column
    const tid = cols.find((c) => c.kind === 'title')!.id
    void ctl.patch({ visibleProperties: [tid, ...ids.filter((i) => i !== tid)] })
  }

  // rows ------------------------------------------------------------------------------------------------------------------
  const dropRow = (beforeId: Id | null) => {
    if (!dragRow || dragRow === beforeId) return
    void svc.tryExec([{ type: 'row.reorder', payload: { pageId: dragRow, beforePageId: beforeId } }]).then((r) => !r.ok && ctl.notice(errorText(r.code, r.message)))
    setDragRow(null)
  }
  const [justCreated, setJustCreated] = useState<Id | null>(null)
  const addRow = async (context?: { propertyId: Id; cell: Cell }[]) => {
    const res = await ctl.createRow({ context, edit: true })
    if (res) { setPinned(res.pageId); setJustCreated(res.pageId) }
  }
  useEffect(() => {
    if (!justCreated) return
    const i = rowItems.findIndex((x) => x.id === justCreated)
    if (i < 0) return
    setJustCreated(null)
    moveTo(i, 0)
    begin(i, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justCreated, rowItems.length])

  const bulkTrash = async () => {
    const ids = [...checked]
    if (!ids.length || !(await confirmDialog({ title: t('Move {n} item(s) to the trash?', { n: ids.length }), danger: true, confirmLabel: t('Move to trash') }))) return
    const r = await svc.tryExec([{ type: 'row.trash', payload: { pageIds: ids } }])
    if (r.ok) setChecked(new Set())
    else ctl.notice(errorText(r.code, r.message))
  }
  const bulkDuplicate = async () => {
    const r = await svc.tryExec([{ type: 'row.duplicate', payload: { rootPageIds: [...checked] } }])
    if (r.ok) setChecked(new Set())
    else ctl.notice(errorText(r.code, r.message))
  }

  // render ----------------------------------------------------------------------------------------------------------------
  if (q.error) return <div className="db-error-box" role="alert"><b>{t('This view cannot be shown')}</b><p>{errorText(q.error.code, q.error.message)}</p><button type="button" className="primary" onClick={() => ctl.setPersonal({ filter: null, sorts: null })}>{t('Reset filters and sorts')}</button></div>
  const version = svc.getVersion()
  const firstVisible = items.slice(start, end)
  const totalW = HANDLE_W + cols.reduce((n, d) => n + wOf(d), 0) + 44
  const filtered = !!(q.filter || ctl.search)
  const colCount = cols.length

  return (
    <div className="db-table-wrap">
      {checked.size > 0 && (
        <div className="db-bulk" role="toolbar" aria-label={t('Selected items')}>
          <b>{t('{n} selected', { n: checked.size })}</b>
          <button type="button" onClick={() => void bulkDuplicate()}><Ic.Copy size={13} /> {t('Duplicate')}</button>
          <button type="button" className="danger" onClick={() => void bulkTrash()}><Ic.Trash size={13} /> {t('Delete')}</button>
          <button type="button" onClick={() => setChecked(new Set())}>{t('Clear selection')}</button>
        </div>
      )}
      <div
        ref={scroller}
        className="db-table"
        role="grid"
        aria-rowcount={rowCount + 1}
        aria-colcount={colCount}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onCopy={(e) => onCopy(e)}
        onCut={(e) => onCopy(e, true)}
        onPaste={(e) => void onPaste(e)}
        data-density={density}
      >
        <div className="db-thead" role="row" style={{ gridTemplateColumns: gridCols, minWidth: totalW }}>
          <div className="db-th handle" />
          {cols.map((d, ci) => (
            <div
              key={d.id}
              role="columnheader"
              className={'db-th' + (ci <= frozenIdx ? ' frozen' : '') + (dragCol === d.id ? ' dragging' : '') + (dropAt?.id === d.id ? (dropAt.after ? ' drop-after' : ' drop-before') : '')}
              style={ci <= frozenIdx ? { insetInlineStart: offsets[ci] } : undefined}
              draggable={ctl.canSchema && d.kind !== 'title'}
              onDragStart={(e) => {
                dragColRef.current = d.id
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('application/x-noviq-column', d.id)
                e.dataTransfer.setData('text/plain', d.name)
                window.setTimeout(() => dragColRef.current === d.id && setDragCol(d.id), 0) // after the browser took its drag image
              }}
              onDragOver={(e) => {
                if (!dragColRef.current) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const after = dropsAfter(d)
                if (dragColRef.current !== d.id) setDropAt((cur) => (cur?.id === d.id && cur.after === after ? cur : { id: d.id, after }))
              }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropAt((cur) => (cur?.id === d.id ? null : cur))}
              onDrop={(e) => (e.preventDefault(), dropColumn(d))}
              onDragEnd={endColDrag}
              onClick={(e) => setMenu({ def: d, rect: e.currentTarget.getBoundingClientRect() })}
            >
              <KindIcon kind={d.kind} />
              <span className="db-th-name" dir="auto">{d.name}</span>
              {q.sorts.some((s) => s.propertyId === d.id) && <span className="db-th-sort">{q.sorts.find((s) => s.propertyId === d.id)!.direction === 'asc' ? '↑' : '↓'}</span>}
              <span className="db-resize" onPointerDown={(e) => startResize(e, d)} onClick={(e) => e.stopPropagation()} />
            </div>
          ))}
          <div className="db-th add">
            {ctl.canSchema && <button type="button" className="icon-btn" aria-label={t('Add a property')} onClick={(e) => setNewProp(e.currentTarget.getBoundingClientRect())}><Ic.Plus size={14} /></button>}
          </div>
        </div>
        <div className="db-tbody" role="rowgroup" style={{ minWidth: totalW }}>
          {virtual && start > 0 && <div style={{ height: start * rowH }} aria-hidden />}
          {firstVisible.map((it) => {
            if (it.t === 'group') {
              return (
                <div key={'g' + it.key} className="db-group-row" role="row" style={{ minWidth: totalW }}>
                  <button type="button" className="db-group-t" aria-expanded={!it.collapsed} onClick={() => setCollapsedG((s) => { const n = new Set(s); n.has(it.key) ? n.delete(it.key) : n.add(it.key); return n })}>
                    <span className={'db-caret' + (it.collapsed ? '' : ' open')}><Ic.Chevron size={12} /></span> <b dir="auto">{it.label}</b> <span className="db-count">{it.count}</span>
                  </button>
                  {ctl.canEditRows && group && (
                    <button type="button" className="icon-btn" aria-label={t('New item in this group')} onClick={() => void addRow(groupContext(svc, group, it.key, it.memberId))}><Ic.Plus size={13} /></button>
                  )}
                </div>
              )
            }
            const row = svc.state.row(it.id)
            if (!row) return null
            const isActiveRow = active?.r === it.r
            return (
              <div
                key={it.id}
                role="row"
                aria-rowindex={it.r + 2}
                className={'db-row' + (it.context ? ' context' : '') + (checked.has(it.id) ? ' checked' : '') + (dragRow === it.id ? ' dragging' : '') + (row.page.deletedAt ? ' trashed' : '')}
                style={{ gridTemplateColumns: gridCols, minWidth: totalW, height: wrap ? undefined : rowH }}
                data-id={it.id}
                onDragOver={(e) => dragRow && e.preventDefault()}
                onDrop={() => dropRow(it.id)}
              >
                <div className="db-td handle" role="rowheader">
                  <input type="checkbox" aria-label={t('Select item')} checked={checked.has(it.id)} onChange={(e) => setChecked((s) => { const n = new Set(s); e.target.checked ? n.add(it.id) : n.delete(it.id); return n })} />
                  <span
                    className={'db-grip' + (hasSorts || q.groups.length ? ' off' : '')}
                    draggable={!hasSorts && !q.groups.length && ctl.canEditRows}
                    title={hasSorts ? t('Remove the sort to reorder rows by hand') : t('Drag to reorder')}
                    onDragStart={() => !hasSorts && setDragRow(it.id)}
                    onDragEnd={() => setDragRow(null)}
                    onContextMenu={(e) => { e.preventDefault(); setRowMenu({ id: it.id, rect: e.currentTarget.getBoundingClientRect() }) }}
                    onClick={(e) => setRowMenu({ id: it.id, rect: e.currentTarget.getBoundingClientRect() })}
                  >⋮⋮</span>
                </div>
                {cols.map((d, ci) => {
                  const isActive = isActiveRow && active?.c === ci
                  const inSel = selected && it.r >= selected.r1 && it.r <= selected.r2 && ci >= selected.c1 && ci <= selected.c2
                  const editing = edit && edit.r === it.r && edit.c === ci
                  return (
                    <div
                      key={d.id}
                      role="gridcell"
                      aria-colindex={ci + 1}
                      aria-selected={!!inSel}
                      data-r={it.r}
                      data-c={ci}
                      className={'db-td' + (ci <= frozenIdx ? ' frozen' : '') + (isActive ? ' active' : '') + (inSel && !isActive ? ' sel' : '') + (d.kind === 'title' ? ' title' : '') + (wrap ? ' wrap' : '') + (!DESCRIPTORS[d.kind].writable && d.kind !== 'title' ? ' ro' : '')}
                      style={ci <= frozenIdx ? { insetInlineStart: offsets[ci] } : undefined}
                      onMouseDown={(e) => {
                        if ((e.target as HTMLElement).closest('button, a, input, .db-chip.db-rel')) return
                        mouseDown.current = true
                        moveTo(it.r, ci, e.shiftKey)
                        focusGrid()
                      }}
                      onMouseEnter={() => mouseDown.current && setSel((s) => (s ? { ...s, r2: it.r, c2: ci } : s))}
                      onDoubleClick={() => begin(it.r, ci)}
                      onClick={() => active?.r === it.r && active?.c === ci && d.kind !== 'title' && !editing && isPopoverKind(d.kind) && begin(it.r, ci)}
                    >
                      {d.kind === 'title' && (
                        <span className="db-title-pre" style={{ paddingInlineStart: it.depth * 18 }}>
                          {nested && (svc.state.snapshot().childrenOf.get(it.id)?.length ?? 0) > 0 ? (
                            <button type="button" className={'db-caret' + (collapsedR.has(it.id) ? '' : ' open')} aria-label={t('Show / hide sub-items')} onClick={(e) => { e.stopPropagation(); setCollapsedR((s) => { const n = new Set(s); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n }) }}><Ic.Chevron size={12} /></button>
                          ) : nested ? <span className="db-caret sp" /> : null}
                          <PageIcon page={repo.getRaw(it.id) ?? { id: it.id, icon: undefined, kind: undefined }} />
                        </span>
                      )}
                      {editing && isInlineKind(d.kind) ? (
                        <InlineCellEditor svc={svc} row={row} def={d} initial={edit!.initial} onClose={closeEdit} onNavigate={(dir) => (dir === 'down' ? moveTo(it.r + 1, ci) : dir === 'next' ? moveTo(it.r, ci + 1) : moveTo(it.r, ci - 1))} />
                      ) : (
                        <div className="db-cell-in"><CellBox svc={svc} rs={rs} row={row} def={d} version={version} /></div>
                      )}
                      {d.kind === 'title' && !editing && (
                        <button type="button" className="db-open" aria-label={t('Open')} title={t('Open')} onClick={(e) => { e.stopPropagation(); nav.openRow(it.id, cfg.openMode === 'full_page' ? 'full' : cfg.openMode === 'center_peek' ? 'center' : 'side') }}><Ic.Open size={13} /> {t('Open')}</button>
                      )}
                      {editing && isPopoverKind(d.kind) && edit?.rect && <PopoverEditor svc={svc} row={row} def={d} anchor={edit.rect} onClose={closeEdit} />}
                    </div>
                  )
                })}
                <div className="db-td add" />
              </div>
            )
          })}
          {virtual && end < items.length && <div style={{ height: (items.length - end) * rowH }} aria-hidden />}
          {rowCount === 0 && (
            <div className="db-empty">
              {filtered ? (
                <>
                  <b>{t('No items match')}</b>
                  <p>{t('The database is not empty: your filters or search hide everything.')}</p>
                  <button type="button" onClick={() => { ctl.setPersonal({ filter: null, sorts: q.sorts }); void ctl.patch({}) }}>{t('Clear filters')}</button>
                </>
              ) : (
                <>
                  <b>{t('Nothing here yet')}</b>
                  <p>{t('Add the first item, import a CSV file, or link another database.')}</p>
                  {ctl.canEditRows && <button type="button" className="primary" onClick={() => void addRow()}><Ic.Plus size={13} /> {t('New item')}</button>}
                </>
              )}
            </div>
          )}
          {q.hasMore && <button type="button" className="db-more" onClick={() => setWant((w) => w + 500)}>{t('Load more ({n} of {m})', { n: rowCount, m: q.total })}</button>}
        </div>
        {ctl.canEditRows && rowCount > 0 && (
          <div className="db-newrow" style={{ minWidth: totalW }}>
            <button type="button" onClick={() => void addRow()}><Ic.Plus size={13} /> {t('New item')}</button>
          </div>
        )}
        <div className="db-tfoot" role="row" style={{ gridTemplateColumns: gridCols, minWidth: totalW }}>
          <div className="db-tf handle" />
          {cols.map((d, ci) => {
            const op = totals[d.id]
            const res = (q.totals as Record<string, unknown> | null)?.[d.id] as { value: { c: string; n?: number; v?: { start: string; end: string | null } } } | undefined
            return (
              <button type="button" key={d.id} className={'db-tf' + (ci <= frozenIdx ? ' frozen' : '')} style={ci <= frozenIdx ? { insetInlineStart: offsets[ci] } : undefined} onClick={(e) => setTotalMenu({ def: d, rect: e.currentTarget.getBoundingClientRect() })}>
                {op ? (
                  <><small>{aggLabel(op)}</small> <b dir="ltr">{res?.value.c === 'number' ? Number((res.value.n ?? 0).toFixed(4)) : res?.value.c === 'date' ? res.value.v?.start : ''}</b></>
                ) : ci === 0 ? <small>{t('{n} items', { n: q.total })}</small> : <small className="calc">{t('Calculate')}</small>}
              </button>
            )
          })}
        </div>
      </div>
      {menu && (
        <PropertyMenu
          svc={svc}
          def={menu.def}
          anchor={menu.rect}
          onClose={() => setMenu(null)}
          actions={{
            sort: (dir) => ctl.setPersonal({ ...(ctl.personal ?? {}), sorts: [{ propertyId: menu.def.id, direction: dir }] }),
            filter: () => ctl.openFilterFor(menu.def.id),
            freeze: () => void ctl.patch({ frozenThrough: frozenId === menu.def.id ? null : menu.def.id }),
            hide: () => void ctl.patch({ visibleProperties: cols.map((c) => c.id).filter((id) => id !== menu.def.id) }),
          }}
          onEditActions={(d) => window.dispatchEvent(new CustomEvent('db-edit-actions', { detail: d.id }))}
        />
      )}
      {newProp && <NewPropertyPopover svc={svc} sourceId={view.sourceId!} anchor={newProp} onClose={() => setNewProp(null)} onCreated={(id) => void ctl.patch({ visibleProperties: [...cols.map((c) => c.id), id] })} />}
      {rowMenu && (
        <Popover anchor={rowMenu.rect} onClose={() => setRowMenu(null)}>
          <div className="menu">
            <MenuItem icon={<Ic.Open size={14} />} label={t('Open')} onClick={() => (nav.openRow(rowMenu.id, 'full'), setRowMenu(null))} />
            <MenuItem icon={<Ic.Panel size={14} />} label={t('Open in side peek')} onClick={() => (nav.openRow(rowMenu.id, 'side'), setRowMenu(null))} />
            <MenuItem icon={<Ic.Copy size={14} />} label={t('Duplicate')} onClick={async () => { setRowMenu(null); const r = await svc.tryExec([{ type: 'row.duplicate', payload: { rootPageIds: [rowMenu.id] } }]); if (!r.ok) ctl.notice(errorText(r.code, r.message)) }} />
            <MenuSep />
            <MenuItem icon={<Ic.Trash size={14} />} label={t('Delete')} danger onClick={async () => { setRowMenu(null); const r = await svc.tryExec([{ type: 'row.trash', payload: { pageIds: [rowMenu.id] } }]); if (r.ok) ctl.notice(t('Moved to trash'), { label: t('Undo'), run: () => void svc.undo() }); else ctl.notice(errorText(r.code, r.message)) }} />
          </div>
        </Popover>
      )}
      {totalMenu && (
        <Popover anchor={totalMenu.rect} onClose={() => setTotalMenu(null)}>
          <div className="menu">
            <MenuItem label={t('None')} onClick={() => { const n = { ...totals }; delete n[totalMenu.def.id]; void ctl.patch({ totals: n as never }); setTotalMenu(null) }} />
            {totalOps(totalMenu.def).map((op) => (
              <MenuItem key={op} label={aggLabel(op)} onClick={() => { void ctl.patch({ totals: { ...totals, [totalMenu.def.id]: op } as never }); setTotalMenu(null) }} />
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}

function totalOps(d: Definition): RollupAggregation[] {
  if (d.kind === 'number' || (d.kind === 'formula' && cfgOf.formula(d).resultType === 'number') || d.kind === 'rollup') return [...TOTAL_OPS.any.slice(0, 1), ...TOTAL_OPS.number, 'count_all']
  if (d.kind === 'checkbox') return TOTAL_OPS.checkbox
  if (d.kind === 'date' || d.kind === 'created_time' || d.kind === 'last_edited_time') return TOTAL_OPS.date
  return TOTAL_OPS.any
}

/** Creating inside a group sets that group's value (location beats template and inference). */
function groupContext(svc: ViewProps['svc'], group: { propertyId: Id; mode?: string }, key: string, memberId: Id | null): { propertyId: Id; cell: Cell }[] {
  const def = svc.state.prop(group.propertyId)
  if (!def || key === NONE_GROUP) return []
  switch (def.kind) {
    case 'select': return [{ propertyId: def.id, cell: { kind: 'select', optionId: key } }]
    case 'status': return group.mode === 'status_group' ? [] : [{ propertyId: def.id, cell: { kind: 'status', optionId: key } }]
    case 'multi_select': return [{ propertyId: def.id, cell: { kind: 'multi_select', optionIds: [key] } }]
    case 'people': return [{ propertyId: def.id, cell: { kind: 'people', principalIds: [key] } }]
    case 'checkbox': return [{ propertyId: def.id, cell: { kind: 'checkbox', value: key === 'true' } }]
    default: void memberId; return []
  }
}
