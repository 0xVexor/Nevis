import { setPreference, removePreference } from '../../preferenceEvents'
// A database as the user sees it: title, source selector, view tabs, search / filter / sort / group / properties / settings,
// the active view, row peek, notices. It owns the viewer's unsaved ("personal") filter and sort overrides.
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import type { Container, Definition, Filter, Id, Json, Sort, View, ViewType } from '../model/types.ts'
import { matchesFilter } from '../query/engine.ts'
import type { DatabaseService } from '../service.ts'
import { Popover, MenuItem, MenuLabel, MenuSep, Select } from '../../ui'
import { confirmDialog, promptDialog } from '../../dialog'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { NavContext, type DbNav } from './CellView'
import { KindIcon, errorText, useDb, useRepoTick } from './common'
import { FilterEditor, GroupEditor, SortEditor, type GroupConfig } from './ViewControls'
import { NewPropertyPopover } from './PropertyEditor'
import { TableView } from './TableView'
import type { CreateRowOpts, ViewCtl, ViewProps } from './viewTypes'
import type { Personal } from './useViewQuery'
import { RowPeek } from './RowPeek'
import { ViewSettings } from './ViewSettings'
import { ImportExportMenu } from './ImportExport'
import { VIEW_ICON, VIEW_LABEL } from './viewMeta'
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

const personalKey = (id: Id) => 'db.personal.' + id
function loadPersonal(id: Id): Personal | null {
  try { const v = localStorage.getItem(personalKey(id)); return v ? JSON.parse(v) : null } catch { return null }
}
function savePersonal(id: Id, p: Personal | null) {
  try { p ? setPreference(personalKey(id), JSON.stringify(p)) : removePreference(personalKey(id)) } catch { /* private window: the override just lives in memory */ }
}

export type OpenPage = (pageId: Id) => void

export function DatabaseContainer({ containerId, viewId, onOpenPage, inline }: { containerId: Id; viewId?: Id | null; onOpenPage: OpenPage; inline?: boolean }) {
  const svc = useDb()
  useRepoTick()
  if (!svc) return <div className="db-loading" role="status">{t('Opening the database…')}</div>
  const c = svc.state.get('container', containerId)
  if (!c || c.deletedAt !== null) return <div className="db-error-box">{t('This database no longer exists.')}</div>
  return <Inner svc={svc} container={c} fixedViewId={viewId ?? null} onOpenPage={onOpenPage} inline={!!inline} />
}

function Inner({ svc, container, fixedViewId, onOpenPage, inline }: { svc: DatabaseService; container: Container; fixedViewId: Id | null; onOpenPage: OpenPage; inline: boolean }) {
  const views = svc.state.viewsOf(container.id).filter((v) => v.parentDashboardId === null)
  const [activeId, setActiveId] = useState<Id | null>(fixedViewId)
  const view: View | undefined = views.find((v) => v.id === (fixedViewId ?? activeId)) ?? views[0]
  const [personal, setPersonalState] = useState<Personal | null>(() => (view ? loadPersonal(view.id) : null))
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [panel, setPanel] = useState<null | { kind: 'filter' | 'sort' | 'group' | 'props' | 'settings' | 'new' | 'newview' | 'more' | 'viewmenu' | 'workflows' | 'source'; rect: DOMRect; arg?: string }>(null)
  const [notice, setNotice] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null)
  const [peek, setPeek] = useState<{ id: Id; mode: 'side' | 'center' } | null>(null)
  const [editWf, setEditWf] = useState<{ propertyId: Id } | null>(null)
  const noticeTimer = useRef(0)
  const rsRef = useRef(svc.resolver())
  rsRef.current = svc.resolver() // fresh per render pass: formula and rollup results are cached for one generation only

  useEffect(() => { setPersonalState(view ? loadPersonal(view.id) : null) }, [view?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: Event) => setEditWf({ propertyId: (e as CustomEvent<string>).detail })
    window.addEventListener('db-edit-actions', h)
    return () => window.removeEventListener('db-edit-actions', h)
  }, [])

  const notify = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    setNotice({ msg, action })
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), action ? 8000 : 4500)
  }, [])

  const src = view?.sourceId ? svc.state.get('source', view.sourceId) : null
  const caps = src ? svc.access().sourceCaps(svc.principalId, src.id) : new Set<string>()
  const canSchema = src ? caps.has('edit_schema') : svc.access().isOwner(svc.principalId) || container.sourceLinks.some((link) => svc.access().sourceCaps(svc.principalId, link.sourceId).has('edit_schema'))
  const canEditRows = caps.has('edit_rows')

  const setPersonal = (p: Personal | null) => {
    const empty = !p || (p.filter === undefined && p.sorts === undefined) || (p.filter === null && p.sorts === null && false)
    const next = empty ? null : p
    setPersonalState(next)
    if (view) savePersonal(view.id, next)
  }
  const ctl: ViewCtl = {
    patch: async (config) => {
      if (!view) return false
      const r = await svc.tryExec([{ type: 'view.patch', payload: { viewId: view.id, configurationPatch: config as Record<string, Json> } }])
      if (!r.ok) notify(errorText(r.code, r.message))
      return r.ok
    },
    personal, setPersonal,
    openFilterFor: (propertyId) => {
      const p = view ? { ...(personal ?? {}), filter: addRule(personal?.filter !== undefined ? personal.filter : view.filter, svc, propertyId) } : personal
      setPersonal(p)
      setPanel({ kind: 'filter', rect: document.querySelector<HTMLElement>('[data-db-filter-btn]')?.getBoundingClientRect() ?? new DOMRect(200, 120, 10, 10) })
    },
    search, rs: rsRef.current, notice: notify, canSchema, canEditRows,
    openProperties: () => setPanel({ kind: 'props', rect: new DOMRect(300, 140, 10, 10) }),
    createRow: async (o?: CreateRowOpts) => {
      if (!view?.sourceId) return null
      const r = await svc.tryExec([{ type: 'row.create', payload: { sourceId: view.sourceId, viewId: view.id, title: o?.title, explicitValues: o?.explicitValues, context: o?.context, parentItemId: o?.parentItemId ?? null, beforePageId: o?.beforePageId ?? null } as unknown as Json }])
      if (!r.ok) { notify(errorText(r.code, r.message)); return null }
      const pageId = (r.result as { pageId: Id }).pageId
      const row = svc.state.row(pageId)
      const filter = personal?.filter !== undefined ? personal.filter : view.filter
      let inView = true
      try { inView = !row || matchesFilter(svc.state, svc.resolver(), filter, row, svc.now(), svc.zone) } catch { inView = true }
      if (!inView) notify(t('Saved; this item is outside the current view.'), { label: t('Show it'), run: () => nav.openRow(pageId, 'side') })
      return { pageId, inView }
    },
  }

  const nav: DbNav = {
    openRow: (id, mode = 'side') => (mode === 'full' ? onOpenPage(id) : setPeek({ id, mode })),
    runButton: (row, def) => void runButton(svc, row, def, notify),
    toast: notify,
  }

  if (!view) return <div className="db-error-box">{t('This database has no views.')}</div>
  const View = VIEWS[view.type] ?? TableView
  const sources = container.sourceLinks.map((l) => svc.state.get('source', l.sourceId)).filter((s): s is NonNullable<typeof s> => !!s && s.deletedAt === null)
  const saveFilterFor = personal && (personal.filter !== undefined || personal.sorts !== undefined)
  const filterActive = (personal?.filter !== undefined ? personal.filter : view.filter) !== null
  const sortActive = ((personal?.sorts ?? view.sorts).length ?? 0) > 0
  const group = (view.configuration as { group?: GroupConfig }).group ?? null

  const openPanel = (kind: NonNullable<typeof panel>['kind'], e: React.MouseEvent, arg?: string) => setPanel({ kind, rect: e.currentTarget.getBoundingClientRect(), arg })
  const effFilter: Filter | null = personal?.filter !== undefined ? personal.filter : view.filter
  const effSorts: Sort[] = personal?.sorts ?? view.sorts

  return (
    <NavContext.Provider value={nav}>
      <section className={'db' + (inline ? ' inline' : '')} aria-label={container.title || t('Database')} data-view={view.type}>
        <header className="db-head">
          <div className="db-tabs" role="tablist" aria-label={t('Views')}>
            {views.map((v) => (
              <button key={v.id} type="button" role="tab" aria-selected={v.id === view.id} className={'db-tab' + (v.id === view.id ? ' on' : '')} onClick={(e) => (v.id === view.id ? canSchema && openPanel('viewmenu', e, v.id) : setActiveId(v.id))} onContextMenu={(e) => { e.preventDefault(); openPanel('viewmenu', e, v.id) }}>
                {VIEW_ICON[v.type]()} <span dir="auto">{v.name}</span>
              </button>
            ))}
            {canSchema && <button type="button" className="db-tab add" aria-label={t('Add a view')} onClick={(e) => openPanel('newview', e)}><Ic.Plus size={13} /></button>}
          </div>
          {sources.length > 1 && (
            <button type="button" className="db-src" onClick={(e) => openPanel('source', e)} title={t('Data source')}><Ic.Layers size={13} /> <span dir="auto">{src?.name}</span> <Ic.Chevron size={11} /></button>
          )}
        </header>
        {view.type !== 'dashboard' && (
          <div className="db-toolbar" role="toolbar" aria-label={t('Database tools')}>
            <div className="db-tools">
              {searchOpen || search ? (
                <span className="db-search"><Ic.Search size={13} /><input autoFocus dir="auto" value={search} placeholder={t('Search…')} aria-label={t('Search this database')} onChange={(e) => setSearch(e.target.value)} onBlur={() => !search && setSearchOpen(false)} onKeyDown={(e) => e.key === 'Escape' && (setSearch(''), setSearchOpen(false))} /></span>
              ) : (
                <button type="button" className="db-tool" aria-label={t('Search')} onClick={() => setSearchOpen(true)}><Ic.Search size={14} /></button>
              )}
              {['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'feed'].includes(view.type) && (
                <>
                  <button type="button" data-db-filter-btn className={'db-tool' + (filterActive ? ' on' : '')} onClick={(e) => openPanel('filter', e)}><Ic.Search size={13} /> {t('Filter')}{filterActive && <span className="db-dot" />}</button>
                  <button type="button" className={'db-tool' + (sortActive ? ' on' : '')} onClick={(e) => openPanel('sort', e)}><Ic.UpDown size={13} /> {t('Sort')}{sortActive && <span className="db-dot" />}</button>
                  {['table', 'list', 'gallery'].includes(view.type) && <button type="button" className={'db-tool' + (group ? ' on' : '')} onClick={(e) => openPanel('group', e)}><Ic.Layers size={13} /> {t('Group')}</button>}
                  <button type="button" className="db-tool" onClick={(e) => openPanel('props', e)}><Ic.Eye size={13} /> {t('Properties')}</button>
                </>
              )}
              <button type="button" className="db-tool" aria-label={t('View settings')} onClick={(e) => openPanel('settings', e)}><Ic.Settings size={14} /></button>
              <button type="button" className="db-tool" aria-label={t('Automations')} title={t('Buttons and automations')} onClick={(e) => openPanel('workflows', e)}><Ic.Flag size={14} /></button>
              <button type="button" className="db-tool" aria-label={t('More')} onClick={(e) => openPanel('more', e)}><Ic.Dots size={14} /></button>
            </div>
            {canEditRows && view.type !== 'form' && view.type !== 'chart' && (
              <div className="db-newbtn">
                <button type="button" className="primary" onClick={() => void ctl.createRow({ edit: true }).then((r) => r && nav.openRow(r.pageId, 'side'))}><Ic.Plus size={13} /> {t('New')}</button>
                <button type="button" className="primary caret" aria-label={t('Choose a template')} onClick={(e) => openPanel('new', e)}><Ic.Chevron size={11} /></button>
              </div>
            )}
          </div>
        )}
        {saveFilterFor && (
          <div className="db-personal" role="status">
            <span>{t('You changed the filter or sort. Only you see this until you save it.')}</span>
            {canSchema && <button type="button" onClick={async () => {
              const r = await svc.tryExec([{ type: 'view.patch', payload: { viewId: view.id, filter: (effFilter as never) ?? null, sorts: effSorts as never } }])
              if (r.ok) setPersonal(null)
              else notify(errorText(r.code, r.message))
            }}>{t('Save for everyone')}</button>}
            <button type="button" onClick={() => setPersonal(null)}>{t('Reset')}</button>
          </div>
        )}
        <div className="db-body">
          <Suspense fallback={<div className="db-loading" role="status">{t('Loading view…')}</div>}>
            <View svc={svc} view={view} container={container} ctl={ctl} />
          </Suspense>
        </div>
        {notice && (
          <div className="db-notice" role="status">
            <span>{notice.msg}</span>
            {notice.action && <button type="button" onClick={() => (notice.action!.run(), setNotice(null))}>{notice.action.label}</button>}
            <button type="button" className="icon-btn" aria-label={t('Close')} onClick={() => setNotice(null)}><Ic.Close size={12} /></button>
          </div>
        )}
        {panel?.kind === 'filter' && src && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)}>
            <div className="db-pop xwide" onClick={(e) => e.stopPropagation()}><FilterEditor svc={svc} sourceId={src.id} filter={effFilter} onChange={(f) => setPersonal({ ...(personal ?? {}), filter: f })} /></div>
          </Popover>
        )}
        {panel?.kind === 'sort' && src && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)}>
            <div className="db-pop db-sort-pop" onClick={(e) => e.stopPropagation()}><SortEditor svc={svc} sourceId={src.id} sorts={effSorts} onChange={(s) => setPersonal({ ...(personal ?? {}), sorts: s })} /></div>
          </Popover>
        )}
        {panel?.kind === 'group' && src && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)}>
            <div className="db-pop wide" onClick={(e) => e.stopPropagation()}><GroupEditor svc={svc} sourceId={src.id} group={group} onChange={(g) => void ctl.patch({ group: g as Json })} /></div>
          </Popover>
        )}
        {panel?.kind === 'props' && src && <PropertiesPopover svc={svc} view={view} anchor={panel.rect} onClose={() => setPanel(null)} ctl={ctl} />}
        {panel?.kind === 'settings' && src && <ViewSettings svc={svc} view={view} anchor={panel.rect} onClose={() => setPanel(null)} ctl={ctl} />}
        {panel?.kind === 'new' && src && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)} align="end">
            <div className="ds-menu">
              <MenuLabel>{t('New with template')}</MenuLabel>
              <MenuItem label={t('Blank')} onClick={() => (setPanel(null), void ctl.createRow({ edit: true }).then((r) => r && nav.openRow(r.pageId, 'side')))} />
              {svc.state.live('template').filter((tp) => tp.sourceId === src.id).map((tp) => (
                <MenuItem key={tp.id} label={tp.name || t('Untitled template')} hint={view.defaultTemplateId === tp.id ? t('view default') : src.defaultTemplateId === tp.id ? t('default') : undefined} onClick={async () => {
                  setPanel(null)
                  const r = await svc.tryExec([{ type: 'row.create', payload: { sourceId: src.id, templateId: tp.id, viewId: view.id } }])
                  if (r.ok) nav.openRow((r.result as { pageId: Id }).pageId, 'side')
                  else notify(errorText(r.code, r.message))
                }} />
              ))}
              {canSchema && <MenuSep />}
              {canSchema && <MenuItem icon={<Ic.Plus size={13} />} label={t('New template…')} onClick={async () => {
                setPanel(null)
                const name = await promptDialog({ title: t('New template'), message: t('Name'), initial: '' })
                if (name === null || name === undefined) return
                const r = await svc.tryExec([{ type: 'record.put', payload: { kind: 'template', body: { sourceId: src.id, name: name || t('Untitled template'), icon: null, cover: null, defaults: {}, body: null, nested: [], repeat: null, scheduleVersion: 1 } } }])
                if (r.ok) notify(t('Template created. Open an item and use “Save as template” to fill it.'))
              }} />}
            </div>
          </Popover>
        )}
        {panel?.kind === 'newview' && <NewViewMenu svc={svc} container={container} anchor={panel.rect} onClose={() => setPanel(null)} onCreated={setActiveId} source={src?.id ?? sources[0]?.id ?? null} sources={sources.map((s) => ({ id: s.id, name: s.name }))} />}
        {panel?.kind === 'viewmenu' && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)}>
            <ViewMenu svc={svc} view={svc.state.get('view', panel.arg!)!} views={views} onClose={() => setPanel(null)} notify={notify} onSelect={setActiveId} canSchema={canSchema} />
          </Popover>
        )}
        {panel?.kind === 'source' && (
          <Popover anchor={panel.rect} onClose={() => setPanel(null)}>
            <div className="ds-menu">
              {sources.map((s) => (
                <MenuItem key={s.id} label={s.name} onClick={() => {
                  setPanel(null)
                  const target = views.find((v) => v.sourceId === s.id)
                  if (target) setActiveId(target.id)
                }} hint={s.id === src?.id ? '✓' : undefined} />
              ))}
              {canSchema && <MenuSep />}
              {canSchema && <MenuItem icon={<Ic.Plus size={13} />} label={t('Add a source…')} onClick={async () => {
                setPanel(null)
                const name = await promptDialog({ title: t('New data source'), message: t('Name'), initial: '' })
                if (!name) return
                const r = await svc.tryExec([{ type: 'source.create', payload: { ownerContainerId: container.id, name } }])
                if (r.ok) setActiveId((r.result as { viewId: Id }).viewId)
                else notify(errorText(r.code, r.message))
              }} />}
            </div>
          </Popover>
        )}
        {panel?.kind === 'more' && src && <ImportExportMenu svc={svc} container={container} source={src.id} view={view} anchor={panel.rect} onClose={() => setPanel(null)} notify={notify} canSchema={canSchema} />}
        {panel?.kind === 'workflows' && src && <WorkflowPanel svc={svc} sourceId={src.id} anchor={panel.rect} onClose={() => setPanel(null)} notify={notify} focusProperty={null} />}
        {editWf && src && <WorkflowPanel svc={svc} sourceId={src.id} anchor={new DOMRect(280, 160, 10, 10)} onClose={() => setEditWf(null)} notify={notify} focusProperty={editWf.propertyId} />}
        {peek && <RowPeek svc={svc} pageId={peek.id} mode={peek.mode} onClose={() => setPeek(null)} onOpenFull={(id) => (setPeek(null), onOpenPage(id))} onSwitch={(m) => setPeek({ id: peek.id, mode: m })} onNavigate={(id) => setPeek({ id, mode: peek.mode })} notify={notify} />}
      </section>
    </NavContext.Provider>
  )
}

function addRule(current: Filter | null, svc: DatabaseService, propertyId: Id): Filter {
  const def = svc.state.prop(propertyId)
  const rule: Filter = { kind: 'predicate', propertyId, op: def && ['multi_select', 'people', 'relation'].includes(def.kind) ? 'is_not_empty' : 'is_not_empty' }
  if (!current) return { kind: 'and', children: [rule] }
  if (current.kind === 'predicate') return { kind: 'and', children: [current, rule] }
  return { ...current, children: [...current.children, rule] }
}

async function runButton(svc: DatabaseService, row: Parameters<DbNav['runButton']>[0], def: Definition, notify: DbNav['toast']) {
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

function PropertiesPopover({ svc, view, anchor, onClose, ctl }: { svc: DatabaseService; view: View; anchor: DOMRect; onClose: () => void; ctl: ViewCtl }) {
  const all = svc.state.props(view.sourceId!).filter((p) => svc.access().canReadProperty(svc.principalId, p))
  const cfg = view.configuration as { visibleProperties?: Id[] }
  const visible = cfg.visibleProperties ?? all.map((p) => p.id)
  const order = [...visible.filter((id) => all.some((a) => a.id === id)), ...all.map((p) => p.id).filter((id) => !visible.includes(id))]
  const set = (ids: Id[]) => void ctl.patch({ visibleProperties: ids })
  const [newRect, setNewRect] = useState<DOMRect | null>(null)
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="db-pop wide" onClick={(e) => e.stopPropagation()}>
        <MenuLabel>{t('Properties shown in this view')}</MenuLabel>
        <div className="db-opts">
          {order.map((id, i) => {
            const d = all.find((p) => p.id === id)!
            const on = visible.includes(id)
            return (
              <div className="db-prop-row" key={id}>
                <button type="button" className="icon-btn" aria-label={on ? t('Hide') : t('Show')} aria-pressed={on} disabled={d.kind === 'title'} onClick={() => set(on ? visible.filter((x) => x !== id) : [...visible, id])}>{on ? <Ic.Eye size={14} /> : <span className="db-eye-off"><Ic.Eye size={14} /></span>}</button>
                <KindIcon kind={d.kind} /> <span className="db-prop-name" dir="auto">{d.name}</span>
                <button type="button" className="icon-btn" aria-label={t('Move up')} disabled={i === 0} onClick={() => { const n = [...order]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set(n.filter((x) => visible.includes(x) || x === id)) }}><Ic.Up size={12} /></button>
              </div>
            )
          })}
        </div>
        <div className="db-date-foot">
          <button type="button" onClick={() => set(all.map((p) => p.id))}>{t('Show all')}</button>
          <button type="button" onClick={() => set(all.filter((p) => p.kind === 'title').map((p) => p.id))}>{t('Hide all')}</button>
          {ctl.canSchema && <button type="button" className="primary" onClick={(e) => setNewRect(e.currentTarget.getBoundingClientRect())}><Ic.Plus size={12} /> {t('New property')}</button>}
        </div>
        {newRect && <NewPropertyPopover svc={svc} sourceId={view.sourceId!} anchor={newRect} onClose={() => setNewRect(null)} onCreated={(id) => set([...visible, id])} />}
      </div>
    </Popover>
  )
}

function NewViewMenu({ svc, container, anchor, onClose, onCreated, source, sources }: { svc: DatabaseService; container: Container; anchor: DOMRect; onClose: () => void; onCreated: (id: Id) => void; source: Id | null; sources: { id: Id; name: string }[] }) {
  const [src, setSrc] = useState(source)
  const [err, setErr] = useState<string | null>(null)
  const types = Object.keys(VIEW_LABEL) as ViewType[]
  const create = async (type: ViewType) => {
    const r = await svc.tryExec([{ type: 'view.create', payload: { containerId: container.id, sourceId: type === 'dashboard' ? null : src, type, name: t(VIEW_LABEL[type]) } }])
    if (r.ok) { onCreated((r.result as { viewId: Id }).viewId); onClose() } else setErr(errorText(r.code, r.message))
  }
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="ds-menu">
        <MenuLabel>{t('Add a view')}</MenuLabel>
        {sources.length > 1 && <div className="db-form"><Select value={src ?? ''} onChange={setSrc} title={t('Data source')} options={sources.map((source) => ({ value: source.id, label: source.name }))} /></div>}
        {types.map((ty) => <MenuItem key={ty} icon={VIEW_ICON[ty]()} label={t(VIEW_LABEL[ty])} onClick={() => void create(ty)} />)}
        {err && <div className="db-err" role="alert">{err}</div>}
      </div>
    </Popover>
  )
}

function ViewMenu({ svc, view, views, onClose, notify, onSelect, canSchema }: { svc: DatabaseService; view: View; views: View[]; onClose: () => void; notify: DbNav['toast']; onSelect: (id: Id) => void; canSchema: boolean }) {
  const run = async (cmds: { type: string; payload: Json }[]) => {
    const r = await svc.tryExec(cmds)
    if (!r.ok) notify(errorText(r.code, r.message))
    return r
  }
  return (
    <div className="ds-menu">
      <MenuItem icon={<Ic.Pencil size={14} />} label={t('Rename')} disabled={!canSchema} onClick={async () => { onClose(); const n = await promptDialog({ title: t('Rename view'), message: t('Name'), initial: view.name }); if (n) await run([{ type: 'view.patch', payload: { viewId: view.id, name: n } }]) }} />
      <MenuItem icon={<Ic.Copy size={14} />} label={t('Duplicate')} disabled={!canSchema} onClick={async () => { onClose(); const r = await run([{ type: 'view.duplicate', payload: { viewId: view.id } }]); if (r.ok) onSelect((r.result as { viewId: Id }).viewId) }} />
      <MenuItem icon={<Ic.Link size={14} />} label={t('Copy link to view')} onClick={() => { onClose(); void navigator.clipboard?.writeText(`noviq://view/${view.id}`); notify(t('Link copied')) }} />
      <MenuSep />
      <MenuItem icon={<Ic.Trash size={14} />} label={t('Delete view')} danger disabled={!canSchema || views.length < 2} onClick={async () => {
        onClose()
        if (!(await confirmDialog({ title: t('Delete the view “{n}”?', { n: view.name }), message: t('Only the view is removed; the data stays.'), danger: true, confirmLabel: t('Delete') }))) return
        const r = await run([{ type: 'view.delete', payload: { viewId: view.id } }])
        if (r.ok) onSelect(views.find((v) => v.id !== view.id)!.id)
      }} />
    </div>
  )
}

