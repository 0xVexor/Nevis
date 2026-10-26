// The property panel of a database row page: pinned heading properties, sections, hide-if-empty / hidden properties, the unique ID,
// page and property comments, and layout customization. Used in the full page, the center peek and the side peek.
import { useMemo, useState } from 'react'
import type { Definition, Id, Json } from '../model/types.ts'
import type { SourceLayout } from '../commands/schema.ts'
import { DESCRIPTORS, isEmptyCell, defaultCell } from '../props/registry.ts'
import { formatUniqueId } from '../resolver.ts'
import type { Row } from '../state.ts'
import type { DatabaseService } from '../service.ts'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { CellView, NavContext, useNav, type DbNav } from './CellView'
import { InlineCellEditor, PopoverEditor, isInlineKind, isPopoverKind } from './CellEditor'
import { KindIcon, errorText, plainTitle, useDb, useRepoTick } from './common'
import { NewPropertyPopover, PropertyMenu } from './PropertyEditor'
import { CommentsThread } from './Comments'
import { Select } from '../../ui'

type Vis = 'always' | 'hide_if_empty' | 'hidden'
const defaultVis = (d: Definition): Vis => (['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id'].includes(d.kind) ? 'always' : 'always')

export function layoutOf(svc: DatabaseService, row: Row) {
  const src = svc.state.get('source', row.sourceId)!
  const L = (src.layout ?? {}) as SourceLayout
  const props = svc.state.props(row.sourceId).filter((p) => p.kind !== 'title' && svc.access().canReadProperty(svc.principalId, p, row))
  const order = L.order?.length ? [...L.order.filter((id) => props.some((p) => p.id === id)), ...props.map((p) => p.id).filter((id) => !L.order!.includes(id))] : props.map((p) => p.id)
  const vis = (d: Definition): Vis => L.visibility?.[d.id] ?? defaultVis(d)
  const isEmpty = (d: Definition) => {
    if (d.kind === 'relation') return svc.resolver().relationTargets(row, d).length === 0
    if (DESCRIPTORS[d.kind].cellKind) return isEmptyCell(row.ext.cells[d.id]?.value ?? defaultCell(d)) || (d.kind === 'checkbox' && false)
    if (d.kind === 'button') return false
    const q = svc.resolver().value(row, d)
    return q.c === 'empty'
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
  const countFor = (pid: Id) => comments.filter((c) => c.propertyId === pid && !c.resolved).length
  const owner = svc.state.get('container', src.ownerContainerId)

  const byId = new Map(props.map((p) => [p.id, p]))
  const heading = (L.heading ?? []).filter((id) => byId.has(id))
  const inSection = new Set((L.sections ?? []).flatMap((s) => s.propertyIds))
  const rest = order.filter((id) => !heading.includes(id) && !inSection.has(id))
  const shown = (d: Definition) => custom || vis(d) === 'always' || (vis(d) === 'hide_if_empty' && !isEmpty(d))
  const hiddenOnes = [...order].map((id) => byId.get(id)!).filter((d) => d && !custom && !shown(d))

  const saveLayout = async (next: SourceLayout | null) => {
    const r = await svc.tryExec([{ type: 'source.set_layout', payload: { sourceId: src.id, layout: next as unknown as Json } }])
    if (!r.ok) setMsg(errorText(r.code, r.message))
    else setMsg(null)
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

  const field = (d: Definition) => {
    const isEd = editing?.id === d.id
    const cell = <CellView svc={svc} rs={rs} row={row} def={d} />
    const writable = DESCRIPTORS[d.kind].writable && canEdit
    return (
      <div className={'rp-row' + (isEd ? ' editing' : '')} key={d.id} data-prop={d.id}>
        <div className="rp-label" title={t(d.name)}>
          <KindIcon kind={d.kind} /> <span className="rp-name" dir="auto">{d.name}</span>
        </div>
        <div className="rp-value">
          {custom ? (
            <div className="rp-custom">
              <Select value={vis(d)} options={[{ value: 'always', label: t('Always show') }, { value: 'hide_if_empty', label: t('Hide when empty') }, { value: 'hidden', label: t('Hidden') }]} onChange={(v) => setVis(d.id, v as Vis)} />
              <button type="button" className={'icon-btn' + (heading.includes(d.id) ? ' on' : '')} aria-label={t('Pin to the top')} aria-pressed={heading.includes(d.id)} onClick={() => pin(d.id)}><Ic.Star size={13} filled={heading.includes(d.id)} /></button>
              <button type="button" className="icon-btn" aria-label={t('Move up')} onClick={() => move(d.id, -1)}><Ic.Up size={13} /></button>
              <button type="button" className="icon-btn" aria-label={t('Move down')} onClick={() => move(d.id, 1)}><span style={{ display: 'inline-block', transform: 'rotate(180deg)' }}><Ic.Up size={13} /></span></button>
              <button type="button" className="icon-btn" aria-label={t('Property settings')} onClick={(e) => setMenu({ def: d, rect: e.currentTarget.getBoundingClientRect() })}><Ic.Settings size={13} /></button>
            </div>
          ) : isEd && isInlineKind(d.kind) ? (
            <InlineCellEditor svc={svc} row={row} def={d} onClose={() => setEditing(null)} />
          ) : (
            <button
              type="button"
              className={'rp-cell' + (writable ? '' : ' ro')}
              aria-label={`${d.name}: ${t('edit')}`}
              onClick={(e) => {
                if (!writable) return setMsg(DESCRIPTORS[d.kind].storage === 'derived' ? t('This value is calculated; change its inputs instead.') : DESCRIPTORS[d.kind].storage === 'system' || d.kind === 'unique_id' ? t('This value is set by the system.') : d.kind === 'button' ? '' : t('You can view this item but not edit it.'))
                if (d.kind === 'checkbox') { void svc.tryExec([{ type: 'row.patch', payload: { pageId: row.page.id, cellChanges: { [d.id]: { kind: 'checkbox', value: !(row.ext.cells[d.id]?.value as { value?: boolean } | undefined)?.value } } } }]); return }
                setEditing({ id: d.id, rect: e.currentTarget.getBoundingClientRect() })
              }}
            >
              {cell}
              {isEmpty(d) && d.kind !== 'checkbox' && <span className="rp-empty">{t('Empty')}</span>}
            </button>
          )}
          {isEd && isPopoverKind(d.kind) && <PopoverEditor svc={svc} row={row} def={d} anchor={editing!.rect} onClose={() => setEditing(null)} />}
        </div>
        {!custom && DESCRIPTORS[d.kind].cellKind && !['checkbox'].includes(d.kind) && (
          <button type="button" className={'rp-cm' + (countFor(d.id) ? ' has' : '')} aria-label={t('Comments on {n}', { n: d.name })} onClick={() => setCommentsFor(commentsFor === d.id ? null : d.id)}><Ic.Quote size={12} />{countFor(d.id) > 0 && <b>{countFor(d.id)}</b>}</button>
        )}
        {commentsFor === d.id && <div className="rp-thread"><CommentsThread svc={svc} pageId={row.page.id} propertyId={d.id} /></div>}
      </div>
    )
  }

  const id = formatUniqueId(props.find((p) => p.kind === 'unique_id') ?? ({ config: {} } as Definition), props.find((p) => p.kind === 'unique_id') ? row.ext.allocatedIds[props.find((p) => p.kind === 'unique_id')!.id] : undefined)
  return (
    <NavContext.Provider value={nav}>
      <div className="rp" aria-label={t('Properties')}>
        <div className="rp-top">
          <span className="rp-src" title={t('Data source')}><Ic.Layers size={12} /> <span dir="auto">{plainTitle(owner?.title || src.name)}</span> {owner && owner.id !== undefined && src.name && owner.title !== src.name ? <small>· {src.name}</small> : null}</span>
          {id && <span className="db-id" dir="ltr">{id}</span>}
          <span className="spacer" />
          {canSchema && <button type="button" className={'db-tool' + (custom ? ' on' : '')} onClick={() => setCustom(!custom)}><Ic.Settings size={13} /> {custom ? t('Done') : t('Customize layout')}</button>}
        </div>
        {heading.map((id) => byId.get(id)).filter((d): d is Definition => !!d && shown(d)).map(field)}
        {(L.sections ?? []).map((s) => (
          <details className="rp-section" key={s.id} open={!s.collapsed}>
            <summary>{s.title}</summary>
            {s.propertyIds.map((id) => byId.get(id)).filter((d): d is Definition => !!d && shown(d)).map(field)}
          </details>
        ))}
        {rest.map((id) => byId.get(id)).filter((d): d is Definition => !!d && shown(d) && !heading.includes(d.id)).map(field)}
        {hiddenOnes.length > 0 && (
          <div className="rp-more">
            <button type="button" className="db-linkbtn" onClick={() => setMoreOpen(!moreOpen)}>{moreOpen ? t('Hide') : t('{n} more properties', { n: hiddenOnes.length })}</button>
            {moreOpen && hiddenOnes.map(field)}
          </div>
        )}
        {custom && (
          <div className="rp-foot">
            <button type="button" onClick={(e) => setNewProp(e.currentTarget.getBoundingClientRect())}><Ic.Plus size={12} /> {t('New property')}</button>
            <button type="button" onClick={() => void saveLayout({ ...L, sections: [...(L.sections ?? []), { id: crypto.randomUUID(), title: t('Section'), propertyIds: [] }] })}>{t('Add a section')}</button>
            <button type="button" className="danger" onClick={() => void saveLayout(null)}>{t('Reset layout (keeps every value)')}</button>
          </div>
        )}
        {msg && <div className="db-err" role="alert">{msg}</div>}
        <div className="rp-comments">
          <button type="button" className="db-linkbtn" onClick={() => setCommentsFor(commentsFor === 'page' ? null : 'page')}>
            <Ic.Quote size={13} /> {t('Comments')}{comments.filter((c) => c.propertyId === null).length ? ` (${comments.filter((c) => c.propertyId === null).length})` : ''}
          </button>
          {commentsFor === 'page' && <CommentsThread svc={svc} pageId={row.page.id} propertyId={null} />}
        </div>
        {menu && <PropertyMenu svc={svc} def={menu.def} anchor={menu.rect} onClose={() => setMenu(null)} actions={{}} />}
        {newProp && <NewPropertyPopover svc={svc} sourceId={src.id} anchor={newProp} onClose={() => setNewProp(null)} />}
      </div>
    </NavContext.Provider>
  )
}

export default RowProperties
export const _useMemo = useMemo
