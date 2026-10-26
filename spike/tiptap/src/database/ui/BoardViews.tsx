// Board (Kanban), List and Gallery. All three use the same query and the same commands as the table; a drag is just a property change.
import { useEffect, useMemo, useState } from 'react'
import type { Cell, Definition, Id, Json } from '../model/types.ts'
import { optionsOf, statusConfig } from '../props/config.ts'
import { NONE_GROUP } from '../query/engine.ts'
import type { Row } from '../state.ts'
import { planBoardDrop } from '../viewLogic.ts'
import { repo } from '../../store'
import { urlFor } from '../../attachments'
import { t } from '../../i18n'
import { HorizontalScroll } from '../../HorizontalScroll'
import * as Ic from '../../icons'
import { CellView, useFileNames, useNav } from './CellView'
import { Chip, errorText, plainTitle } from './common'
import { useViewQuery } from './useViewQuery'
import type { ViewProps } from './viewTypes'
import { PageIcon } from '../../PageIcon'
import { confirmDialog } from '../../dialog'

const CARD_PROPS_LIMIT = 4

function cardProps(svc: ViewProps['svc'], view: ViewProps['view'], exclude: Id[] = []): Definition[] {
  const cfg = view.configuration as { cardProperties?: Id[]; visibleProperties?: Id[] }
  const ids = cfg.cardProperties ?? cfg.visibleProperties ?? svc.state.props(view.sourceId!).map((p) => p.id)
  return ids.map((id) => svc.state.prop(id)).filter((d): d is Definition => !!d && d.kind !== 'title' && d.kind !== 'button' && !exclude.includes(d.id) && svc.access().canReadProperty(svc.principalId, d)).slice(0, CARD_PROPS_LIMIT)
}

function Card({ svc, rs, row, props, onOpen, draggable, onDragStart, cover }: { svc: ViewProps['svc']; rs: ViewProps['ctl']['rs']; row: Row; props: Definition[]; onOpen: () => void; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void; cover?: string | null }) {
  const page = repo.getRaw(row.page.id)
  return (
    <div className="db-card" role="button" tabIndex={0} draggable={draggable} onDragStart={onDragStart} onClick={onOpen} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}>
      {cover && <img className="db-card-cover" src={cover} alt="" loading="lazy" />}
      <div className="db-card-title" dir="auto"><PageIcon page={page ?? { id: row.page.id, icon: undefined, kind: undefined }} /> <span>{plainTitle(row.page.title)}</span></div>
      {props.map((d) => {
        const q = rs.value(row, d)
        if (q.c === 'empty' && d.kind !== 'checkbox') return null
        return <div className="db-card-prop" key={d.id}><CellView svc={svc} rs={rs} row={row} def={d} compact /></div>
      })}
    </div>
  )
}

function useCover(svc: ViewProps['svc'], row: Row, view: ViewProps['view']): string | null {
  const cfg = view.configuration as { coverPropertyId?: Id | null; previewSource?: string }
  const [url, setUrl] = useState<string | null>(null)
  const fileId = (() => {
    if (cfg.coverPropertyId) {
      const c = row.ext.cells[cfg.coverPropertyId]?.value
      if (c?.kind === 'files' && c.attachmentIds[0]) return c.attachmentIds[0]
      return null
    }
    return null
  })()
  const page = repo.getRaw(row.page.id)
  const coverFile = page?.cover?.kind === 'image' ? page.cover.file : null
  const first = (() => {
    if ((cfg.previewSource ?? 'cover') !== 'content') return null
    const find = (n: unknown): string | null => {
      const o = n as { type?: string; attrs?: { src?: string }; content?: unknown[] } | null
      if (!o) return null
      if (o.type === 'image' && o.attrs?.src?.startsWith('att:')) return o.attrs.src.slice(4)
      for (const c of o.content ?? []) { const r = find(c); if (r) return r }
      return null
    }
    return find(page?.content)
  })()
  const want = cfg.previewSource === 'none' ? null : cfg.previewSource === 'property' ? fileId : cfg.previewSource === 'content' ? (first ?? coverFile) : (fileId ?? coverFile ?? first)
  useEffect(() => {
    let live = true
    if (!want) return void setUrl(null)
    void urlFor('att:' + want).then((u) => live && setUrl(u))
    return () => void (live = false)
  }, [want])
  void svc
  return url
}

// ───── Board ─────

type DragData = { pageId: Id; from: string; sub: string | null }

export function DatabaseBoardView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const groupId = cfg.groupPropertyId as Id | undefined
  const subId = (cfg.subgroupPropertyId as Id | null | undefined) ?? null
  const def = groupId ? svc.state.prop(groupId) : undefined
  const subDef = subId ? svc.state.prop(subId) : undefined
  const mode = (cfg.groupMode as string) ?? (def?.kind === 'status' ? 'option' : undefined)
  const [drag, setDrag] = useState<DragData | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set((cfg.collapsedGroups as string[]) ?? []))
  const opts = useMemo(() => ({ search: ctl.search, personal: ctl.personal, want: 2000, group: def ? ({ propertyId: def.id, mode } as never) : null, subgroup: subDef ? ({ propertyId: subDef.id } as never) : null }), [ctl.search, ctl.personal, def?.id, mode, subDef?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const q = useViewQuery(svc, view, opts)
  const rs = ctl.rs
  if (!def) return <div className="db-error-box"><b>{t('Choose how to group this board')}</b><p>{t('Open View settings and pick a property to group by.')}</p></div>
  if (q.error) return <div className="db-error-box" role="alert"><b>{t('This view cannot be shown')}</b><p>{errorText(q.error.code, q.error.message)}</p></div>
  const readOnly = ['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id'].includes(def.kind)
  const sorted = q.sorts.length > 0
  const hidden = new Set((cfg.hiddenGroups as string[]) ?? [])
  const hideEmpty = !!cfg.hideEmpty

  // columns: every option of a select-like property (also the empty ones), then whatever else the data has
  type Col = { key: string; label: string; color?: string; ids: Id[] }
  const byKey = new Map(q.groups.map((g) => [g.key, g]))
  const cols: Col[] = []
  if (def.kind === 'select' || def.kind === 'multi_select' || def.kind === 'status') {
    if (mode === 'status_group' && def.kind === 'status') for (const g of statusConfig(def.config).groups) cols.push({ key: g.id, label: g.label, ids: byKey.get(g.id)?.pageIds ?? [] })
    else for (const o of optionsOf(def)) cols.push({ key: o.id, label: o.name, color: o.color, ids: byKey.get(o.id)?.pageIds ?? [] })
  } else for (const g of q.groups) if (g.key !== NONE_GROUP) cols.push({ key: g.key, label: g.label || t('Value'), ids: g.pageIds })
  if (def.kind !== 'status') cols.push({ key: NONE_GROUP, label: t('No value'), ids: byKey.get(NONE_GROUP)?.pageIds ?? [] })
  const shownCols = cols.filter((c) => !hidden.has(c.key) && !(hideEmpty && c.ids.length === 0))
  // swimlanes: sub-groups of the second property
  type Lane = { key: string; label: string; ids: Set<Id> | null }
  const lanes: Lane[] = subDef ? [...q.groups.flatMap((g) => (g as typeof g & { subgroups?: typeof q.groups }).subgroups ?? []).reduce((m, s) => m.set(s.key, { key: s.key, label: s.key === NONE_GROUP ? t('No value') : s.label, ids: new Set([...(m.get(s.key)?.ids ?? []), ...s.pageIds]) }), new Map<string, Lane>()).values()] : [{ key: '', label: '', ids: null }]

  const props = cardProps(svc, view, [def.id])
  const cardSize = (cfg.cardSize as string) ?? 'medium'

  const drop = async (toKey: string, toSub: string | null) => {
    const d = drag
    setDrag(null)
    setOver(null)
    if (!d) return
    if (d.from === toKey && d.sub === toSub) return
    const plan = planBoardDrop(svc.state, { pageId: d.pageId, groupPropertyId: def.id, fromKey: d.from, toKey, sortsActive: sorted, mode: mode as never })
    if (!plan.ok) return ctl.notice(plan.reason)
    if (plan.noop) return
    if (plan.confirm && !(await confirmDialog({ title: t('Clear this property?'), message: t('The card has several values here; dropping it in “No value” removes all of them.'), confirmLabel: t('Clear'), danger: true }))) return
    const cmds = [...plan.commands]
    if (subDef && toSub !== d.sub && toSub !== null) {
      const cell = subCell(subDef, toSub)
      if (cell) cmds.push({ type: 'row.patch', payload: { pageId: d.pageId, cellChanges: { [subDef.id]: cell as unknown as Json } } })
    }
    const r = await svc.tryExec(cmds.map((c) => ({ type: c.type, payload: c.payload })))
    if (!r.ok) ctl.notice(errorText(r.code, r.message)) // the card simply stays where it was; the reason is shown
  }
  const ctxFor = (key: string): { propertyId: Id; cell: Cell }[] => {
    if (key === NONE_GROUP) return []
    if (def.kind === 'select') return [{ propertyId: def.id, cell: { kind: 'select', optionId: key } }]
    if (def.kind === 'status') return mode === 'status_group' ? [] : [{ propertyId: def.id, cell: { kind: 'status', optionId: key } }]
    if (def.kind === 'multi_select') return [{ propertyId: def.id, cell: { kind: 'multi_select', optionIds: [key] } }]
    if (def.kind === 'people') return [{ propertyId: def.id, cell: { kind: 'people', principalIds: [key] } }]
    if (def.kind === 'checkbox') return [{ propertyId: def.id, cell: { kind: 'checkbox', value: key === 'true' } }]
    return []
  }

  return (
    <HorizontalScroll className="db-board-scroll" viewportClassName="db-board" label={t('Board')} viewportProps={{ role: 'group', 'aria-label': t('Board') }}>
      <div className="db-board-lanes" data-size={cardSize}>
      {readOnly && <div className="db-date-hint">{t('This board is grouped by a calculated value, so cards cannot be moved between columns.')}</div>}
      {lanes.map((lane) => (
        <div className="db-lane" key={lane.key || 'all'}>
          {subDef && <div className="db-lane-title"><b dir="auto">{lane.label}</b></div>}
          <div className="db-cols">
            {shownCols.map((col) => {
              const ids = lane.ids ? col.ids.filter((id) => lane.ids!.has(id)) : col.ids
              const isCollapsed = collapsed.has(col.key)
              return (
                <div
                  key={col.key}
                  className={'db-col' + (over === col.key + '|' + lane.key ? ' over' : '') + (isCollapsed ? ' collapsed' : '')}
                  role="group"
                  aria-label={col.label}
                  onDragOver={(e) => { if (drag && !readOnly) { e.preventDefault(); setOver(col.key + '|' + lane.key) } }}
                  onDragLeave={() => setOver(null)}
                  onDrop={() => void drop(col.key, lane.key || null)}
                >
                  <div className="db-col-head">
                    <button type="button" className="icon-btn" aria-expanded={!isCollapsed} aria-label={isCollapsed ? t('Expand') : t('Collapse')} onClick={() => { const n = new Set(collapsed); n.has(col.key) ? n.delete(col.key) : n.add(col.key); setCollapsed(n); void ctl.patch({ collapsedGroups: [...n] }) }}><span className={'db-caret' + (isCollapsed ? '' : ' open')}><Ic.Chevron size={12} /></span></button>
                    {col.color ? <Chip color={col.color}>{col.label}</Chip> : <b dir="auto">{col.label}</b>}
                    <span className="db-count">{ids.length}</span>
                    <span className="spacer" />
                    {ctl.canEditRows && !isCollapsed && <button type="button" className="icon-btn" aria-label={t('New item in {n}', { n: col.label })} onClick={() => void ctl.createRow({ context: ctxFor(col.key) }).then((r) => r && nav.openRow(r.pageId, 'side'))}><Ic.Plus size={13} /></button>}
                  </div>
                  {!isCollapsed && (
                    <div className="db-col-body">
                      {ids.map((id) => {
                        const row = svc.state.row(id)
                        if (!row) return null
                        return <CardWithCover key={id} svc={svc} rs={rs} row={row} view={view} props={props} onOpen={() => nav.openRow(id, (cfg.openMode as string) === 'center_peek' ? 'center' : (cfg.openMode as string) === 'full_page' ? 'full' : 'side')} draggable={ctl.canEditRows && !readOnly} onDragStart={(e) => { e.dataTransfer.setData('text/plain', id); setDrag({ pageId: id, from: col.key, sub: lane.key || null }) }} />
                      })}
                      {ids.length === 0 && <div className="db-col-empty">{t('Drop cards here')}</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {hidden.size > 0 && <button type="button" className="db-linkbtn" onClick={() => void ctl.patch({ hiddenGroups: [] })}>{t('Show {n} hidden group(s)', { n: hidden.size })}</button>}
      </div>
    </HorizontalScroll>
  )
}

const CardWithCover = (p: Omit<Parameters<typeof Card>[0], 'cover'> & { view: ViewProps['view'] }) => {
  const cover = useCover(p.svc, p.row, p.view)
  return <Card {...p} cover={cover} />
}

function subCell(def: Definition, key: string): Cell | null {
  switch (def.kind) {
    case 'select': return { kind: 'select', optionId: key }
    case 'status': return { kind: 'status', optionId: key }
    case 'checkbox': return { kind: 'checkbox', value: key === 'true' }
    default: return null
  }
}

// ───── List ─────

export function ListView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const group = (cfg.group as { propertyId: Id; mode?: string } | null | undefined) ?? null
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 1000, group: group as never })
  const rs = ctl.rs
  const props = cardProps(svc, view)
  const open = (id: Id) => nav.openRow(id, (cfg.openMode as string) === 'center_peek' ? 'center' : (cfg.openMode as string) === 'full_page' ? 'full' : 'side')
  if (q.error) return <div className="db-error-box" role="alert">{errorText(q.error.code, q.error.message)}</div>
  const line = (id: Id) => {
    const row = svc.state.row(id)
    if (!row) return null
    return (
      <button type="button" className="db-listrow" key={id} onClick={() => open(id)}>
        <PageIcon page={repo.getRaw(id) ?? { id, icon: undefined, kind: undefined }} />
        <span className="db-list-title" dir="auto">{plainTitle(row.page.title)}</span>
        <span className="db-list-props">{props.map((d) => <span key={d.id} className="db-list-prop"><CellView svc={svc} rs={rs} row={row} def={d} compact /></span>)}</span>
      </button>
    )
  }
  return (
    <div className="db-list" data-density={(cfg.density as string) ?? 'compact'}>
      {q.groups.length
        ? q.groups.map((g) => (
            <div key={g.key} className="db-list-group">
              <div className="db-group-row"><b dir="auto">{g.key === NONE_GROUP ? t('No value') : g.label}</b> <span className="db-count">{g.count}</span></div>
              {g.pageIds.map(line)}
            </div>
          ))
        : q.rows.map((r) => line(r.pageId))}
      {q.total === 0 && <div className="db-empty"><b>{t('Nothing here yet')}</b></div>}
      {ctl.canEditRows && <button type="button" className="db-newline" onClick={() => void ctl.createRow({ edit: true }).then((r) => r && open(r.pageId))}><Ic.Plus size={13} /> {t('New item')}</button>}
    </div>
  )
}

// ───── Gallery ─────

export function GalleryView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const group = (cfg.group as { propertyId: Id; mode?: string } | null | undefined) ?? null
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 1000, group: group as never })
  const rs = ctl.rs
  const props = cardProps(svc, view)
  useFileNames([])
  // bodies load lazily in the desktop app; the cards of this page need them for the "first image in the page" preview
  useEffect(() => {
    if ((cfg.previewSource as string) === 'content') void repo.ensureContent(q.rows.slice(0, 60).map((r) => r.pageId)).catch(() => undefined)
  }, [q.rows.length, cfg.previewSource]) // eslint-disable-line react-hooks/exhaustive-deps
  if (q.error) return <div className="db-error-box" role="alert">{errorText(q.error.code, q.error.message)}</div>
  const card = (id: Id) => {
    const row = svc.state.row(id)
    return row ? <CardWithCover key={id} svc={svc} rs={rs} row={row} view={view} props={props} onOpen={() => nav.openRow(id, (cfg.openMode as string) === 'center_peek' ? 'center' : (cfg.openMode as string) === 'full_page' ? 'full' : 'side')} /> : null
  }
  return (
    <div className="db-gallery" data-size={(cfg.cardSize as string) ?? 'medium'} data-fit={(cfg.fit as string) ?? 'cover'}>
      {q.groups.length
        ? q.groups.map((g) => (
            <div key={g.key} className="db-gal-group">
              <div className="db-group-row"><b dir="auto">{g.key === NONE_GROUP ? t('No value') : g.label}</b> <span className="db-count">{g.count}</span></div>
              <div className="db-gal-grid">{g.pageIds.map(card)}</div>
            </div>
          ))
        : <div className="db-gal-grid">{q.rows.map((r) => card(r.pageId))}</div>}
      {q.total === 0 && <div className="db-empty"><b>{t('Nothing here yet')}</b></div>}
      {ctl.canEditRows && <button type="button" className="db-newline" onClick={() => void ctl.createRow({ edit: true }).then((r) => r && nav.openRow(r.pageId, 'side'))}><Ic.Plus size={13} /> {t('New item')}</button>}
    </div>
  )
}
