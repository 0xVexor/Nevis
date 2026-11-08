// The database properties of a row page, in the same rows as the page's own properties (label with its icon, then the value):
// pinned ones first, then sections, then the rest; hide-if-empty and hidden properties fold under "N more". The unique ID, page and
// property comments, and the layout customization live here too. Used in the full page, the center peek and the side peek.
import { useState } from 'react'
import type { Definition, Id, Json } from '../model/types.ts'
import type { SourceLayout } from '../commands/schema.ts'
import { DESCRIPTORS, isEmptyCell, defaultCell } from '../props/registry.ts'
import { formatUniqueId } from '../resolver.ts'
import type { Row } from '../state.ts'
import type { DatabaseService } from '../service.ts'
import { Button, Disclosure, Dropdown, Icon, IconButton } from '../../design-system'
import { t } from '../../i18n'
import { CellView, NavContext, useNav, type DbNav } from './CellView'
import { InlineCellEditor, PopoverEditor, isInlineKind, isPopoverKind } from './CellEditor'
import { ErrorLine, KindIcon, errorText, plainTitle, useDb, useRepoTick } from './common'
import { NewPropertyPopover, PropertyMenu } from './PropertyEditor'
import { CommentsThread } from './Comments'

type Vis = 'always' | 'hide_if_empty' | 'hidden'

export function layoutOf(svc: DatabaseService, row: Row) {
  const src = svc.state.get('source', row.sourceId)!
  const L = (src.layout ?? {}) as SourceLayout
  const props = svc.state.props(row.sourceId).filter((p) => p.kind !== 'title' && svc.access().canReadProperty(svc.principalId, p, row))
  const order = L.order?.length ? [...L.order.filter((id) => props.some((p) => p.id === id)), ...props.map((p) => p.id).filter((id) => !L.order!.includes(id))] : props.map((p) => p.id)
  const vis = (d: Definition): Vis => L.visibility?.[d.id] ?? 'always'
  const isEmpty = (d: Definition) => {
    if (d.kind === 'relation') return svc.resolver().relationTargets(row, d).length === 0
    if (DESCRIPTORS[d.kind].cellKind) return isEmptyCell(row.ext.cells[d.id]?.value ?? defaultCell(d))
    if (d.kind === 'button') return false
    return svc.resolver().value(row, d).c === 'empty'
  }
  return { src, L, props, order, vis, isEmpty }
}

export function RowProperties({ pageId }: { pageId: Id }) {
  const svc = useDb()
  useRepoTick()
  const nav = useNav()
  if (!svc) return null
  const row = svc.state.row(pageId)
  if (!row) return null
  return <Panel svc={svc} row={row} nav={nav} />
}

function Panel({ svc, row, nav }: { svc: DatabaseService; row: Row; nav: DbNav }) {
  const { src, L, props, order, vis, isEmpty } = layoutOf(svc, row)
  const canSchema = svc.access().sourceCaps(svc.principalId, src.id).has('edit_schema')
  const canEdit = svc.access().rowCaps(svc.principalId, row).has('edit_rows')
  const [editing, setEditing] = useState<{ id: Id; rect: DOMRect } | null>(null)
  const [custom, setCustom] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [menu, setMenu] = useState<{ def: Definition; rect: DOMRect } | null>(null)
  const [newProp, setNewProp] = useState<DOMRect | null>(null)
  const [commentsFor, setCommentsFor] = useState<Id | 'page' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const rs = svc.resolver()
  const comments = svc.state.live('comment').filter((c) => c.pageId === row.page.id && c.parentCommentId === null)
  const countFor = (pid: Id | null) => comments.filter((c) => c.propertyId === pid && !c.resolved).length
  const owner = svc.state.get('container', src.ownerContainerId)

  const byId = new Map(props.map((p) => [p.id, p]))
  const heading = (L.heading ?? []).filter((id) => byId.has(id))
  const inSection = new Set((L.sections ?? []).flatMap((s) => s.propertyIds))
  const rest = order.filter((id) => !heading.includes(id) && !inSection.has(id))
  const shown = (d: Definition) => custom || vis(d) === 'always' || (vis(d) === 'hide_if_empty' && !isEmpty(d))
  const hiddenOnes = order.map((id) => byId.get(id)!).filter((d) => d && !custom && !shown(d))

  const saveLayout = async (next: SourceLayout | null) => {
    const r = await svc.tryExec([{ type: 'source.set_layout', payload: { sourceId: src.id, layout: next as unknown as Json } }])
    setMsg(r.ok ? null : errorText(r.code, r.message))
  }
  const setVis = (id: Id, v: Vis) => void saveLayout({ ...L, visibility: { ...(L.visibility ?? {}), [id]: v } })
  const pin = (id: Id) => void saveLayout({ ...L, heading: heading.includes(id) ? heading.filter((x) => x !== id) : [...heading, id].slice(0, 15) })
  const move = (id: Id, d: -1 | 1) => {
    const i = order.indexOf(id)
    const j = i + d
    if (j < 0 || j >= order.length) return
    const n = [...order]
    ;[n[i], n[j]] = [n[j], n[i]]
    void saveLayout({ ...L, order: n })
  }
  const whyReadOnly = (d: Definition) =>
    DESCRIPTORS[d.kind].storage === 'derived'
      ? t('This value is calculated; change its inputs instead.')
      : DESCRIPTORS[d.kind].storage === 'system' || d.kind === 'unique_id'
        ? t('This value is set by the system.')
        : d.kind === 'button'
          ? null
          : t('You can view this item but not edit it.')

  const field = (d: Definition) => {
    const isEd = editing?.id === d.id
    const writable = DESCRIPTORS[d.kind].writable && canEdit
    const n = countFor(d.id)
    return (
      <div className="ds-prop dv-prop" key={d.id} data-prop={d.id} data-pinned={heading.includes(d.id) || undefined}>
        <span className="ds-prop-label" title={d.name}>
          <KindIcon kind={d.kind} />
          <span className="dv-prop-name" dir="auto">
            {d.name}
          </span>
        </span>
        <div className="ds-prop-value">
          {custom ? (
            <div className="dv-prop-custom">
              <Dropdown
                className="ds-dd-btn--sm"
                label={t('Show {n}', { n: d.name })}
                value={vis(d)}
                options={[
                  { value: 'always', label: 'Always show' },
                  { value: 'hide_if_empty', label: 'Hide when empty' },
                  { value: 'hidden', label: 'Hidden' },
                ]}
                onChange={(v) => setVis(d.id, v)}
              />
              <IconButton className="ds-icon-btn--toggle" label={t('Pin to the top')} pressed={heading.includes(d.id)} onClick={() => pin(d.id)}>
                <Icon name="pin" size={15} />
              </IconButton>
              <IconButton label={t('Move up')} onClick={() => move(d.id, -1)}>
                <Icon name="arrow-up" size={15} />
              </IconButton>
              <IconButton label={t('Move down')} onClick={() => move(d.id, 1)}>
                <Icon name="arrow-down" size={15} />
              </IconButton>
              <IconButton label={t('Property settings')} onClick={(e) => setMenu({ def: d, rect: e.currentTarget.getBoundingClientRect() })}>
                <Icon name="settings" size={15} />
              </IconButton>
            </div>
          ) : isEd && isInlineKind(d.kind) ? (
            <InlineCellEditor svc={svc} row={row} def={d} onClose={() => setEditing(null)} />
          ) : (
            <div className="dv-prop-cell dv-stretch" data-ro={!writable || undefined}>
              <button
                type="button"
                className="dv-stretch-hit"
                aria-label={`${d.name}: ${t('edit')}`}
                onClick={(e) => {
                  if (!writable) {
                    const why = whyReadOnly(d)
                    if (why) setMsg(why)
                    return
                  }
                  if (d.kind === 'checkbox') {
                    void svc.tryExec([
                      {
                        type: 'row.patch',
                        payload: { pageId: row.page.id, cellChanges: { [d.id]: { kind: 'checkbox', value: !(row.ext.cells[d.id]?.value as { value?: boolean } | undefined)?.value } } },
                      },
                    ])
                    return
                  }
                  setEditing({ id: d.id, rect: e.currentTarget.getBoundingClientRect() })
                }}
              />
              <CellView svc={svc} rs={rs} row={row} def={d} />
              {isEmpty(d) && d.kind !== 'checkbox' && <span className="dv-prop-empty">{t('Empty')}</span>}
            </div>
          )}
          {isEd && isPopoverKind(d.kind) && <PopoverEditor svc={svc} row={row} def={d} anchor={editing!.rect} onClose={() => setEditing(null)} />}
          {!custom && DESCRIPTORS[d.kind].cellKind && d.kind !== 'checkbox' && (
            <button
              type="button"
              className="dv-prop-comment"
              data-has={n > 0 || undefined}
              aria-expanded={commentsFor === d.id}
              aria-label={t('Comments on {n}', { n: d.name })}
              onClick={() => setCommentsFor(commentsFor === d.id ? null : d.id)}
            >
              <Icon name="comment" size={14} />
              {n > 0 && <span>{n}</span>}
            </button>
          )}
        </div>
        {commentsFor === d.id && (
          <div className="dv-prop-thread">
            <CommentsThread svc={svc} pageId={row.page.id} propertyId={d.id} />
          </div>
        )}
      </div>
    )
  }

  const idProp = props.find((p) => p.kind === 'unique_id')
  const id = idProp ? formatUniqueId(idProp, row.ext.allocatedIds[idProp.id]) : ''
  const pageComments = countFor(null)
  return (
    <NavContext.Provider value={nav}>
      <section className="dv-rowprops" aria-label={t('Database properties')}>
        <header className="dv-rowprops-head">
          <span className="dv-rowprops-src" title={t('Data source')}>
            <Icon name="database" size={15} />
            <span dir="auto">{plainTitle(owner?.title || src.name)}</span>
            {owner && src.name && owner.title !== src.name && <small dir="auto">· {src.name}</small>}
          </span>
          {id && (
            <span className="dv-id" dir="ltr">
              {id}
            </span>
          )}
          <span className="dv-rowprops-acts">
            <Button size="sm" variant="ghost" icon={<Icon name="comment" size={15} />} aria-expanded={commentsFor === 'page'} onClick={() => setCommentsFor(commentsFor === 'page' ? null : 'page')}>
              {pageComments ? t('Comments · {n}', { n: pageComments }) : t('Comments')}
            </Button>
            {canSchema && (
              <Button size="sm" variant={custom ? 'primary' : 'ghost'} icon={<Icon name={custom ? 'check' : 'settings'} size={15} />} onClick={() => setCustom(!custom)}>
                {custom ? t('Done') : t('Customize layout')}
              </Button>
            )}
          </span>
        </header>
        {commentsFor === 'page' && (
          <div className="dv-prop-thread">
            <CommentsThread svc={svc} pageId={row.page.id} propertyId={null} />
          </div>
        )}
        <div className="ds-props dv-props">
          {heading
            .map((hid) => byId.get(hid))
            .filter((d): d is Definition => !!d && shown(d))
            .map(field)}
          {(L.sections ?? []).map((s) => (
            <Disclosure className="dv-section" key={s.id} open={!s.collapsed} title={s.title}>
              {s.propertyIds
                .map((pid) => byId.get(pid))
                .filter((d): d is Definition => !!d && shown(d))
                .map(field)}
            </Disclosure>
          ))}
          {rest
            .map((rid) => byId.get(rid))
            .filter((d): d is Definition => !!d && shown(d) && !heading.includes(d.id))
            .map(field)}
          {hiddenOnes.length > 0 && moreOpen && hiddenOnes.map(field)}
        </div>
        {hiddenOnes.length > 0 && (
          <Button size="sm" variant="ghost" icon={<Icon name={moreOpen ? 'chevron-up' : 'chevron-down'} size={15} />} aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            {moreOpen ? t('Show fewer properties') : t('{n} more properties', { n: hiddenOnes.length })}
          </Button>
        )}
        {custom && (
          <div className="dv-rowprops-foot">
            <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={(e) => setNewProp(e.currentTarget.getBoundingClientRect())}>
              {t('New property')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void saveLayout({ ...L, sections: [...(L.sections ?? []), { id: crypto.randomUUID(), title: t('Section'), propertyIds: [] }] })}>
              {t('Add a section')}
            </Button>
            <Button size="sm" variant="ghost" className="dv-danger" onClick={() => void saveLayout(null)}>
              {t('Reset layout (keeps every value)')}
            </Button>
          </div>
        )}
        {msg && <ErrorLine>{msg}</ErrorLine>}
        {menu && <PropertyMenu svc={svc} def={menu.def} anchor={menu.rect} onClose={() => setMenu(null)} actions={{}} />}
        {newProp && <NewPropertyPopover svc={svc} sourceId={src.id} anchor={newProp} onClose={() => setNewProp(null)} />}
      </section>
    </NavContext.Provider>
  )
}

export default RowProperties
