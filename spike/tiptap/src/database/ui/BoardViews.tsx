// Board (Kanban), List and Gallery. All three use the same query and the same commands as the table; a drag is just a property change.
import { useEffect, useMemo, useState } from 'react'
import type { Cell, Definition, Id, Json } from '../model/types.ts'
import { optionsOf, statusConfig } from '../props/config.ts'
import { NONE_GROUP } from '../query/engine.ts'
import type { Row } from '../state.ts'
import { planBoardDrop } from '../viewLogic.ts'
import { repo } from '../../store'
import { urlFor } from '../../attachments'
import { Button, Icon, IconButton, dirOf, useMenu, type MenuItem } from '../../design-system'
import { t } from '../../i18n'
import { HorizontalScroll } from '../../HorizontalScroll'
import { CellView, useNav } from './CellView'
import { Chip, Hint, ViewMessage, errorText, plainTitle } from './common'
import { useViewQuery } from './useViewQuery'
import type { ViewProps } from './viewTypes'
import { PageIcon } from '../../PageIcon'
import { confirmDialog } from '../../dialog'
import { showToast } from '../../ui'

const CARD_PROPS_LIMIT = 4

function cardProps(svc: ViewProps['svc'], view: ViewProps['view'], exclude: Id[] = []): Definition[] {
  const cfg = view.configuration as { cardProperties?: Id[]; visibleProperties?: Id[] }
  const ids = cfg.cardProperties ?? cfg.visibleProperties ?? svc.state.props(view.sourceId!).map((p) => p.id)
  return ids
    .map((id) => svc.state.prop(id))
    .filter((d): d is Definition => !!d && d.kind !== 'title' && d.kind !== 'button' && !exclude.includes(d.id) && svc.access().canReadProperty(svc.principalId, d))
    .slice(0, CARD_PROPS_LIMIT)
}

const openModeOf = (cfg: Record<string, Json>) => ((cfg.openMode as string) === 'center_peek' ? 'center' : (cfg.openMode as string) === 'full_page' ? 'full' : 'side')

/** The context menu of an item, shared by cards and list rows. */
function useItemMenu(svc: ViewProps['svc'], ctl: ViewProps['ctl']) {
  const nav = useNav()
  const { open, menu } = useMenu()
  const items = (id: Id): MenuItem[] => [
    { label: 'Open', icon: <Icon name="maximize" size={16} />, onSelect: () => nav.openRow(id, 'full') },
    { label: 'Open in side peek', icon: <Icon name="panel-right" size={16} />, onSelect: () => nav.openRow(id, 'side') },
    { kind: 'sep' },
    {
      label: 'Duplicate',
      icon: <Icon name="copy" size={16} />,
      disabled: !ctl.canEditRows,
      onSelect: async () => {
        const r = await svc.tryExec([{ type: 'row.duplicate', payload: { rootPageIds: [id] } }])
        if (r.ok) showToast(t('Duplicated'), () => void svc.undo())
        else ctl.notice(errorText(r.code, r.message))
      },
    },
    { kind: 'sep' },
    {
      label: 'Delete',
      icon: <Icon name="trash" size={16} />,
      danger: true,
      disabled: !ctl.canEditRows,
      onSelect: async () => {
        const r = await svc.tryExec([{ type: 'row.trash', payload: { pageIds: [id] } }])
        if (r.ok) showToast(t('Moved to trash'), () => void svc.undo())
        else ctl.notice(errorText(r.code, r.message))
      },
    },
  ]
  return { onContextMenu: (id: Id) => (e: React.MouseEvent) => (e.preventDefault(), open(items(id), e)), menu }
}

function Card({
  svc,
  rs,
  row,
  props,
  onOpen,
  onContextMenu,
  draggable,
  onDragStart,
  onDragEnd,
  cover,
  dragging,
}: {
  svc: ViewProps['svc']
  rs: ViewProps['ctl']['rs']
  row: Row
  props: Definition[]
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  cover?: string | null
  dragging?: boolean
}) {
  const page = repo.getRaw(row.page.id)
  return (
    <div className="dv-card dv-stretch" draggable={draggable} data-dragging={dragging || undefined} onDragStart={onDragStart} onDragEnd={onDragEnd} onContextMenu={onContextMenu}>
      {/* the card opens through one button under its content, so its chips and links stay real controls of their own */}
      <button type="button" className="dv-stretch-hit" aria-label={plainTitle(row.page.title) || t('Untitled')} onClick={onOpen} />
      {cover && (
        <div className="dv-card-cover">
          <img src={cover} alt="" loading="lazy" />
        </div>
      )}
      <div className="dv-card-title" dir={dirOf(row.page.title)}>
        <PageIcon page={page ?? { id: row.page.id, icon: undefined, kind: undefined }} />
        <span dir="auto">{plainTitle(row.page.title)}</span>
      </div>
      {props.length > 0 && (
        <div className="dv-card-props">
          {props.map((d) => {
            const q = rs.value(row, d)
            if (q.c === 'empty' && d.kind !== 'checkbox') return null
            return (
              <div className="dv-card-prop" key={d.id} title={d.name}>
                <CellView svc={svc} rs={rs} row={row} def={d} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The picture of a card: a files property, the page cover or the first image in the page, as the view asks. */
function useCover(row: Row, view: ViewProps['view'], enabled: boolean): string | null | undefined {
  const cfg = view.configuration as { coverPropertyId?: Id | null; previewSource?: string }
  const [url, setUrl] = useState<string | null>(null)
  const fileId = (() => {
    if (!cfg.coverPropertyId) return null
    const c = row.ext.cells[cfg.coverPropertyId]?.value
    return c?.kind === 'files' && c.attachmentIds[0] ? c.attachmentIds[0] : null
  })()
  const page = repo.getRaw(row.page.id)
  const coverFile = page?.cover?.kind === 'image' ? page.cover.file : null
  const first = (() => {
    if ((cfg.previewSource ?? 'cover') !== 'content') return null
    const find = (n: unknown): string | null => {
      const o = n as { type?: string; attrs?: { src?: string }; content?: unknown[] } | null
      if (!o) return null
      if (o.type === 'image' && o.attrs?.src?.startsWith('att:')) return o.attrs.src.slice(4)
      for (const c of o.content ?? []) {
        const r = find(c)
        if (r) return r
      }
      return null
    }
    return find(page?.content)
  })()
  const want = !enabled || cfg.previewSource === 'none' ? null : cfg.previewSource === 'property' ? fileId : cfg.previewSource === 'content' ? (first ?? coverFile) : (fileId ?? coverFile ?? first)
  useEffect(() => {
    let live = true
    if (!want) return void setUrl(null)
    void urlFor('att:' + want).then((u) => live && setUrl(u))
    return () => void (live = false)
  }, [want])
  if (!enabled) return undefined
  return url
}

const CardWithCover = (p: Omit<Parameters<typeof Card>[0], 'cover'> & { view: ViewProps['view']; showCover: boolean }) => {
  const cover = useCover(p.row, p.view, p.showCover)
  return <Card {...p} cover={p.showCover ? cover : undefined} />
}

// ───── Board ─────

type DragData = { pageId: Id; from: string; sub: string | null }

export function DatabaseBoardView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const itemMenu = useItemMenu(svc, ctl)
  const groupId = cfg.groupPropertyId as Id | undefined
  const subId = (cfg.subgroupPropertyId as Id | null | undefined) ?? null
  const def = groupId ? svc.state.prop(groupId) : undefined
  const subDef = subId ? svc.state.prop(subId) : undefined
  const mode = (cfg.groupMode as string) ?? (def?.kind === 'status' ? 'option' : undefined)
  const [drag, setDrag] = useState<DragData | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set((cfg.collapsedGroups as string[]) ?? []))
  const opts = useMemo(
    () => ({ search: ctl.search, personal: ctl.personal, want: 2000, group: def ? ({ propertyId: def.id, mode } as never) : null, subgroup: subDef ? ({ propertyId: subDef.id } as never) : null }),
    [ctl.search, ctl.personal, def?.id, mode, subDef?.id], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const q = useViewQuery(svc, view, opts)
  const rs = ctl.rs
  if (!def) return <ViewMessage title={t('Choose how to group this board')}>{t('Open View settings and pick a property to group by.')}</ViewMessage>
  if (q.error)
    return (
      <ViewMessage tone="bad" title={t('This view cannot be shown')}>
        {errorText(q.error.code, q.error.message)}
      </ViewMessage>
    )
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
  const lanes: Lane[] = subDef
    ? [
        ...q.groups
          .flatMap((g) => (g as typeof g & { subgroups?: typeof q.groups }).subgroups ?? [])
          .reduce((m, s) => m.set(s.key, { key: s.key, label: s.key === NONE_GROUP ? t('No value') : s.label, ids: new Set([...(m.get(s.key)?.ids ?? []), ...s.pageIds]) }), new Map<string, Lane>())
          .values(),
      ]
    : [{ key: '', label: '', ids: null }]

  const props = cardProps(svc, view, [def.id])
  const showCover = !!cfg.coverPropertyId

  const drop = async (toKey: string, toSub: string | null) => {
    const d = drag
    setDrag(null)
    setOver(null)
    if (!d) return
    if (d.from === toKey && d.sub === toSub) return
    const plan = planBoardDrop(svc.state, { pageId: d.pageId, groupPropertyId: def.id, fromKey: d.from, toKey, sortsActive: sorted, mode: mode as never })
    if (!plan.ok) return ctl.notice(plan.reason)
    if (plan.noop) return
    if (
      plan.confirm &&
      !(await confirmDialog({
        title: t('Clear this property?'),
        message: t('The card has several values here; dropping it in “No value” removes all of them.'),
        confirmLabel: t('Clear'),
        danger: true,
      }))
    )
      return
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
  const toggle = (key: string) => {
    const n = new Set(collapsed)
    n.has(key) ? n.delete(key) : n.add(key)
    setCollapsed(n)
    void ctl.patch({ collapsedGroups: [...n] })
  }

  return (
    <div className="dv-board-wrap" data-size={(cfg.cardSize as string) ?? 'medium'}>
      {readOnly && <Hint>{t('This board is grouped by a calculated value, so cards cannot be moved between columns.')}</Hint>}
      <HorizontalScroll className="dv-board-scroll" viewportClassName="dv-board" label={t('Board')} viewportProps={{ role: 'group', 'aria-label': t('Board') }}>
        {lanes.map((lane) => (
          <div className="dv-lane" key={lane.key || 'all'}>
            {subDef && (
              <h3 className="dv-lane-title" dir="auto">
                {lane.label}
              </h3>
            )}
            <div className="dv-columns">
              {shownCols.map((col) => {
                const ids = lane.ids ? col.ids.filter((id) => lane.ids!.has(id)) : col.ids
                const isCollapsed = collapsed.has(col.key)
                const zone = col.key + '|' + lane.key
                return (
                  <section
                    key={col.key}
                    className="dv-column"
                    data-over={over === zone || undefined}
                    data-collapsed={isCollapsed || undefined}
                    aria-label={col.label}
                    onDragOver={(e) => {
                      if (drag && !readOnly) {
                        e.preventDefault()
                        if (over !== zone) setOver(zone)
                      }
                    }}
                    onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(null)}
                    onDrop={() => void drop(col.key, lane.key || null)}
                  >
                    <header className="dv-column-head">
                      <button type="button" className="dv-column-toggle" aria-expanded={!isCollapsed} onClick={() => toggle(col.key)}>
                        <Icon name="chevron-down" size={15} className="dv-caret" />
                        {col.color ? <Chip color={col.color}>{col.label}</Chip> : <b dir="auto">{col.label}</b>}
                        <span className="ds-badge">{ids.length}</span>
                      </button>
                      {ctl.canEditRows && !isCollapsed && (
                        <IconButton label={t('New item in {n}', { n: col.label })} onClick={() => void ctl.createRow({ context: ctxFor(col.key) }).then((r) => r && nav.openRow(r.pageId, 'side'))}>
                          <Icon name="plus" size={15} />
                        </IconButton>
                      )}
                    </header>
                    {!isCollapsed && (
                      <div className="dv-column-body">
                        {ids.map((id) => {
                          const row = svc.state.row(id)
                          if (!row) return null
                          return (
                            <CardWithCover
                              key={id}
                              svc={svc}
                              rs={rs}
                              row={row}
                              view={view}
                              showCover={showCover}
                              props={props}
                              dragging={drag?.pageId === id}
                              onOpen={() => nav.openRow(id, openModeOf(cfg))}
                              onContextMenu={itemMenu.onContextMenu(id)}
                              draggable={ctl.canEditRows && !readOnly}
                              onDragStart={(e) => {
                                e.dataTransfer.setData('text/plain', id)
                                setDrag({ pageId: id, from: col.key, sub: lane.key || null })
                              }}
                              onDragEnd={() => (setDrag(null), setOver(null))}
                            />
                          )
                        })}
                        {ids.length === 0 && <div className="dv-column-empty">{drag ? t('Drop here') : t('No items')}</div>}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          </div>
        ))}
      </HorizontalScroll>
      {hidden.size > 0 && (
        <Button size="sm" variant="ghost" onClick={() => void ctl.patch({ hiddenGroups: [] })}>
          {t('Show {n} hidden group(s)', { n: hidden.size })}
        </Button>
      )}
      {itemMenu.menu}
    </div>
  )
}

function subCell(def: Definition, key: string): Cell | null {
  switch (def.kind) {
    case 'select':
      return { kind: 'select', optionId: key }
    case 'status':
      return { kind: 'status', optionId: key }
    case 'checkbox':
      return { kind: 'checkbox', value: key === 'true' }
    default:
      return null
  }
}

function GroupHead({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="dv-section-head">
      <span dir="auto">{label}</span>
      <span className="ds-badge">{count}</span>
    </h3>
  )
}

// ───── List ─────

export function ListView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const itemMenu = useItemMenu(svc, ctl)
  const group = (cfg.group as { propertyId: Id; mode?: string } | null | undefined) ?? null
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 1000, group: group as never })
  const rs = ctl.rs
  const props = cardProps(svc, view)
  const open = (id: Id) => nav.openRow(id, openModeOf(cfg))
  if (q.error)
    return (
      <ViewMessage tone="bad" title={t('This view cannot be shown')}>
        {errorText(q.error.code, q.error.message)}
      </ViewMessage>
    )
  const line = (id: Id) => {
    const row = svc.state.row(id)
    if (!row) return null
    return (
      <div className="ds-list-row dv-listrow dv-stretch" dir={dirOf(row.page.title)} key={id} onContextMenu={itemMenu.onContextMenu(id)}>
        <button type="button" className="dv-stretch-hit" aria-label={plainTitle(row.page.title) || t('Untitled')} onClick={() => open(id)} />
        <PageIcon page={repo.getRaw(id) ?? { id, icon: undefined, kind: undefined }} />
        <span className="dv-listrow-title">
          <span dir="auto">{plainTitle(row.page.title)}</span>
        </span>
        <span className="dv-listrow-props">
          {props.map((d) => (
            <span key={d.id} className="dv-listrow-prop" title={d.name}>
              <CellView svc={svc} rs={rs} row={row} def={d} />
            </span>
          ))}
        </span>
      </div>
    )
  }
  const add = ctl.canEditRows && (
    <button type="button" className="dv-newline" onClick={() => void ctl.createRow({ edit: true }).then((r) => r && open(r.pageId))}>
      <Icon name="plus" size={15} /> {t('New item')}
    </button>
  )
  return (
    <div className="dv-list" data-density={(cfg.density as string) ?? 'compact'}>
      {q.total === 0 ? (
        <ViewMessage title={t('Nothing here yet')} action={add} />
      ) : q.groups.length ? (
        q.groups.map((g) => (
          <section key={g.key}>
            <GroupHead label={g.key === NONE_GROUP ? t('No value') : g.label} count={g.count} />
            <div className="ds-list ds-list--framed">{g.pageIds.map(line)}</div>
          </section>
        ))
      ) : (
        <div className="ds-list ds-list--framed">{q.rows.map((r) => line(r.pageId))}</div>
      )}
      {q.total > 0 && add}
      {itemMenu.menu}
    </div>
  )
}

// ───── Gallery ─────

export function GalleryView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const itemMenu = useItemMenu(svc, ctl)
  const group = (cfg.group as { propertyId: Id; mode?: string } | null | undefined) ?? null
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 1000, group: group as never })
  const rs = ctl.rs
  const props = cardProps(svc, view)
  const showCover = (cfg.previewSource as string) !== 'none'
  // bodies load lazily in the desktop app; the cards of this page need them for the "first image in the page" preview
  const previewIds = (cfg.previewSource as string) === 'content' ? q.rows.slice(0, 60).map((r) => r.pageId).join(',') : ''
  useEffect(() => {
    if (previewIds) void repo.ensureContent(previewIds.split(',')).catch(() => undefined)
  }, [previewIds])
  if (q.error)
    return (
      <ViewMessage tone="bad" title={t('This view cannot be shown')}>
        {errorText(q.error.code, q.error.message)}
      </ViewMessage>
    )
  const card = (id: Id) => {
    const row = svc.state.row(id)
    return row ? (
      <CardWithCover key={id} svc={svc} rs={rs} row={row} view={view} showCover={showCover} props={props} onOpen={() => nav.openRow(id, openModeOf(cfg))} onContextMenu={itemMenu.onContextMenu(id)} />
    ) : null
  }
  const add = ctl.canEditRows && (
    <button type="button" className="dv-newline" onClick={() => void ctl.createRow({ edit: true }).then((r) => r && nav.openRow(r.pageId, 'side'))}>
      <Icon name="plus" size={15} /> {t('New item')}
    </button>
  )
  return (
    <div className="dv-gallery" data-size={(cfg.cardSize as string) ?? 'medium'} data-fit={(cfg.fit as string) ?? 'cover'}>
      {q.total === 0 ? (
        <ViewMessage title={t('Nothing here yet')} action={add} />
      ) : q.groups.length ? (
        q.groups.map((g) => (
          <section key={g.key}>
            <GroupHead label={g.key === NONE_GROUP ? t('No value') : g.label} count={g.count} />
            <div className="dv-gallery-grid">{g.pageIds.map(card)}</div>
          </section>
        ))
      ) : (
        <div className="dv-gallery-grid">{q.rows.map((r) => card(r.pageId))}</div>
      )}
      {q.total > 0 && add}
      {itemMenu.menu}
    </div>
  )
}
