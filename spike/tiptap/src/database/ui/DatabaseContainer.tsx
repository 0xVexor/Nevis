// A database as the user sees it: the views as tabs, one toolbar (search, filter, sort, group, properties, more, New), a line
// that says which filters and sorts are on, the active view and the row peek. It owns the viewer's unsaved ("personal")
// filter and sort overrides.
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { Container, Definition, Filter, Id, Json, Sort, View, ViewType } from '../model/types.ts'
import { matchesFilter } from '../query/engine.ts'
import type { DatabaseService } from '../service.ts'
import { setPreference, removePreference } from '../../preferenceEvents'
import { Button, ChipButton, Dropdown, FormField, Icon, IconButton, Panel, Popover, SearchField, useMenu, type MenuItem } from '../../design-system'
import { confirmDialog, promptDialog } from '../../dialog'
import { showToast } from '../../ui'
import { t } from '../../i18n'
import { NavContext, type DbNav } from './CellView'
import { ErrorLine, Hint, KindIcon, ViewMessage, errorText, rawOptions, useDb, useRepoTick } from './common'
import { FilterEditor, GroupEditor, SortEditor, describeFilter, filterRuleCount, type GroupConfig } from './ViewControls'
import { NewPropertyPopover } from './PropertyEditor'
import { TableView } from './TableView'
import type { CreateRowOpts, ViewCtl, ViewProps } from './viewTypes'
import type { Personal } from './useViewQuery'
import { RowPeek } from './RowPeek'
import { ViewSettings } from './ViewSettings'
import { useImportExport } from './ImportExport'
import { VIEW_HINT, VIEW_LABEL, ViewIcon } from './viewMeta'
import { WorkflowPanel } from './WorkflowPanel'

const lazyView = (f: () => Promise<{ default: ComponentType<ViewProps> }>) => lazy(f)
const VIEWS: Partial<Record<ViewType, ComponentType<ViewProps>>> = {
  table: TableView,
  board: lazyView(() => import('./BoardViews').then((m) => ({ default: m.DatabaseBoardView }))),
  list: lazyView(() => import('./BoardViews').then((m) => ({ default: m.ListView }))),
  gallery: lazyView(() => import('./BoardViews').then((m) => ({ default: m.GalleryView }))),
  calendar: lazyView(() => import('./ScheduleViews').then((m) => ({ default: m.CalendarView }))),
  timeline: lazyView(() => import('./ScheduleViews').then((m) => ({ default: m.TimelineView }))),
  chart: lazyView(() => import('./ChartView').then((m) => ({ default: m.ChartView }))),
  map: lazyView(() => import('./MapView').then((m) => ({ default: m.MapView }))),
  feed: lazyView(() => import('./FeedView').then((m) => ({ default: m.FeedView }))),
  form: lazyView(() => import('./FormView').then((m) => ({ default: m.FormView }))),
  dashboard: lazyView(() => import('./DashboardView').then((m) => ({ default: m.DashboardView }))),
}
/** Layouts that show items one by one, so filter and sort make sense; Group is for the ones that draw groups as sections. */
const FILTERED: ViewType[] = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'feed', 'map']
const GROUPED: ViewType[] = ['table', 'list', 'gallery']

const personalKey = (id: Id) => 'db.personal.' + id
function loadPersonal(id: Id): Personal | null {
  try {
    const v = localStorage.getItem(personalKey(id))
    return v ? JSON.parse(v) : null
  } catch {
    return null
  }
}
function savePersonal(id: Id, p: Personal | null) {
  try {
    p ? setPreference(personalKey(id), JSON.stringify(p)) : removePreference(personalKey(id))
  } catch {
    /* private window: the override just lives in memory */
  }
}

export type OpenPage = (pageId: Id) => void

export function DatabaseContainer({ containerId, viewId, onOpenPage, inline }: { containerId: Id; viewId?: Id | null; onOpenPage: OpenPage; inline?: boolean }) {
  const svc = useDb()
  useRepoTick()
  if (!svc)
    return (
      <div className="dv-loading" role="status">
        {t('Opening the database…')}
      </div>
    )
  const c = svc.state.get('container', containerId)
  if (!c || c.deletedAt !== null) return <ViewMessage title={t('This database no longer exists.')} />
  return <Inner svc={svc} container={c} fixedViewId={viewId ?? null} onOpenPage={onOpenPage} inline={!!inline} />
}

type PanelKind = 'filter' | 'sort' | 'group' | 'props' | 'settings' | 'newview' | 'workflows'

function Inner({ svc, container, fixedViewId, onOpenPage, inline }: { svc: DatabaseService; container: Container; fixedViewId: Id | null; onOpenPage: OpenPage; inline: boolean }) {
  const views = svc.state.viewsOf(container.id).filter((v) => v.parentDashboardId === null)
  const [activeId, setActiveId] = useState<Id | null>(fixedViewId)
  const view: View | undefined = views.find((v) => v.id === (fixedViewId ?? activeId)) ?? views[0]
  const [personal, setPersonalState] = useState<Personal | null>(() => (view ? loadPersonal(view.id) : null))
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [panel, setPanel] = useState<{ kind: PanelKind; rect: DOMRect } | null>(null)
  const [peek, setPeek] = useState<{ id: Id; mode: 'side' | 'center' } | null>(null)
  const [editWf, setEditWf] = useState<{ propertyId: Id } | null>(null)
  const { open: openMenu, menu } = useMenu()
  const moreBtn = useRef<HTMLButtonElement>(null)
  const filterBtn = useRef<HTMLButtonElement>(null)
  const rsRef = useRef(svc.resolver())
  rsRef.current = svc.resolver() // fresh per render pass: formula and rollup results are cached for one generation only

  useEffect(() => {
    setPersonalState(view ? loadPersonal(view.id) : null)
  }, [view?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: Event) => setEditWf({ propertyId: (e as CustomEvent<string>).detail })
    window.addEventListener('db-edit-actions', h)
    return () => window.removeEventListener('db-edit-actions', h)
  }, [])

  const notify = useCallback((msg: string, action?: { label: string; run: () => void }) => showToast(msg, undefined, action), [])

  const src = view?.sourceId ? svc.state.get('source', view.sourceId) : null
  const caps = src ? svc.access().sourceCaps(svc.principalId, src.id) : new Set<string>()
  const canSchema = src
    ? caps.has('edit_schema')
    : svc.access().isOwner(svc.principalId) || container.sourceLinks.some((link) => svc.access().sourceCaps(svc.principalId, link.sourceId).has('edit_schema'))
  const canEditRows = caps.has('edit_rows')

  const setPersonal = (p: Personal | null) => {
    const next = !p || (p.filter === undefined && p.sorts === undefined) ? null : p
    setPersonalState(next)
    if (view) savePersonal(view.id, next)
  }
  const nav: DbNav = {
    openRow: (id, mode = 'side') => (mode === 'full' ? onOpenPage(id) : setPeek({ id, mode })),
    runButton: (row, def) => void runButton(svc, row, def, notify),
    toast: (m) => notify(m),
  }
  const ctl: ViewCtl = {
    patch: async (config) => {
      if (!view) return false
      const r = await svc.tryExec([{ type: 'view.patch', payload: { viewId: view.id, configurationPatch: config as Record<string, Json> } }])
      if (!r.ok) notify(errorText(r.code, r.message))
      return r.ok
    },
    personal,
    setPersonal,
    openFilterFor: (propertyId) => {
      if (!view) return
      setPersonal({ ...(personal ?? {}), filter: addRule(personal?.filter !== undefined ? personal.filter : view.filter, svc, propertyId) })
      setPanel({ kind: 'filter', rect: filterBtn.current?.getBoundingClientRect() ?? new DOMRect(200, 120, 10, 10) })
    },
    search,
    rs: rsRef.current,
    notice: notify,
    canSchema,
    canEditRows,
    openProperties: () => setPanel({ kind: 'props', rect: moreBtn.current?.getBoundingClientRect() ?? new DOMRect(300, 140, 10, 10) }),
    createRow: async (o?: CreateRowOpts) => {
      if (!view?.sourceId) return null
      const r = await svc.tryExec([
        {
          type: 'row.create',
          payload: {
            sourceId: view.sourceId,
            viewId: view.id,
            title: o?.title,
            explicitValues: o?.explicitValues,
            context: o?.context,
            parentItemId: o?.parentItemId ?? null,
            beforePageId: o?.beforePageId ?? null,
          } as unknown as Json,
        },
      ])
      if (!r.ok) {
        notify(errorText(r.code, r.message))
        return null
      }
      const pageId = (r.result as { pageId: Id }).pageId
      const row = svc.state.row(pageId)
      const filter = personal?.filter !== undefined ? personal.filter : view.filter
      let inView = true
      try {
        inView = !row || matchesFilter(svc.state, svc.resolver(), filter, row, svc.now(), svc.zone)
      } catch {
        inView = true
      }
      if (!inView) notify(t('Saved; this item is outside the current view.'), { label: t('Show it'), run: () => nav.openRow(pageId, 'side') })
      return { pageId, inView }
    },
  }
  const io = useImportExport({ svc, container, source: src?.id ?? null, view: view ?? ({ id: '', filter: null, sorts: [], configuration: {} } as unknown as View), notify, canSchema })

  if (!view) return <ViewMessage title={t('This database has no views.')} />
  const ViewComp = VIEWS[view.type] ?? TableView
  const sources = container.sourceLinks.map((l) => svc.state.get('source', l.sourceId)).filter((s): s is NonNullable<typeof s> => !!s && s.deletedAt === null)
  const effFilter: Filter | null = personal?.filter !== undefined ? personal.filter : view.filter
  const effSorts: Sort[] = personal?.sorts ?? view.sorts
  const unsaved = !!personal && (personal.filter !== undefined || personal.sorts !== undefined)
  const group = (view.configuration as { group?: GroupConfig }).group ?? null
  const groupDef = group ? svc.state.prop(group.propertyId) : undefined
  const ruleCount = filterRuleCount(effFilter)
  const openPanel = (kind: PanelKind, el: HTMLElement) => setPanel({ kind, rect: el.getBoundingClientRect() })
  const showsItems = FILTERED.includes(view.type)

  const newRow = () => void ctl.createRow({ edit: true }).then((r) => r && nav.openRow(r.pageId, 'side'))
  const templates = src ? svc.state.live('template').filter((tp) => tp.sourceId === src.id) : []
  const templateItems = (): MenuItem[] => [
    { kind: 'head', label: 'New with template' },
    { label: 'Blank', icon: <Icon name="file" size={16} />, onSelect: newRow },
    ...templates.map(
      (tp): MenuItem => ({
        label: tp.name || t('Untitled template'),
        raw: true,
        icon: <Icon name="templates" size={16} />,
        hint: view.defaultTemplateId === tp.id ? t('view default') : src?.defaultTemplateId === tp.id ? t('default') : undefined,
        onSelect: async () => {
          const r = await svc.tryExec([{ type: 'row.create', payload: { sourceId: src!.id, templateId: tp.id, viewId: view.id } }])
          if (r.ok) nav.openRow((r.result as { pageId: Id }).pageId, 'side')
          else notify(errorText(r.code, r.message))
        },
      }),
    ),
    ...(canSchema
      ? ([
          { kind: 'sep' },
          {
            label: 'New template…',
            icon: <Icon name="plus" size={16} />,
            onSelect: async () => {
              const name = await promptDialog({ title: t('New template'), message: t('Name'), initial: '' })
              if (name === null || name === undefined || !src) return
              const r = await svc.tryExec([
                {
                  type: 'record.put',
                  payload: { kind: 'template', body: { sourceId: src.id, name: name || t('Untitled template'), icon: null, cover: null, defaults: {}, body: null, nested: [], repeat: null, scheduleVersion: 1 } },
                },
              ])
              if (r.ok) notify(t('Template created. Open an item and use “Save as template” to fill it.'))
            },
          },
        ] as MenuItem[])
      : []),
  ]
  const run = async (cmds: { type: string; payload: Json }[]) => {
    const r = await svc.tryExec(cmds)
    if (!r.ok) notify(errorText(r.code, r.message))
    return r
  }
  const viewItems = (v: View): MenuItem[] => [
    {
      label: 'Rename',
      icon: <Icon name="pencil" size={16} />,
      disabled: !canSchema,
      onSelect: async () => {
        const n = await promptDialog({ title: t('Rename view'), message: t('Name'), initial: v.name })
        if (n) await run([{ type: 'view.patch', payload: { viewId: v.id, name: n } }])
      },
    },
    {
      label: 'Duplicate',
      icon: <Icon name="copy" size={16} />,
      disabled: !canSchema,
      onSelect: async () => {
        const r = await run([{ type: 'view.duplicate', payload: { viewId: v.id } }])
        if (r.ok) setActiveId((r.result as { viewId: Id }).viewId)
      },
    },
    {
      label: 'Copy link to view',
      icon: <Icon name="link" size={16} />,
      onSelect: () => {
        void navigator.clipboard?.writeText(`noviq://view/${v.id}`)
        notify(t('Link copied'))
      },
    },
    { kind: 'sep' },
    {
      label: 'Delete view',
      icon: <Icon name="trash" size={16} />,
      danger: true,
      disabled: !canSchema || views.length < 2,
      onSelect: async () => {
        if (!(await confirmDialog({ title: t('Delete the view “{n}”?', { n: v.name }), message: t('Only the view is removed; the data stays.'), danger: true, confirmLabel: t('Delete') }))) return
        const r = await run([{ type: 'view.delete', payload: { viewId: v.id } }])
        if (r.ok) setActiveId(views.find((x) => x.id !== v.id)!.id)
      },
    },
  ]
  const moreItems = (): MenuItem[] => [
    { label: 'View settings…', icon: <Icon name="settings" size={16} />, onSelect: () => moreBtn.current && openPanel('settings', moreBtn.current) },
    ...(src ? [{ label: 'Buttons and automations…', icon: <Icon name="repeat" size={16} />, onSelect: () => moreBtn.current && openPanel('workflows', moreBtn.current) } as MenuItem] : []),
    ...(sources.length > 1 || canSchema
      ? [
          {
            label: 'Data source',
            icon: <Icon name="layers" size={16} />,
            items: [
              ...sources.map(
                (s): MenuItem => ({
                  label: s.name,
                  raw: true,
                  checked: s.id === src?.id,
                  onSelect: () => {
                    const target = views.find((v) => v.sourceId === s.id)
                    if (target) setActiveId(target.id)
                  },
                }),
              ),
              ...(canSchema
                ? ([
                    { kind: 'sep' },
                    {
                      label: 'Add a source…',
                      icon: <Icon name="plus" size={16} />,
                      onSelect: async () => {
                        const name = await promptDialog({ title: t('New data source'), message: t('Name'), initial: '' })
                        if (!name) return
                        const r = await run([{ type: 'source.create', payload: { ownerContainerId: container.id, name } }])
                        if (r.ok) setActiveId((r.result as { viewId: Id }).viewId)
                      },
                    },
                  ] as MenuItem[])
                : []),
            ],
          } as MenuItem,
        ]
      : []),
    { kind: 'sep' },
    ...io.items,
  ]

  const conditions: ReactNode[] = []
  if (showsItems) {
    for (const line of describeFilter(svc, effFilter)) conditions.push(<span key={'f' + conditions.length}>{line}</span>)
    for (const s of effSorts) {
      const d = svc.state.prop(s.propertyId)
      if (d) conditions.push(<span key={'s' + s.propertyId}>{t(s.direction === 'asc' ? '{n}, ascending' : '{n}, descending', { n: d.name })}</span>)
    }
  }

  return (
    <NavContext.Provider value={nav}>
      <section className="dv" data-inline={inline || undefined} aria-label={container.title || t('Database')} data-view={view.type}>
        <header className="dv-bar">
          <div className="dv-views" role="tablist" aria-label={t('Views')}>
            {views.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={v.id === view.id}
                className="dv-view-tab"
                title={v.name}
                onClick={(e) => (v.id === view.id ? openMenu(viewItems(v), e.currentTarget) : setActiveId(v.id))}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(viewItems(v), e)
                }}
              >
                <ViewIcon type={v.type} size={16} />
                <span dir="auto">{v.name}</span>
                {v.id === view.id && <Icon name="chevron-down" size={14} className="dv-view-caret" />}
              </button>
            ))}
            {canSchema && (
              <IconButton label={t('Add a view')} onClick={(e) => openPanel('newview', e.currentTarget)}>
                <Icon name="plus" size={16} />
              </IconButton>
            )}
          </div>
          <div className="dv-tools" role="toolbar" aria-label={t('Database tools')}>
            {view.type !== 'dashboard' &&
              (searchOpen || search ? (
                <SearchField
                  className="dv-search"
                  autoFocus
                  value={search}
                  onChange={(v) => (setSearch(v), !v && setSearchOpen(false))}
                  label={t('Search this database')}
                  placeholder={t('Search…')}
                  clearLabel={t('Clear search')}
                />
              ) : (
                <IconButton label={t('Search')} onClick={() => setSearchOpen(true)}>
                  <Icon name="search" size={16} />
                </IconButton>
              ))}
            {showsItems && src && (
              <>
                <ChipButton ref={filterBtn} icon={<Icon name="filter" size={14} />} aria-pressed={ruleCount > 0} onClick={(e) => openPanel('filter', e.currentTarget)}>
                  {ruleCount ? t('Filter · {n}', { n: ruleCount }) : t('Filter')}
                </ChipButton>
                <ChipButton icon={<Icon name="sort" size={14} />} aria-pressed={effSorts.length > 0} onClick={(e) => openPanel('sort', e.currentTarget)}>
                  {effSorts.length ? t('Sort · {n}', { n: effSorts.length }) : t('Sort')}
                </ChipButton>
                {GROUPED.includes(view.type) && (
                  <ChipButton icon={<Icon name="layers" size={14} />} aria-pressed={!!groupDef} onClick={(e) => openPanel('group', e.currentTarget)}>
                    {groupDef ? <span dir="auto">{t('Group · {n}', { n: groupDef.name })}</span> : t('Group')}
                  </ChipButton>
                )}
                <IconButton label={t('Properties')} onClick={(e) => openPanel('props', e.currentTarget)}>
                  <Icon name="eye" size={16} />
                </IconButton>
              </>
            )}
            <IconButton ref={moreBtn} label={t('More')} onClick={(e) => openMenu(moreItems(), e.currentTarget)}>
              <Icon name="more-horizontal" size={16} />
            </IconButton>
            {canEditRows && view.type !== 'form' && view.type !== 'chart' && view.type !== 'dashboard' && (
              <div className="ds-split dv-new">
                <Button variant="primary" size="sm" icon={<Icon name="plus" size={15} />} onClick={newRow}>
                  {t('New')}
                </Button>
                <Button variant="primary" size="sm" aria-label={t('Choose a template')} title={t('Choose a template')} onClick={(e) => openMenu(templateItems(), e.currentTarget)}>
                  <Icon name="chevron-down" size={15} />
                </Button>
              </div>
            )}
          </div>
        </header>
        {(conditions.length > 0 || unsaved) && (
          <div className="dv-conditions" role="status">
            {conditions.length > 0 && <span className="dv-conditions-list">{conditions}</span>}
            {unsaved && (
              <span className="dv-conditions-note">
                {t('Only you see these changes.')}
                {canSchema && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const r = await svc.tryExec([{ type: 'view.patch', payload: { viewId: view.id, filter: (effFilter as never) ?? null, sorts: effSorts as never } }])
                      if (r.ok) setPersonal(null)
                      else notify(errorText(r.code, r.message))
                    }}
                  >
                    {t('Save for everyone')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setPersonal(null)}>
                  {t('Reset')}
                </Button>
              </span>
            )}
          </div>
        )}
        <div className="dv-body">
          <Suspense
            fallback={
              <div className="dv-loading" role="status">
                {t('Loading view…')}
              </div>
            }
          >
            <ViewComp svc={svc} view={view} container={container} ctl={ctl} />
          </Suspense>
        </div>
        {panel?.kind === 'filter' && src && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)}>
            <Panel
              size="lg"
              title={t('Filter')}
              actions={
                effFilter && (
                  <Button size="sm" variant="ghost" onClick={() => setPersonal({ ...(personal ?? {}), filter: null })}>
                    {t('Clear all')}
                  </Button>
                )
              }
            >
              <FilterEditor svc={svc} sourceId={src.id} filter={effFilter} onChange={(f) => setPersonal({ ...(personal ?? {}), filter: f })} />
            </Panel>
          </Popover>
        )}
        {panel?.kind === 'sort' && src && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)}>
            <Panel
              size="lg"
              title={t('Sort')}
              actions={
                effSorts.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setPersonal({ ...(personal ?? {}), sorts: [] })}>
                    {t('Clear all')}
                  </Button>
                )
              }
            >
              <SortEditor svc={svc} sourceId={src.id} sorts={effSorts} onChange={(s) => setPersonal({ ...(personal ?? {}), sorts: s })} />
            </Panel>
          </Popover>
        )}
        {panel?.kind === 'group' && src && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)}>
            <Panel size="sm" title={t('Group')}>
              <GroupEditor svc={svc} sourceId={src.id} group={group} onChange={(g) => void ctl.patch({ group: g as Json })} />
            </Panel>
          </Popover>
        )}
        {panel?.kind === 'props' && src && <PropertiesPanel svc={svc} view={view} anchor={panel.rect} onClose={() => setPanel(null)} ctl={ctl} />}
        {panel?.kind === 'settings' && src && <ViewSettings svc={svc} view={view} anchor={panel.rect} onClose={() => setPanel(null)} ctl={ctl} />}
        {panel?.kind === 'settings' && !src && view.type === 'dashboard' && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)} align="end">
            <Panel size="sm" title={t('View settings')}>
              <Hint>{t('A dashboard is arranged with Edit dashboard.')}</Hint>
            </Panel>
          </Popover>
        )}
        {panel?.kind === 'newview' && (
          <NewViewPanel
            svc={svc}
            container={container}
            anchor={panel.rect}
            onClose={() => setPanel(null)}
            onCreated={setActiveId}
            source={src?.id ?? sources[0]?.id ?? null}
            sources={sources.map((s) => ({ id: s.id, name: s.name }))}
          />
        )}
        {panel?.kind === 'workflows' && src && <WorkflowPanel svc={svc} sourceId={src.id} anchor={panel.rect} onClose={() => setPanel(null)} notify={notify} focusProperty={null} />}
        {editWf && src && <WorkflowPanel svc={svc} sourceId={src.id} anchor={moreBtn.current?.getBoundingClientRect() ?? new DOMRect(280, 160, 10, 10)} onClose={() => setEditWf(null)} notify={notify} focusProperty={editWf.propertyId} />}
        {peek && (
          <RowPeek
            pageId={peek.id}
            mode={peek.mode}
            onClose={() => setPeek(null)}
            onOpenFull={(id) => (setPeek(null), onOpenPage(id))}
            onSwitch={(m) => setPeek({ id: peek.id, mode: m })}
          />
        )}
        {menu}
        {io.ui}
      </section>
    </NavContext.Provider>
  )
}

function addRule(current: Filter | null, svc: DatabaseService, propertyId: Id): Filter {
  void svc
  const rule: Filter = { kind: 'predicate', propertyId, op: 'is_not_empty' }
  if (!current) return { kind: 'and', children: [rule] }
  if (current.kind === 'predicate') return { kind: 'and', children: [current, rule] }
  return { ...current, children: [...current.children, rule] }
}

async function runButton(svc: DatabaseService, row: Parameters<DbNav['runButton']>[0], def: Definition, notify: (m: string) => void) {
  const wf = svc.state.live('workflow').find((w) => w.kind === 'button' && w.propertyId === def.id)
  if (!wf) return notify(t('This button has no actions yet.'))
  const pre = svc.engine.preview(wf.id, row.page.id)
  let confirmed = true
  if (pre.confirmations.length) {
    confirmed = await confirmDialog({ title: pre.confirmations[0].title, message: pre.confirmations.map((c) => c.message).join('\n'), confirmLabel: t('Run') })
    if (!confirmed) return
  }
  let approve = false
  if (pre.needsApproval) {
    approve = await confirmDialog({ title: t('This changes {n} items', { n: pre.rowMutations }), message: t('Run it on all of them?'), confirmLabel: t('Run'), danger: true })
    if (!approve) return
  }
  try {
    const res = await svc.engine.run(wf.id, { kind: 'button', pageId: row.page.id, eventId: `click:${row.page.id}:${Math.floor(Date.now() / 1500)}`, actorId: svc.principalId, confirmed, approve })
    if (res.state === 'failed') notify(res.error ?? t('The button failed.'))
    else if (res.state === 'queued') notify(t('Done. External messages are queued and will be sent shortly.'))
    for (const u of res.ui ?? []) if (u.url && /^https?:/.test(u.url)) window.open(u.url, '_blank', 'noopener,noreferrer')
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e))
  }
}

/** Which properties this view shows and in what order: one row each, the eye to show or hide, arrows to move. */
function PropertiesPanel({ svc, view, anchor, onClose, ctl }: { svc: DatabaseService; view: View; anchor: DOMRect; onClose: () => void; ctl: ViewCtl }) {
  const all = svc.state.props(view.sourceId!).filter((p) => svc.access().canReadProperty(svc.principalId, p))
  const cfg = view.configuration as { visibleProperties?: Id[] }
  const visible = cfg.visibleProperties ?? all.map((p) => p.id)
  const order = [...visible.filter((id) => all.some((a) => a.id === id)), ...all.map((p) => p.id).filter((id) => !visible.includes(id))]
  const set = (ids: Id[]) => void ctl.patch({ visibleProperties: ids })
  const [newRect, setNewRect] = useState<DOMRect | null>(null)
  const shown = order.filter((id) => visible.includes(id)).length
  return (
    <Popover anchor={anchor} onClose={onClose} align="end">
      <Panel
        title={t('Properties')}
        actions={<span className="dv-hint">{t('{n} of {m} shown', { n: shown, m: all.length })}</span>}
        footer={
          <>
            <Button size="sm" variant="ghost" className="ds-panel-foot-start" onClick={() => set(all.map((p) => p.id))}>
              {t('Show all')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => set(all.filter((p) => p.kind === 'title').map((p) => p.id))}>
              {t('Hide all')}
            </Button>
            {ctl.canSchema && (
              <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={(e) => setNewRect(e.currentTarget.getBoundingClientRect())}>
                {t('New property')}
              </Button>
            )}
          </>
        }
      >
        <div className="dv-proplist">
          {order.map((id, i) => {
            const d = all.find((p) => p.id === id)!
            const on = visible.includes(id)
            return (
              <div className="dv-proprow" key={id} data-off={!on || undefined}>
                <KindIcon kind={d.kind} />
                <span className="dv-proprow-name" dir="auto">
                  {d.name}
                </span>
                <IconButton
                  label={t('Move up')}
                  disabled={i === 0}
                  onClick={() => {
                    const n = [...order]
                    ;[n[i - 1], n[i]] = [n[i], n[i - 1]]
                    set(n.filter((x) => visible.includes(x) || x === id))
                  }}
                >
                  <Icon name="arrow-up" size={15} />
                </IconButton>
                <IconButton label={on ? t('Hide {n}', { n: d.name }) : t('Show {n}', { n: d.name })} pressed={on} disabled={d.kind === 'title'} onClick={() => set(on ? visible.filter((x) => x !== id) : [...visible, id])}>
                  <Icon name={on ? 'eye' : 'eye-off'} size={16} />
                </IconButton>
              </div>
            )
          })}
        </div>
        {newRect && <NewPropertyPopover svc={svc} sourceId={view.sourceId!} anchor={newRect} onClose={() => setNewRect(null)} onCreated={(id) => set([...visible, id])} />}
      </Panel>
    </Popover>
  )
}

/** Add a view: every layout with one line on what it is for, and the data source when there are several. */
function NewViewPanel({
  svc,
  container,
  anchor,
  onClose,
  onCreated,
  source,
  sources,
}: {
  svc: DatabaseService
  container: Container
  anchor: DOMRect
  onClose: () => void
  onCreated: (id: Id) => void
  source: Id | null
  sources: { id: Id; name: string }[]
}) {
  const [src, setSrc] = useState(source)
  const [err, setErr] = useState<string | null>(null)
  const types = Object.keys(VIEW_LABEL) as ViewType[]
  const create = async (type: ViewType) => {
    const r = await svc.tryExec([{ type: 'view.create', payload: { containerId: container.id, sourceId: type === 'dashboard' ? null : src, type, name: t(VIEW_LABEL[type]) } }])
    if (r.ok) {
      onCreated((r.result as { viewId: Id }).viewId)
      onClose()
    } else setErr(errorText(r.code, r.message))
  }
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <Panel title={t('Add a view')}>
        {sources.length > 1 && (
          <FormField label={t('Data source')}>
            <Dropdown label={t('Data source')} value={src ?? ''} onChange={setSrc} options={rawOptions(sources)} />
          </FormField>
        )}
        <div className="dv-viewtypes" role="menu" aria-label={t('Layout')}>
          {types.map((ty) => (
            <button key={ty} type="button" role="menuitem" className="ds-menu-item dv-viewtype" onClick={() => void create(ty)}>
              <ViewIcon type={ty} size={18} />
              <span className="dv-viewtype-text">
                <b>{t(VIEW_LABEL[ty])}</b>
                <small>{t(VIEW_HINT[ty])}</small>
              </span>
            </button>
          ))}
        </div>
        {err && <ErrorLine>{err}</ErrorLine>}
      </Panel>
    </Popover>
  )
}
