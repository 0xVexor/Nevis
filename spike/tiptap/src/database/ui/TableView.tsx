import { commandMatches } from '../../shortcutCommands'
// The table: virtualized rows, keyboard-first cell selection and editing, TSV + typed clipboard, resizable / reorderable /
// freezable columns, grouping, sub-items, totals. Every change is a command; nothing here writes pages directly.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyEvent } from 'react'
import type { Cell, Definition, Id, Json } from '../model/types.ts'
import { DESCRIPTORS, cellToText, defaultCell, parseCellText } from '../props/registry.ts'
import { cfgOf, type RollupAggregation } from '../props/config.ts'
import { NONE_GROUP } from '../query/engine.ts'
import type { Row } from '../state.ts'
import { matchKey } from '../text.ts'
import { Button, Checkbox, Icon, IconButton, useMenu, type MenuItem } from '../../design-system'
import { confirmDialog } from '../../dialog'
import { showToast } from '../../ui'
import { t } from '../../i18n'
import { CellView, useNav } from './CellView'
import { InlineCellEditor, PopoverEditor, isInlineKind, isPopoverKind } from './CellEditor'
import { KindIcon, ViewMessage, errorText, plainTitle } from './common'
import { NewPropertyPopover, PropertyMenu, aggKey, aggLabel } from './PropertyEditor'
import { useViewQuery } from './useViewQuery'
import type { ViewProps } from './viewTypes'
import { PageIcon } from '../../PageIcon'
import { repo } from '../../store'
import { HorizontalScroll } from '../../HorizontalScroll'

const DEFAULT_W = 200
const TITLE_W = 280
const HANDLE_W = 56
const ADD_W = 48
const ROW_H = { compact: 40, normal: 52 }
const HEAD_H = 40

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
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"'
          i++
        } else q = false
      } else f += c
    } else if (c === '"' && f === '') q = true
    else if (c === '\t') (row.push(f), (f = ''))
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(f)
      rows.push(row)
      row = []
      f = ''
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
  const [colMenu, setColMenu] = useState<{ def: Definition; rect: DOMRect } | null>(null)
  const [newProp, setNewProp] = useState<DOMRect | null>(null)
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
  const { open: openMenu, menu } = useMenu()

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
    return cols.map((d) => {
      const o = x
      x += wOf(d)
      return o
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, widths, resizing])
  const gridCols = `${HANDLE_W}px ${cols.map((d) => wOf(d) + 'px').join(' ')} ${ADD_W}px`

  // data -----------------------------------------------------------------------------------------------------------------
  const group = (cfg.group as { propertyId: Id; mode?: string } | null | undefined) ?? null
  const totals = (cfg.totals as Record<Id, RollupAggregation> | undefined) ?? {}
  const subItemsOn = (svc.state.get('source', view.sourceId!)?.settings as { subItems?: boolean } | undefined)?.subItems !== false && svc.state.snapshot().childrenOf.size > 0
  const nested = subItemsOn && cfg.subItems === 'nested'
  const qopts = useMemo(
    () => ({
      search: ctl.search,
      personal: ctl.personal,
      want,
      group: group as never,
      totals,
      subItems: nested
        ? ({ mode: 'nested', include: 'all' } as const)
        : cfg.subItems === 'parents'
          ? ({ mode: 'flat', include: 'parents' } as const)
          : cfg.subItems === 'children'
            ? ({ mode: 'flat', include: 'children' } as const)
            : undefined,
    }),
    [ctl.search, ctl.personal, want, group?.propertyId, group?.mode, JSON.stringify(totals), nested, cfg.subItems], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const q = useViewQuery(svc, view, qopts)
  const rs = ctl.rs
  const hasSorts = q.sorts.length > 0
  const density = (cfg.density as string) ?? 'compact'
  const wrap = !!cfg.wrap || density === 'relaxed'
  const rowH = density === 'normal' ? ROW_H.normal : ROW_H.compact
  const openMode = cfg.openMode === 'full_page' ? 'full' : cfg.openMode === 'center_peek' ? 'center' : 'side'

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
  const start = virtual ? Math.min(Math.max(0, items.length - 1), Math.max(0, Math.floor(scrollTop / rowH) - 8)) : 0
  const end = virtual ? Math.min(items.length, Math.ceil((scrollTop + viewH) / rowH) + 8) : items.length
  // On a full database page the table scrolls inside its own frame (see areas/databases.css); embedded in a page, a peek
  // or a widget it grows and the page scrolls. Rows are windowed against whichever of the two scrolls.
  const selfScrolls = () => {
    const el = scroller.current
    return !!el && /(auto|scroll)/.test(getComputedStyle(el).overflowY)
  }
  const hostOf = () => (selfScrolls() ? scroller.current : (scroller.current?.closest<HTMLElement>('.scroller, .dv-peek-body') ?? null))
  const tableTop = (host: HTMLElement) => (host === scroller.current ? 0 : scroller.current!.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop)
  const measure = useCallback(() => {
    const el = scroller.current
    const host = hostOf()
    if (!el || !host) return
    const top = tableTop(host)
    setScrollTop(Math.max(0, host.scrollTop - top))
    setViewH(host.clientHeight)
    const contentH = host === el ? el.scrollHeight : el.offsetHeight
    if (q.hasMore && host.scrollTop + host.clientHeight > top + contentH - 400) setWant((w) => w + 500)
  }, [q.hasMore]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const host = hostOf()
    if (!host) return
    measure()
    host.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    if (scroller.current) ro.observe(scroller.current)
    return () => (host.removeEventListener('scroll', measure), ro.disconnect())
  }, [measure, items.length])

  // helpers ---------------------------------------------------------------------------------------------------------------
  const rowAt = (r: number): Row | undefined => {
    const it = rowItems[r]
    return it ? svc.state.row(it.id) : undefined
  }
  const cellEl = (r: number, c: number) => scroller.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`) ?? null
  const rtl = () => (scroller.current ? getComputedStyle(scroller.current).direction === 'rtl' : false)
  const focusGrid = () => scroller.current?.focus({ preventScroll: true })
  const reveal = (r: number, c: number) => {
    const el = scroller.current
    if (!el) return
    const host = hostOf()
    if (virtual && host) {
      const top = tableTop(host) + HEAD_H + r * rowH
      if (top < host.scrollTop + 8) host.scrollTop = top - 8
      else if (top + rowH > host.scrollTop + host.clientHeight - 48) host.scrollTop = top + rowH - host.clientHeight + 48
    } else cellEl(r, c)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    // Virtual rows may not be mounted yet; reveal the selected column without waiting for their DOM.
    if (c > frozenIdx) {
      const x = offsets[c],
        w = wOf(cols[c]),
        left = Math.abs(el.scrollLeft)
      const frozenWidth = frozenIdx >= 0 ? offsets[frozenIdx] + wOf(cols[frozenIdx]) : 0
      const next = x < left + frozenWidth ? x - frozenWidth : x + w > left + el.clientWidth ? x + w - el.clientWidth : left
      el.scrollLeft = (rtl() ? -1 : 1) * Math.max(0, next)
    }
  }
  const moveTo = (r: number, c: number, extend = false) => {
    const rr = Math.max(0, Math.min(rowCount - 1, r))
    const cc = Math.max(0, Math.min(cols.length - 1, c))
    setActive({ r: rr, c: cc })
    setSel((s) => (extend && s ? { ...s, r2: rr, c2: cc } : { r1: rr, c1: cc, r2: rr, c2: cc }))
    reveal(rr, cc)
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
  const readOnlyWhy = (d: Definition) =>
    d.kind === 'formula'
      ? t('This is a formula result; change the formula instead.')
      : d.kind === 'rollup'
        ? t('This is a rollup; it follows the related items.')
        : d.kind === 'unique_id'
          ? t('IDs are assigned automatically and never change.')
          : t('This value is set by the system.')
  const begin = (r: number, c: number, initial?: string) => {
    const row = rowAt(r)
    const def = cols[c]
    if (!row || !def) return
    if (!ctl.canEditRows && def.kind !== 'button') return ctl.notice(t('You can view this database but not edit it.'))
    const rect = cellEl(r, c)?.getBoundingClientRect()
    if (def.kind === 'checkbox') {
      const cur = row.ext.cells[def.id]?.value
      void svc
        .tryExec([{ type: 'row.patch', payload: { pageId: row.page.id, cellChanges: { [def.id]: { kind: 'checkbox', value: !(cur?.kind === 'checkbox' && cur.value) } } } }])
        .then((r2) => !r2.ok && ctl.notice(errorText(r2.code, r2.message)))
      return
    }
    if (def.kind === 'button') return nav.runButton(row, def)
    if (!DESCRIPTORS[def.kind].writable) return ctl.notice(readOnlyWhy(def))
    setPinned(row.page.id)
    setEdit({ r, c, rect, initial })
  }

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
      }
      if (Object.keys(cc).length) patches.push({ pageId: row.page.id, cellChanges: cc })
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
          else if (d.kind === 'relation')
            txt = rs
              .relationTargets(row, d)
              .filter((x) => x.state === 'live')
              .map((x) => rs.title(x.pageId) ?? '')
              .join(', ')
          else if (DESCRIPTORS[d.kind].cellKind) txt = cellToText(d, row.ext.cells[d.id]?.value ?? defaultCell(d), { personName: (id) => rs.access.principal(id)?.displayName ?? id })
          else {
            const v = rs.value(row, d)
            txt = v.c === 'text' ? v.text : v.c === 'number' ? String(v.n) : v.c === 'bool' ? String(v.b) : v.c === 'date' ? v.v.start : ''
          }
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
    cd.setData('application/x-nevis-cells', JSON.stringify({ sourceId: view.sourceId, props: cols.slice(selected.c1, selected.c2 + 1).map((d) => d.id), cells: typed }))
    e.preventDefault()
    if (cut) void clearSelection()
  }

  const onPaste = async (e: React.ClipboardEvent) => {
    if (edit || !active) return
    const cd = e.clipboardData
    const text = cd.getData('text/plain')
    if (!text && !cd.getData('application/x-nevis-cells')) return
    e.preventDefault()
    let internal: { sourceId: Id; props: Id[]; cells: (Cell | null)[][] } | null = null
    try {
      const raw = cd.getData('application/x-nevis-cells')
      internal = raw ? JSON.parse(raw) : null
    } catch {
      internal = null
    }
    const grid = text ? parseTsv(text.replace(/\n$/, '')) : internal!.cells.map((r) => r.map(() => ''))
    const rowsNeeded = active.r + grid.length - rowCount
    type Plan = { pageId: Id | null; newIdx: number | null; cell: Id; value: Cell | null; rel?: Id[]; title?: string }
    const problems: string[] = []
    const plans: Plan[] = []
    const newIds: Id[] = Array.from({ length: Math.max(0, rowsNeeded) }, () => crypto.randomUUID())
    grid.forEach((line, i) => {
      const rowIdx = active.r + i
      const row = rowAt(rowIdx)
      line.forEach((txt, j) => {
        const d = cols[active.c + j]
        if (!d) return
        const at = { pageId: row?.page.id ?? null, newIdx: row ? null : rowIdx - rowCount, cell: d.id }
        if (d.kind === 'title') return void plans.push({ ...at, value: null, title: txt })
        if (!DESCRIPTORS[d.kind].writable && d.kind !== 'relation') {
          if (txt) problems.push(`${plainTitle(row?.page.title)} · ${d.name}: ${readOnlyWhy(d)}`)
          return
        }
        try {
          if (d.kind === 'relation') {
            const rel = svc.state.relationOf(d.id)
            const target = rel ? (rel.propertyId === d.id ? rel.targetSourceId : rel.sourceId) : null
            const ids: Id[] = []
            for (const label of txt
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)) {
              const hits = target ? svc.state.rows(target).filter((r) => matchKey(r.page.title) === matchKey(label)) : []
              if (hits.length !== 1) throw new Error(hits.length ? t('“{n}” matches several items', { n: label }) : t('“{n}” was not found', { n: label }))
              ids.push(hits[0].page.id)
            }
            return void plans.push({ ...at, value: null, rel: ids })
          }
          const ic = internal && internal.sourceId === view.sourceId ? internal.cells[i]?.[j] : undefined
          const srcDef = internal && internal.props[j] ? svc.state.prop(internal.props[j]) : undefined
          const v: Cell | null = ic !== undefined && srcDef && srcDef.id === d.id ? ic : txt.trim() === '' ? null : parseCellText(d, txt, { listDelimiter: ', ', zone: svc.zone })
          plans.push({ ...at, value: v })
        } catch (err) {
          problems.push(`${plainTitle(row?.page.title)} · ${d.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    })
    if (problems.length) {
      const skip = await confirmDialog({
        title: t('{n} cell(s) cannot take the pasted value', { n: problems.length }),
        message: problems.slice(0, 6).join('\n') + (problems.length > 6 ? '\n…' : '') + '\n\n' + t('Paste the rest and skip these?'),
        confirmLabel: t('Skip them and paste'),
      })
      if (!skip) return // atomic by default: nothing is pasted
    }
    if (
      rowsNeeded > 0 &&
      !(await confirmDialog({
        title: t('Create {n} new row(s)?', { n: rowsNeeded }),
        message: t('The pasted data is longer than the table. New rows are added at the end.'),
        confirmLabel: t('Create rows'),
      }))
    )
      return
    const cmds: { type: string; payload: Json }[] = []
    newIds.forEach((id) => cmds.push({ type: 'row.create', payload: { id, sourceId: view.sourceId!, viewId: view.id } }))
    const patches = new Map<Id, { pageId: Id; cellChanges: Record<Id, Json>; title?: string }>()
    const rels: { type: string; payload: Json }[] = []
    for (const p of plans) {
      const pid = p.pageId ?? newIds[p.newIdx ?? 0]
      if (!pid) continue
      const e2 = patches.get(pid) ?? patches.set(pid, { pageId: pid, cellChanges: {} }).get(pid)!
      if (p.title !== undefined) e2.title = p.title
      else if (p.rel) rels.push({ type: 'relation.replace', payload: { propertyId: p.cell, fromPageId: pid, orderedTargetPageIds: p.rel } })
      else e2.cellChanges[p.cell] = p.value as unknown as Json
    }
    if (patches.size) cmds.push({ type: 'row.patch_bulk', payload: { patches: [...patches.values()] as unknown as Json } })
    cmds.push(...rels)
    const r = await svc.tryExec(cmds) // one batch: either every cell lands or none does
    if (!r.ok) ctl.notice(errorText(r.code, r.message))
  }

  // keyboard (shortcuts by physical key, so they work with any keyboard language) -------------------------------------------
  const onKeyDown = (e: RKeyEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return // keys typed inside an editor belong to the editor
    if (e.nativeEvent.isComposing) return
    const mod = e.ctrlKey || e.metaKey
    if (commandMatches(e.nativeEvent, 'Undo database edit')) {
      e.preventDefault()
      void svc.undo().then((r) => !r.ok && r.conflicts.length && ctl.notice(t('Some fields changed since; undo was not applied.')))
      return
    }
    if (commandMatches(e.nativeEvent, 'Select all database cells')) {
      e.preventDefault()
      setSel({ r1: 0, c1: 0, r2: rowCount - 1, c2: cols.length - 1 })
      return
    }
    if (commandMatches(e.nativeEvent, 'Fill down')) {
      e.preventDefault()
      void fillDown()
      return
    }
    if (active && commandMatches(e.nativeEvent, 'Edit database cell')) {
      e.preventDefault()
      begin(active.r, active.c)
      return
    }
    if (active && commandMatches(e.nativeEvent, 'Clear database cells')) {
      e.preventDefault()
      void clearSelection()
      return
    }
    if (mod || e.altKey) return
    if (!active) {
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key) && rowCount) {
        e.preventDefault()
        moveTo(0, 0)
      }
      return
    }
    const { r, c } = active
    const ext = e.shiftKey
    const dx = rtl() ? -1 : 1
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveTo(r + 1, c, ext)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveTo(r - 1, c, ext)
        break
      case 'ArrowRight':
        e.preventDefault()
        moveTo(r, c + dx, ext)
        break // physical direction: mirrored in RTL
      case 'ArrowLeft':
        e.preventDefault()
        moveTo(r, c - dx, ext)
        break
      case 'Tab': {
        e.preventDefault()
        // logical order (not physical), wrapping to the next / previous row
        let nr = r,
          nc = c + (e.shiftKey ? -1 : 1)
        if (nc >= cols.length) ((nc = 0), nr++)
        if (nc < 0) ((nc = cols.length - 1), nr--)
        moveTo(nr, nc)
        break
      }
      case ' ':
        if (cols[c]?.kind === 'checkbox') {
          e.preventDefault()
          begin(r, c)
        }
        break
      case 'Escape':
        setSel({ r1: r, c1: c, r2: r, c2: c })
        break
      case 'Home':
        e.preventDefault()
        moveTo(r, 0, ext)
        break
      case 'End':
        e.preventDefault()
        moveTo(r, cols.length - 1, ext)
        break
      case 'PageDown':
        e.preventDefault()
        moveTo(r + 10, c, ext)
        break
      case 'PageUp':
        e.preventDefault()
        moveTo(r - 10, c, ext)
        break
      default:
        if (e.key.length === 1 && isInlineKind(cols[c]?.kind) && DESCRIPTORS[cols[c].kind].writable) {
          e.preventDefault()
          begin(r, c, e.key)
        }
    }
  }

  useEffect(() => {
    const up = () => (mouseDown.current = false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // column resize and reorder ----------------------------------------------------------------------------------------------
  const startResize = (e: React.PointerEvent, d: Definition) => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const w0 = wOf(d)
    const sign = rtl() ? -1 : 1
    const clamp = (x: number) => Math.max(80, Math.min(1200, w0 + (x - x0) * sign))
    const move = (ev: PointerEvent) => setResizing((r) => ({ ...r, [d.id]: clamp(ev.clientX) }))
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const w = clamp(ev.clientX)
      setResizing((r) => {
        const n = { ...r }
        delete n[d.id]
        return n
      })
      if (ctl.canSchema && w !== w0) void ctl.patch({ widths: { ...widths, [d.id]: Math.round(w) } })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const endColDrag = () => ((dragColRef.current = null), setDragCol(null), setDropAt(null))
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
    const tid = cols.find((c) => c.kind === 'title')!.id // the title stays the first column
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
    if (res) {
      setPinned(res.pageId)
      setJustCreated(res.pageId)
    }
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

  const trash = async (ids: Id[]) => {
    const r = await svc.tryExec([{ type: 'row.trash', payload: { pageIds: ids } }])
    if (r.ok) showToast(ids.length === 1 ? t('Moved to trash') : t('{n} items moved to trash', { n: ids.length }), () => void svc.undo())
    else ctl.notice(errorText(r.code, r.message))
    return r.ok
  }
  const duplicate = async (ids: Id[]) => {
    const r = await svc.tryExec([{ type: 'row.duplicate', payload: { rootPageIds: ids } }])
    if (r.ok) showToast(ids.length === 1 ? t('Duplicated') : t('{n} items duplicated', { n: ids.length }), () => void svc.undo())
    else ctl.notice(errorText(r.code, r.message))
    return r.ok
  }
  const rowItemsMenu = (id: Id): MenuItem[] => [
    { label: 'Open', icon: <Icon name="maximize" size={16} />, onSelect: () => nav.openRow(id, 'full') },
    { label: 'Open in side peek', icon: <Icon name="panel-right" size={16} />, onSelect: () => nav.openRow(id, 'side') },
    { label: 'Open in the center', icon: <Icon name="minimize" size={16} />, onSelect: () => nav.openRow(id, 'center') },
    { kind: 'sep' },
    { label: 'Duplicate', icon: <Icon name="copy" size={16} />, disabled: !ctl.canEditRows, onSelect: () => void duplicate([id]) },
    { kind: 'sep' },
    { label: 'Delete', icon: <Icon name="trash" size={16} />, danger: true, disabled: !ctl.canEditRows, onSelect: () => void trash([id]) },
  ]
  const totalItems = (d: Definition): MenuItem[] => [
    {
      label: 'None',
      checked: !totals[d.id],
      onSelect: () => {
        const n = { ...totals }
        delete n[d.id]
        void ctl.patch({ totals: n as never })
      },
    },
    { kind: 'sep' },
    ...totalOps(d).map((op): MenuItem => ({ label: aggKey(op), checked: totals[d.id] === op, onSelect: () => void ctl.patch({ totals: { ...totals, [d.id]: op } as never }) })),
  ]

  // render ----------------------------------------------------------------------------------------------------------------
  if (q.error)
    return (
      <ViewMessage
        tone="bad"
        title={t('This view cannot be shown')}
        action={
          <Button size="sm" onClick={() => ctl.setPersonal({ filter: null, sorts: null })}>
            {t('Reset filters and sorts')}
          </Button>
        }
      >
        {errorText(q.error.code, q.error.message)}
      </ViewMessage>
    )
  const version = svc.getVersion()
  const shownItems = items.slice(start, end)
  const totalW = HANDLE_W + cols.reduce((n, d) => n + wOf(d), 0) + ADD_W
  const filtered = !!(q.filter || ctl.search)
  const frozenStyle = (ci: number) => (ci <= frozenIdx ? { insetInlineStart: offsets[ci] } : undefined)
  const allChecked = rowCount > 0 && rowItems.every((r) => checked.has(r.id))

  return (
    <div className="dv-table-wrap">
      {checked.size > 0 && (
        <div className="dv-bulk" role="toolbar" aria-label={t('Selected items')}>
          <b>{t('{n} selected', { n: checked.size })}</b>
          <Button size="sm" variant="ghost" icon={<Icon name="copy" size={15} />} disabled={!ctl.canEditRows} onClick={() => void duplicate([...checked]).then((ok) => ok && setChecked(new Set()))}>
            {t('Duplicate')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="dv-danger"
            icon={<Icon name="trash" size={15} />}
            disabled={!ctl.canEditRows}
            onClick={async () => {
              const ids = [...checked]
              if (!(await confirmDialog({ title: t('Move {n} item(s) to the trash?', { n: ids.length }), danger: true, confirmLabel: t('Move to trash') }))) return
              if (await trash(ids)) setChecked(new Set())
            }}
          >
            {t('Delete')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
            {t('Clear selection')}
          </Button>
        </div>
      )}
      <HorizontalScroll
        viewportRef={scroller}
        viewportClassName="dv-table"
        label={t('Database')}
        viewportProps={{
          role: 'grid',
          'aria-rowcount': rowCount + 1,
          'aria-colcount': cols.length,
          tabIndex: 0,
          onKeyDown,
          onCopy: (e) => onCopy(e),
          onCut: (e) => onCopy(e, true),
          onPaste: (e) => void onPaste(e),
          'data-density': density,
        }}
      >
        <div className="dv-thead" role="row" style={{ gridTemplateColumns: gridCols, minWidth: totalW }}>
          <div className="dv-th dv-handle">
            {rowCount > 0 && <Checkbox label={t('Select all')} checked={allChecked} onChange={(on) => setChecked(on ? new Set(rowItems.map((r) => r.id)) : new Set())} />}
          </div>
          {cols.map((d, ci) => {
            const sort = q.sorts.find((s) => s.propertyId === d.id)
            return (
              <div
                key={d.id}
                role="columnheader"
                aria-sort={sort ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                className="dv-th"
                data-frozen={ci <= frozenIdx || undefined}
                data-dragging={dragCol === d.id || undefined}
                data-drop={dropAt?.id === d.id ? (dropAt.after ? 'after' : 'before') : undefined}
                style={frozenStyle(ci)}
                draggable={ctl.canSchema && d.kind !== 'title'}
                onDragStart={(e) => {
                  dragColRef.current = d.id
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('application/x-nevis-column', d.id)
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
              >
                <button type="button" className="dv-th-btn" onClick={(e) => setColMenu({ def: d, rect: e.currentTarget.getBoundingClientRect() })}>
                  <KindIcon kind={d.kind} />
                  <span className="dv-th-name" dir="auto">
                    {d.name}
                  </span>
                  {sort && <Icon name={sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} className="dv-th-sort" />}
                </button>
                <span className="dv-resize" aria-hidden onPointerDown={(e) => startResize(e, d)} onClick={(e) => e.stopPropagation()} />
              </div>
            )
          })}
          <div className="dv-th dv-add">
            {ctl.canSchema && (
              <IconButton label={t('Add a property')} onClick={(e) => setNewProp(e.currentTarget.getBoundingClientRect())}>
                <Icon name="plus" size={16} />
              </IconButton>
            )}
          </div>
        </div>
        <div className="dv-tbody" role="rowgroup" style={{ minWidth: totalW }}>
          {virtual && start > 0 && <div style={{ height: start * rowH }} aria-hidden />}
          {shownItems.map((it) => {
            if (it.t === 'group') {
              return (
                <div key={'g' + it.key} className="dv-group-row" role="row" style={{ minWidth: totalW }}>
                  <button
                    type="button"
                    className="dv-group-toggle"
                    aria-expanded={!it.collapsed}
                    onClick={() =>
                      setCollapsedG((s) => {
                        const n = new Set(s)
                        n.has(it.key) ? n.delete(it.key) : n.add(it.key)
                        return n
                      })
                    }
                  >
                    <Icon name="chevron-down" size={15} className="dv-caret" />
                    <b dir="auto">{it.label}</b>
                    <span className="ds-badge">{it.count}</span>
                  </button>
                  {ctl.canEditRows && group && (
                    <IconButton label={t('New item in this group')} onClick={() => void addRow(groupContext(svc, group, it.key))}>
                      <Icon name="plus" size={15} />
                    </IconButton>
                  )}
                </div>
              )
            }
            const row = svc.state.row(it.id)
            if (!row) return null
            const isActiveRow = active?.r === it.r
            const hasKids = nested && (svc.state.snapshot().childrenOf.get(it.id)?.length ?? 0) > 0
            return (
              <div
                key={it.id}
                role="row"
                aria-rowindex={it.r + 2}
                className="dv-row"
                data-context={it.context || undefined}
                data-checked={checked.has(it.id) || undefined}
                data-dragging={dragRow === it.id || undefined}
                data-trashed={row.page.deletedAt ? true : undefined}
                style={{ gridTemplateColumns: gridCols, minWidth: totalW, height: wrap ? undefined : rowH }}
                data-id={it.id}
                onDragOver={(e) => dragRow && e.preventDefault()}
                onDrop={() => dropRow(it.id)}
                onContextMenu={(e) => {
                  if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return
                  e.preventDefault()
                  openMenu(rowItemsMenu(it.id), e)
                }}
              >
                <div className="dv-td dv-handle" role="rowheader">
                  <button
                    type="button"
                    className="dv-grip"
                    draggable={!hasSorts && !q.groups.length && ctl.canEditRows}
                    aria-label={t('Item actions')}
                    title={hasSorts || q.groups.length ? t('Remove the sort to reorder rows by hand') : t('Drag to reorder, click for actions')}
                    onDragStart={() => !hasSorts && setDragRow(it.id)}
                    onDragEnd={() => setDragRow(null)}
                    onClick={(e) => openMenu(rowItemsMenu(it.id), e.currentTarget)}
                  >
                    <Icon name="more-vertical" size={16} />
                  </button>
                  <Checkbox
                    label={t('Select item')}
                    checked={checked.has(it.id)}
                    onChange={(on) =>
                      setChecked((s) => {
                        const n = new Set(s)
                        on ? n.add(it.id) : n.delete(it.id)
                        return n
                      })
                    }
                  />
                </div>
                {cols.map((d, ci) => {
                  const isActive = isActiveRow && active?.c === ci
                  const inSel = !!selected && it.r >= selected.r1 && it.r <= selected.r2 && ci >= selected.c1 && ci <= selected.c2
                  const editing = !!edit && edit.r === it.r && edit.c === ci
                  return (
                    <div
                      key={d.id}
                      role="gridcell"
                      aria-colindex={ci + 1}
                      aria-selected={inSel}
                      data-r={it.r}
                      data-c={ci}
                      className="dv-td"
                      data-kind={d.kind}
                      data-frozen={ci <= frozenIdx || undefined}
                      data-active={isActive || undefined}
                      data-sel={(inSel && !isActive) || undefined}
                      data-wrap={wrap || undefined}
                      data-ro={(!DESCRIPTORS[d.kind].writable && d.kind !== 'title') || undefined}
                      style={frozenStyle(ci)}
                      onMouseDown={(e) => {
                        if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, .dv-rel')) return
                        mouseDown.current = true
                        moveTo(it.r, ci, e.shiftKey)
                        focusGrid()
                      }}
                      onMouseEnter={() => mouseDown.current && setSel((s) => (s ? { ...s, r2: it.r, c2: ci } : s))}
                      onDoubleClick={() => begin(it.r, ci)}
                      onClick={() => isActive && d.kind !== 'title' && !editing && isPopoverKind(d.kind) && begin(it.r, ci)}
                    >
                      {d.kind === 'title' && (
                        <span className="dv-title-pre" style={{ paddingInlineStart: it.depth * 20 }}>
                          {hasKids ? (
                            <button
                              type="button"
                              className="dv-subtoggle"
                              aria-expanded={!collapsedR.has(it.id)}
                              aria-label={t('Show / hide sub-items')}
                              onClick={(e) => {
                                e.stopPropagation()
                                setCollapsedR((s) => {
                                  const n = new Set(s)
                                  n.has(it.id) ? n.delete(it.id) : n.add(it.id)
                                  return n
                                })
                              }}
                            >
                              <Icon name="chevron-down" size={14} className="dv-caret" />
                            </button>
                          ) : nested ? (
                            <span className="dv-subtoggle" aria-hidden />
                          ) : null}
                          <PageIcon page={repo.getRaw(it.id) ?? { id: it.id, icon: undefined, kind: undefined }} />
                        </span>
                      )}
                      {editing && isInlineKind(d.kind) ? (
                        <InlineCellEditor
                          svc={svc}
                          row={row}
                          def={d}
                          initial={edit!.initial}
                          onClose={closeEdit}
                          onNavigate={(dir) => (dir === 'down' ? moveTo(it.r + 1, ci) : dir === 'next' ? moveTo(it.r, ci + 1) : moveTo(it.r, ci - 1))}
                        />
                      ) : (
                        <div className="dv-cell">
                          <CellBox svc={svc} rs={rs} row={row} def={d} version={version} />
                        </div>
                      )}
                      {d.kind === 'title' && !editing && (
                        <button
                          type="button"
                          className="dv-open"
                          aria-label={t('Open {n}', { n: plainTitle(row.page.title) })}
                          onClick={(e) => {
                            e.stopPropagation()
                            nav.openRow(it.id, openMode)
                          }}
                        >
                          <Icon name="panel-right" size={14} /> {t('Open')}
                        </button>
                      )}
                      {editing && isPopoverKind(d.kind) && edit?.rect && <PopoverEditor svc={svc} row={row} def={d} anchor={edit.rect} onClose={closeEdit} />}
                    </div>
                  )
                })}
                <div className="dv-td dv-add" />
              </div>
            )
          })}
          {virtual && end < items.length && <div style={{ height: (items.length - end) * rowH }} aria-hidden />}
          {rowCount === 0 && (
            <div className="dv-table-empty">
              {filtered ? (
                <ViewMessage
                  title={t('No items match')}
                  action={
                    <Button size="sm" onClick={() => ctl.setPersonal({ filter: null, sorts: q.sorts })}>
                      {t('Clear filters')}
                    </Button>
                  }
                >
                  {t('The database is not empty: your filters or search hide everything.')}
                </ViewMessage>
              ) : (
                <ViewMessage
                  title={t('Nothing here yet')}
                  action={
                    ctl.canEditRows && (
                      <Button size="sm" variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => void addRow()}>
                        {t('New item')}
                      </Button>
                    )
                  }
                >
                  {t('Add the first item, import a CSV file, or link another database.')}
                </ViewMessage>
              )}
            </div>
          )}
          {q.hasMore && (
            <button type="button" className="dv-more" onClick={() => setWant((w) => w + 500)}>
              {t('Load more ({n} of {m})', { n: rowCount, m: q.total })}
            </button>
          )}
        </div>
        {ctl.canEditRows && rowCount > 0 && (
          <div className="dv-newrow" style={{ minWidth: totalW }}>
            <button type="button" onClick={() => void addRow()}>
              <Icon name="plus" size={15} /> {t('New item')}
            </button>
          </div>
        )}
        <div className="dv-tfoot" role="row" style={{ gridTemplateColumns: gridCols, minWidth: totalW }}>
          <div className="dv-tf dv-handle" />
          {cols.map((d, ci) => {
            const op = totals[d.id]
            const res = (q.totals as Record<string, unknown> | null)?.[d.id] as { value: { c: string; n?: number; v?: { start: string; end: string | null } } } | undefined
            return (
              <button
                type="button"
                key={d.id}
                className="dv-tf"
                data-frozen={ci <= frozenIdx || undefined}
                data-set={op ? true : undefined}
                style={frozenStyle(ci)}
                onClick={(e) => openMenu(totalItems(d), e.currentTarget)}
              >
                {op ? (
                  <>
                    <small>{aggLabel(op)}</small>
                    <b dir="ltr">{res?.value.c === 'number' ? Number((res.value.n ?? 0).toFixed(4)) : res?.value.c === 'date' ? res.value.v?.start : ''}</b>
                  </>
                ) : ci === 0 ? (
                  <small>{t('{n} items', { n: q.total })}</small>
                ) : (
                  <small className="dv-tf-calc">{t('Calculate')}</small>
                )}
              </button>
            )
          })}
        </div>
      </HorizontalScroll>
      {colMenu && (
        <PropertyMenu
          svc={svc}
          def={colMenu.def}
          anchor={colMenu.rect}
          onClose={() => setColMenu(null)}
          actions={{
            sort: (dir) => ctl.setPersonal({ ...(ctl.personal ?? {}), sorts: [{ propertyId: colMenu.def.id, direction: dir }] }),
            filter: () => ctl.openFilterFor(colMenu.def.id),
            freeze: () => void ctl.patch({ frozenThrough: frozenId === colMenu.def.id ? null : colMenu.def.id }),
            frozen: frozenId === colMenu.def.id,
            hide: () => void ctl.patch({ visibleProperties: cols.map((c) => c.id).filter((id) => id !== colMenu.def.id) }),
          }}
          onEditActions={(d) => window.dispatchEvent(new CustomEvent('db-edit-actions', { detail: d.id }))}
        />
      )}
      {newProp && (
        <NewPropertyPopover
          svc={svc}
          sourceId={view.sourceId!}
          anchor={newProp}
          onClose={() => setNewProp(null)}
          onCreated={(id) => void ctl.patch({ visibleProperties: [...cols.map((c) => c.id), id] })}
        />
      )}
      {menu}
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
function groupContext(svc: ViewProps['svc'], group: { propertyId: Id; mode?: string }, key: string): { propertyId: Id; cell: Cell }[] {
  const def = svc.state.prop(group.propertyId)
  if (!def || key === NONE_GROUP) return []
  switch (def.kind) {
    case 'select':
      return [{ propertyId: def.id, cell: { kind: 'select', optionId: key } }]
    case 'status':
      return group.mode === 'status_group' ? [] : [{ propertyId: def.id, cell: { kind: 'status', optionId: key } }]
    case 'multi_select':
      return [{ propertyId: def.id, cell: { kind: 'multi_select', optionIds: [key] } }]
    case 'people':
      return [{ propertyId: def.id, cell: { kind: 'people', principalIds: [key] } }]
    case 'checkbox':
      return [{ propertyId: def.id, cell: { kind: 'checkbox', value: key === 'true' } }]
    default:
      return []
  }
}
