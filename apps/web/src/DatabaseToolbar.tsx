// The toolbar of a database in the old app's frame (`dv-bar`): the views as tabs, then search, Filter, Sort, Group, the properties, "more" and
// "New". Filter, Sort, Group and Properties open small panels; what they set is written to the view's `config` (one op each).
import { useEffect, useState } from 'react'
import { createView, patchViewConfig, readViewConfig, renameView, setViewConfig, trashView, type DatabaseModel, type FilterOp, type FilterRule, type PropType, type PropertyModel, type ViewModel, PROP_TYPES, addProperty } from '@nevis/core'
import { Button, ChipButton, Icon, IconButton, Menu, Panel, Popover, SearchField, type MenuItem } from './ds'
import { t } from './i18n'
import type { Workspace } from './workspace'

const TYPE_LABEL: Record<PropType, string> = { text: 'Text', number: 'Number', date: 'Date', select: 'Select', multiSelect: 'Multi-select', relation: 'Relation', checkbox: 'Checkbox', url: 'URL' }
export const KIND_ICON: Record<PropType, string> = { text: 'type', number: 'hash', date: 'calendar', select: 'list', multiSelect: 'list', relation: 'link', checkbox: 'check', url: 'link' }
/** The conditions each kind of property offers. */
const OPS: Record<PropType, FilterOp[]> = {
  text: ['contains', 'not_contains', 'is', 'is_not', 'empty', 'not_empty'], url: ['contains', 'not_contains', 'is', 'is_not', 'empty', 'not_empty'],
  number: ['is', 'is_not', 'gt', 'lt', 'empty', 'not_empty'], date: ['is', 'is_not', 'gt', 'lt', 'empty', 'not_empty'],
  select: ['is', 'is_not', 'empty', 'not_empty'], multiSelect: ['contains', 'not_contains', 'empty', 'not_empty'], relation: ['empty', 'not_empty'], checkbox: ['checked', 'unchecked'],
}
const OP_LABEL: Record<FilterOp, string> = { contains: 'contains', not_contains: 'does not contain', is: 'is', is_not: 'is not', gt: 'is greater than', lt: 'is less than', empty: 'is empty', not_empty: 'is not empty', checked: 'is checked', unchecked: 'is not checked' }
const NEEDS_VALUE = (op: FilterOp) => !['empty', 'not_empty', 'checked', 'unchecked'].includes(op)

type PanelName = 'filter' | 'sort' | 'group' | 'props' | 'newview'

export function DatabaseToolbar({ ws, db, view, onActive, search, onSearch, onNewRow, onDelete }: { ws: Workspace; db: DatabaseModel; view: ViewModel; onActive: (id: string) => void; search: string; onSearch: (q: string) => void; onNewRow: () => void; onDelete: () => void }) {
  const views = db.views.filter(v => !v.trashed)
  const props = db.properties.filter(p => !p.trashed)
  const config = readViewConfig(view.config, db.properties)
  const save = (patch: Parameters<typeof patchViewConfig>[1]) => ws.mutate([view.id], c => setViewConfig(c, view.id, patchViewConfig(view.config, patch)))
  const [panel, setPanel] = useState<{ kind: PanelName; rect: DOMRect } | null>(null)
  const [menu, setMenu] = useState<{ rect: DOMRect; items: MenuItem[] } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  // what was just chosen shows at once; the stored value takes over when it is read back
  const [hidden, setHidden] = useState(config.hidden)
  const stored = config.hidden.join(',')
  useEffect(() => setHidden(config.hidden), [stored]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = (kind: PanelName) => (e: React.MouseEvent<HTMLElement>) => setPanel({ kind, rect: e.currentTarget.getBoundingClientRect() })
  const groupProp = props.find(p => p.id === config.groupBy)
  const sort = config.sort[0]
  const viewItems = (v: ViewModel): MenuItem[] => [
    { label: t('Rename'), icon: <Icon name="pencil" size={16} />, onSelect: () => { const name = window.prompt(t('Name'), v.name); if (name?.trim()) void ws.mutate([v.id], c => renameView(c, v.id, name.trim())) } },
    { kind: 'sep' },
    { label: t('Delete view'), icon: <Icon name="trash" size={16} />, danger: true, disabled: views.length < 2, onSelect: () => { void ws.mutate([v.id], c => trashView(c, v.id)); onActive('') } },
  ]
  const ruleCount = config.filter.length
  const setRules = (filter: FilterRule[]) => void save({ filter })
  return (
    <>
      <header className="dv-bar" data-testid="viewbar">
        <div className="dv-views" role="tablist" aria-label={t('Views')}>
          {views.map(v => (
            <button key={v.id} type="button" role="tab" aria-selected={v.id === view.id} className="dv-view-tab" data-testid="view-tab" data-type={v.type} title={v.name}
              onClick={e => (v.id === view.id ? setMenu({ rect: e.currentTarget.getBoundingClientRect(), items: viewItems(v) }) : onActive(v.id))}
              onContextMenu={e => { e.preventDefault(); setMenu({ rect: new DOMRect(e.clientX, e.clientY, 0, 0), items: viewItems(v) }) }}>
              <Icon name={v.type === 'board' ? 'board' : 'table'} size={16} />
              <span dir="auto">{v.name || t('View')}</span>
              {v.id === view.id && <Icon name="chevron-down" size={14} className="dv-view-caret" />}
            </button>
          ))}
          <IconButton label={t('Add a view')} data-testid="add-view" onClick={open('newview')}><Icon name="plus" size={16} /></IconButton>
        </div>
        <div className="dv-tools" role="toolbar" aria-label={t('Database tools')}>
          {searchOpen || search ? (
            <SearchField className="dv-search" autoFocus value={search} onChange={v => { onSearch(v); if (!v) setSearchOpen(false) }} label={t('Search this database')} placeholder={t('Search…')} clearLabel={t('Clear search')} />
          ) : <IconButton label={t('Search')} onClick={() => setSearchOpen(true)}><Icon name="search" size={16} /></IconButton>}
          <ChipButton icon={<Icon name="filter" size={14} />} aria-pressed={ruleCount > 0} data-testid="chip-filter" onClick={open('filter')}>{ruleCount ? t('Filter · {n}', { n: ruleCount }) : t('Filter')}</ChipButton>
          <ChipButton icon={<Icon name="sort" size={14} />} aria-pressed={config.sort.length > 0} data-testid="chip-sort" onClick={open('sort')}>{config.sort.length ? t('Sort · {n}', { n: config.sort.length }) : t('Sort')}</ChipButton>
          {view.type === 'board' && <ChipButton icon={<Icon name="layers" size={14} />} aria-pressed={!!groupProp} data-testid="chip-group" onClick={open('group')}>{groupProp ? <span dir="auto">{t('Group · {n}', { n: groupProp.name })}</span> : t('Group')}</ChipButton>}
          <IconButton label={t('Properties')} data-testid="chip-props" onClick={open('props')}><Icon name="eye" size={16} /></IconButton>
          <IconButton label={t('More')} onClick={e => setMenu({ rect: e.currentTarget.getBoundingClientRect(), items: [{ label: t('Delete database'), icon: <Icon name="trash" size={16} />, danger: true, onSelect: onDelete }] })}><Icon name="more-horizontal" size={16} /></IconButton>
          <div className="ds-split dv-new">
            <Button variant="primary" size="sm" icon={<Icon name="plus" size={15} />} data-testid="db-add-row" onClick={onNewRow}>{t('New')}</Button>
          </div>
        </div>
      </header>
      {(ruleCount > 0 || config.sort.length > 0) && (
        <div className="dv-conditions" role="status">
          <span className="dv-conditions-list">
            {config.filter.map((r, i) => { const p = props.find(x => x.id === r.prop); return p ? <span key={'f' + i} dir="auto">{p.name} {t(OP_LABEL[r.op])}{NEEDS_VALUE(r.op) ? ` ${p.type === 'select' ? p.options.find(o => o.id === r.value)?.name ?? '' : r.value}` : ''}</span> : null })}
            {config.sort.map(s => { const p = props.find(x => x.id === s.prop); return p ? <span key={'s' + s.prop}>{t(s.dir === 'asc' ? '{n}, ascending' : '{n}, descending', { n: p.name })}</span> : null })}
          </span>
        </div>
      )}
      {menu && <Menu anchor={menu.rect} onClose={() => setMenu(null)} items={menu.items} />}
      {panel && (
        <Popover anchor={panel.rect} onClose={() => setPanel(null)} align="end">
          {panel.kind === 'newview' && (
            <Panel title={t('Add a view')} size="sm">
              <div className="dv-viewtypes" role="menu" aria-label={t('Layout')}>
                {(['table', 'board'] as const).map(ty => (
                  <button key={ty} type="button" role="menuitem" className="ds-menu-item dv-viewtype" data-testid={`new-view-${ty}`}
                    onClick={() => { void ws.mutate([], c => createView(c, db.id, { name: ty === 'table' ? t('Table') : t('Board'), type: ty, config: ty === 'board' ? patchViewConfig(undefined, { groupBy: props.find(p => p.type === 'select')?.id ?? '' }) : {} })).then(onActive); setPanel(null) }}>
                    <Icon name={ty === 'board' ? 'board' : 'table'} size={18} />
                    <span className="dv-viewtype-text"><b>{t(ty === 'table' ? 'Table' : 'Board')}</b><small>{t(ty === 'table' ? 'Rows and columns' : 'Cards in columns by a property')}</small></span>
                  </button>
                ))}
              </div>
            </Panel>
          )}
          {panel.kind === 'filter' && (
            <Panel title={t('Filter')} size="md" footer={<Button size="sm" icon={<Icon name="plus" size={15} />} data-testid="add-rule" disabled={!props.length} onClick={() => props[0] && setRules([...config.filter, { prop: props[0].id, op: OPS[props[0].type][0]!, value: '' }])}>{t('Add a rule')}</Button>}>
              {config.filter.length === 0 && <p className="dv-hint">{t('No conditions yet: every row is shown.')}</p>}
              <div className="dv-conditions">
                {config.filter.map((r, i) => {
                  const p = props.find(x => x.id === r.prop)!
                  const set = (patch: Partial<FilterRule>) => setRules(config.filter.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                  return (
                    <div key={i} className="dv-cond" data-testid="rule">
                      <select aria-label={t('Property')} data-testid="rule-prop" value={r.prop} onChange={e => { const np = props.find(x => x.id === e.target.value)!; set({ prop: np.id, op: OPS[np.type][0]!, value: '' }) }}>{props.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                      <select aria-label={t('Condition')} data-testid="rule-op" value={r.op} onChange={e => set({ op: e.target.value as FilterOp })}>{OPS[p.type].map(o => <option key={o} value={o}>{t(OP_LABEL[o])}</option>)}</select>
                      {NEEDS_VALUE(r.op) && (p.type === 'select'
                        ? <select aria-label={t('Value')} data-testid="rule-value" value={r.value} onChange={e => set({ value: e.target.value })}><option value="">—</option>{p.options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
                        : <input aria-label={t('Value')} data-testid="rule-value" dir="auto" value={r.value} onChange={e => set({ value: e.target.value })} />)}
                      <IconButton label={t('Remove rule')} onClick={() => setRules(config.filter.filter((_, j) => j !== i))}><Icon name="x" size={14} /></IconButton>
                    </div>
                  )
                })}
              </div>
            </Panel>
          )}
          {panel.kind === 'sort' && (
            <Panel title={t('Sort')} size="sm">
              <div className="dv-pair">
                <select aria-label={t('Sort by')} data-testid="sort-prop" value={sort?.prop ?? ''} onChange={e => void save({ sort: e.target.value ? [{ prop: e.target.value, dir: sort?.dir ?? 'asc' }] : [] })}>
                  <option value="">—</option>{props.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {sort && <Button size="sm" data-testid="sort-dir" onClick={() => void save({ sort: [{ prop: sort.prop, dir: sort.dir === 'asc' ? 'desc' : 'asc' }] })}>{sort.dir === 'asc' ? t('Ascending') : t('Descending')}</Button>}
              </div>
            </Panel>
          )}
          {panel.kind === 'group' && (
            <Panel title={t('Group')} size="sm">
              <select aria-label={t('Group by')} data-testid="group-by" value={config.groupBy} onChange={e => void save({ groupBy: e.target.value })}>
                <option value="">—</option>{props.filter(p => p.type === 'select').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Panel>
          )}
          {panel.kind === 'props' && <PropertiesPanel ws={ws} db={db} view={view} props={props} hidden={hidden} setHidden={setHidden} onSave={save} />}
        </Popover>
      )}
    </>
  )
}

/** Which properties this view shows (the eye), and a new one. */
function PropertiesPanel({ ws, db, view, props, hidden, setHidden, onSave }: { ws: Workspace; db: DatabaseModel; view: ViewModel; props: PropertyModel[]; hidden: string[]; setHidden: (h: string[]) => void; onSave: (p: { hidden: string[] }) => unknown }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<PropType>('text')
  const add = async () => {
    const n = name.trim(); if (!n) return
    setName('')
    await ws.mutate([], c => addProperty(c, db.id, { name: n, type, ...(type === 'relation' ? { config: { target: db.id } } : {}) }))
  }
  return (
    <Panel title={t('Properties')} size="md" actions={<span className="dv-hint">{t('{n} of {m} shown', { n: props.length - hidden.length, m: props.length })}</span>}>
      <div className="dv-proplist">
        {props.map(p => {
          const on = !hidden.includes(p.id)
          return (
            <div className="dv-proprow" key={p.id} data-off={!on || undefined}>
              <span className="dv-kind"><Icon name={KIND_ICON[p.type]} size={15} /></span>
              <span className="dv-proprow-name" dir="auto">{p.name}</span>
              <label className="ds-icon-btn" title={on ? t('Hide {n}', { n: p.name }) : t('Show {n}', { n: p.name })}>
                <input type="checkbox" data-testid="col-toggle" className="vh" checked={on} disabled={p.isTitle} onChange={e => { const next = e.target.checked ? hidden.filter(h => h !== p.id) : [...hidden, p.id]; setHidden(next); void onSave({ hidden: next }) }} />
                <Icon name={on ? 'eye' : 'eye-off'} size={16} />
              </label>
            </div>
          )
        })}
      </div>
      <div className="dv-pair" style={{ marginBlockStart: 'var(--ds-s3)' }}>
        <input data-testid="db-prop-name" dir="auto" placeholder={t('New property')} aria-label={t('New property')} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add() }} />
        <select data-testid="db-prop-type" aria-label={t('Type')} value={type} onChange={e => setType(e.target.value as PropType)}>{PROP_TYPES.map(x => <option key={x} value={x}>{t(TYPE_LABEL[x])}</option>)}</select>
      </div>
      <Button size="sm" icon={<Icon name="plus" size={15} />} data-testid="db-add-prop" onClick={() => void add()} className="dv-hint">{t('New property')}</Button>
      <span hidden>{view.id}</span>
    </Panel>
  )
}
