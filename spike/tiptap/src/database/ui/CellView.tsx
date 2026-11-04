// Read-only rendering of one value. Editing lives in CellEditor.tsx; both work on the same QValue / Cell data.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Cell, Definition, Id } from '../model/types.ts'
import { formatDateValue } from '../dates.ts'
import { cfgOf, optionsOf } from '../props/config.ts'
import { formatNumber, progressOf } from '../props/numberFormat.ts'
import { connectedText } from '../props/registry.ts'
import { formatUniqueId, type Resolver } from '../resolver.ts'
import type { Row } from '../state.ts'
import type { DatabaseService } from '../service.ts'
import type { QValue } from '../query/values.ts'
import { fileMeta } from '../../attachments'
import { Button, Icon } from '../../design-system'
import { locale, t } from '../../i18n'
import { Chip, openSafe, plainTitle } from './common'

/** What a cell needs from its surroundings: opening a related row, running a button, showing a toast. */
export interface DbNav {
  openRow(pageId: Id, mode?: 'side' | 'center' | 'full'): void
  runButton(row: Row, def: Definition): void
  toast(msg: string): void
}
const CONNECTED_STATUS: Record<string, string> = { unauthorized: 'Reconnect needed', not_visible: 'Not visible to this connection', unavailable: 'Could not refresh' }

export const NavContext = createContext<DbNav>({ openRow: () => {}, runButton: () => {}, toast: () => {} })
export const useNav = () => useContext(NavContext)

const fileNames = new Map<string, string>()
export function useFileNames(ids: Id[]): Map<string, string> {
  const [, tick] = useState(0)
  useEffect(() => {
    const need = ids.filter((i) => !fileNames.has(i))
    if (!need.length) return
    let live = true
    void fileMeta(need).then((m) => {
      need.forEach((i) => fileNames.set(i, m.get(i)?.name ?? ''))
      if (live) tick((x) => x + 1)
    })
    return () => void (live = false)
  }, [ids.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  return fileNames
}

function Blocked({ q }: { q: Extract<QValue, { c: 'blocked' }> }) {
  if (q.state === 'restricted')
    return (
      <span className="dv-blocked" title={t('You do not have access to this value')}>
        <Icon name="lock" size={13} /> {t('Restricted')}
      </span>
    )
  if (q.state === 'pending')
    return (
      <span className="dv-blocked" title={t('Waiting for data that has not arrived yet')}>
        {t('Waiting…')}
      </span>
    )
  return (
    <span className="dv-blocked" data-bad title={q.detail || q.code}>
      <Icon name="warning" size={13} /> {q.code ?? t('Error')}
    </span>
  )
}

function PersonChip({ rs, id }: { rs: Resolver; id: Id }) {
  const p = rs.access.principal(id)
  return <Chip title={p?.email ?? undefined}>{p?.displayName ?? t('Unknown person')}</Chip>
}

/** A checkbox value as a mark, not a control: the cell or the row panel toggles it. */
export const CheckMark = ({ on }: { on: boolean }) => (
  <span className="dv-check" data-on={on || undefined} role="img" aria-label={on ? t('Checked') : t('Unchecked')}>
    {on && <Icon name="check" size={12} />}
  </span>
)

function ValueView({ rs, def, q, row }: { rs: Resolver; def: Definition; q: QValue; row: Row }): ReactNode {
  if (q.c === 'blocked') return <Blocked q={q} />
  if (q.c === 'empty') return null
  switch (q.c) {
    case 'number': {
      const kind =
        def.kind === 'number' ? cfgOf.number(def) : def.kind === 'rollup' ? (cfgOf.rollup(def).numberFormat ?? { format: 'plain' as const, precision: 0 }) : { format: 'plain' as const, precision: 0 }
      const frac = kind.format === 'plain' && !Number.isInteger(q.n) ? { ...kind, precision: Math.min(8, String(q.n).split('.')[1]?.length ?? 0) } : kind
      const text = formatNumber(q.n, frac, locale())
      const pr = def.kind === 'number' ? progressOf(q.n, cfgOf.number(def)) : null
      return (
        <span className="dv-num" dir="ltr">
          {pr !== null && <i className="dv-progress" data-mode={cfgOf.number(def).progress?.mode ?? 'bar'} style={{ ['--p' as string]: pr }} />}
          {text}
        </span>
      )
    }
    case 'bool':
      return def.kind === 'checkbox' ? <CheckMark on={q.b} /> : <span>{q.b ? t('Yes') : t('No')}</span>
    case 'date': {
      const dc = def.kind === 'date' || def.kind === 'created_time' || def.kind === 'last_edited_time' ? cfgOf.date(def) : null
      const zone = (dc?.defaultZone ?? rs.opts.zone) || 'UTC'
      return (
        <span className="dv-date" dir="auto">
          {formatDateValue(q.v, { calendar: dc?.displayCalendar ?? 'gregorian', zone, locale: locale() })}
        </span>
      )
    }
    case 'text': {
      if (def.kind === 'url' || def.kind === 'email' || def.kind === 'phone') {
        const href = def.kind === 'email' ? `mailto:${q.text}` : def.kind === 'phone' ? `tel:${q.text.replace(/\s+/g, '')}` : q.text
        return (
          <a className="dv-link" dir="ltr" href={href} onClick={(e) => (e.preventDefault(), e.stopPropagation(), openSafe(href))}>
            {q.text}
          </a>
        )
      }
      if (def.kind === 'unique_id')
        return (
          <span className="dv-id" dir="ltr">
            {q.text}
          </span>
        )
      if (def.kind === 'verification')
        return (
          <span className="dv-verify" data-state={q.text}>
            <Icon name={q.text === 'verified' ? 'check-circle' : 'shield'} size={13} /> {q.text === 'verified' ? t('Verified') : t('Unverified')}
          </span>
        )
      if (def.kind === 'text') {
        const cell = row.ext.cells[def.id]?.value
        if (cell?.kind === 'text') return <RichRuns runs={cell.runs} />
      }
      return <span dir="auto">{q.text}</span>
    }
    case 'members': {
      if (def.kind === 'select' || def.kind === 'multi_select' || def.kind === 'status') {
        const opts = optionsOf(def)
        return (
          <>
            {q.ids.map((id) => {
              const o = opts.find((x) => x.id === id)
              return o ? (
                <Chip key={id} color={o.color}>
                  {o.name}
                </Chip>
              ) : (
                <Chip key={id} muted title={t('This option was deleted')}>
                  {t('Deleted option')}
                </Chip>
              )
            })}
          </>
        )
      }
      if (def.kind === 'people' || q.shape === 'people' || q.shape === 'created_by' || q.shape === 'last_edited_by')
        return (
          <>
            {q.ids.map((id) => (
              <PersonChip key={id} rs={rs} id={id} />
            ))}
          </>
        )
      if (def.kind === 'files') return <FilesView ids={q.ids} />
      return (
        <>
          {q.ids.map((id) => (
            <Chip key={id}>{rs.title(id) ?? '…'}</Chip>
          ))}
        </>
      )
    }
    case 'list':
      return (
        <span dir="auto">
          {q.items
            .map((i) => (i.c === 'text' ? i.text : i.c === 'number' ? String(i.n) : ''))
            .filter(Boolean)
            .join(', ')}
        </span>
      )
  }
}

function RichRuns({ runs }: { runs: Extract<Cell, { kind: 'text' }>['runs'] }) {
  const nav = useNav()
  return (
    <span dir="auto" className="dv-rich">
      {runs.map((r, i) => {
        let el: ReactNode = r.text
        if (r.mention?.kind === 'page')
          el = (
            <button type="button" className="dv-mention" onClick={(e) => (e.stopPropagation(), nav.openRow(r.mention!.id))}>
              @{r.text}
            </button>
          )
        else if (r.href)
          el = (
            <a className="dv-link" href={r.href} onClick={(e) => (e.preventDefault(), e.stopPropagation(), openSafe(r.href!))}>
              {r.text}
            </a>
          )
        if (r.bold) el = <b>{el}</b>
        if (r.italic) el = <i>{el}</i>
        if (r.code) el = <code>{el}</code>
        if (r.strike) el = <s>{el}</s>
        if (r.underline) el = <u>{el}</u>
        return <span key={i}>{el}</span>
      })}
    </span>
  )
}

function FilesView({ ids }: { ids: Id[] }) {
  const names = useFileNames(ids)
  return (
    <>
      {ids.map((id) => (
        <Chip key={id} title={names.get(id) || id}>
          <Icon name="paperclip" size={12} /> {names.get(id) || t('File')}
        </Chip>
      ))}
    </>
  )
}

/** Value of one cell for display. `rs` is one Resolver per render pass (it caches formula / rollup results). */
export function CellView({ svc, rs, row, def }: { svc: DatabaseService; rs: Resolver; row: Row; def: Definition }) {
  const nav = useNav()
  switch (def.kind) {
    case 'title':
      return (
        <span dir="auto" className="dv-title-text">
          {plainTitle(row.page.title)}
        </span>
      )
    case 'button': {
      const c = cfgOf.button(def)
      return (
        <Button size="sm" className="dv-button" onClick={(e) => (e.stopPropagation(), nav.runButton(row, def))}>
          {c.label}
        </Button>
      )
    }
    case 'relation': {
      const targets = rs.relationTargets(row, def)
      if (targets.some((x) => x.state === 'restricted')) return <Blocked q={{ c: 'blocked', state: 'restricted' }} />
      return (
        <>
          {targets.map((x) =>
            x.state === 'live' ? (
              <button key={x.edgeId} type="button" className="ds-chip dv-chip dv-rel" onClick={(e) => (e.stopPropagation(), nav.openRow(x.pageId))}>
                <Icon name="file" size={12} />
                <span className="dv-chip-t" dir="auto">
                  {plainTitle(rs.title(x.pageId))}
                </span>
              </button>
            ) : (
              <Chip key={x.edgeId} muted title={x.state === 'trashed' ? t('This item is in the trash') : t('This item has not arrived yet')}>
                {x.state === 'trashed' ? <s>{plainTitle(svc.state.pages.get(x.pageId)?.title)}</s> : '…'}
              </Chip>
            ),
          )}
        </>
      )
    }
    case 'unique_id':
      return (
        <span className="dv-id" dir="ltr">
          {formatUniqueId(def, row.ext.allocatedIds[def.id])}
        </span>
      )
    case 'connected': {
      const c = row.ext.cells[def.id]?.value
      if (c?.kind !== 'connected' || !c.value) return null
      const v = c.value
      const stale = !!v.status && v.status !== 'ok'
      return (
        <a
          className="dv-link"
          data-stale={stale || undefined}
          dir="auto"
          href={v.canonicalUrl}
          title={v.cache ? `${t('Fetched')} ${new Date(v.cache.fetchedAt).toLocaleString()}` : t('Not fetched yet')}
          onClick={(e) => (e.preventDefault(), e.stopPropagation(), openSafe(v.canonicalUrl))}
        >
          {connectedText(c)}
          {stale && <span className="dv-stale"> · {t(CONNECTED_STATUS[v.status!])}</span>}
        </a>
      )
    }
    case 'place': {
      const c = row.ext.cells[def.id]?.value
      if (c?.kind !== 'place' || !c.value) return null
      const unplaced = c.value.lat === null
      return (
        <span className="dv-place" dir="auto" data-unplaced={unplaced || undefined} title={unplaced ? t('Not placed on the map yet') : `${c.value.lat}, ${c.value.lon}`}>
          <Icon name="map" size={13} />
          <span>{c.value.name || c.value.address}</span>
        </span>
      )
    }
    default: {
      const q = rs.value(row, def)
      if (def.kind === 'checkbox' && q.c === 'empty') return <CheckMark on={false} />
      return <ValueView rs={rs} def={def} q={q} row={row} />
    }
  }
}
