// Calendar and Timeline. Both read one date property (or a range), show undated items in an explicit tray, and turn drags into the
// same `row.patch` / `date.shift` commands the table uses (viewLogic.planDateDrag), so dependency shifting and DST rules apply everywhere.
import { useMemo, useRef, useState } from 'react'
import type { Definition, Id, Json } from '../model/types.ts'
import { addDays, addMonths, civilOf, civilToJalali, diffDays, formatCivil, jalaliMonthLength, jalaliToCivil, parseCivil, startOfDayMs, startOfWeek, toIso, weekdayOf, dateInterval, JALALI_MONTHS } from '../dates.ts'
import { cfgOf } from '../props/config.ts'
import { dependencyArrows, planDateDrag, scheduleModel, type ScheduleItem } from '../viewLogic.ts'
import { locale, t } from '../../i18n'
import * as Ic from '../../icons'
import { Chip, errorText, plainTitle } from './common'
import { useNav } from './CellView'
import { monthGrid } from './DatePicker'
import { useViewQuery } from './useViewQuery'
import type { ViewProps } from './viewTypes'

function dateProp(svc: ViewProps['svc'], view: ViewProps['view']): Definition | undefined {
  const id = (view.configuration as { datePropertyId?: Id }).datePropertyId
  return id ? svc.state.prop(id) : undefined
}
const WEEKEND = (weekStart: number) => (weekStart === 6 ? [5] : [6, 7])
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])

// ───── Calendar ─────

export function CalendarView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const def = dateProp(svc, view)
  const zone = svc.zone
  const today = civilOf(svc.now(), zone)
  const [anchor, setAnchor] = useState(today)
  const [dragId, setDragId] = useState<Id | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [selDay, setSelDay] = useState<string | null>(null)
  const resize = useRef<{ id: Id; side: 'start' | 'end'; from: string } | null>(null)
  const mode = (cfg.calendarMode as string) === 'week' ? 'week' : 'month'
  const cal = def && (def.kind === 'date' || def.kind === 'created_time' || def.kind === 'last_edited_time') ? cfgOf.date(def).displayCalendar : 'gregorian'
  const fa = locale().startsWith('fa')
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 5000 })
  const days = useMemo(() => (mode === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor, svc.weekStart), i)) : monthGrid(anchor, cal, svc.weekStart).map((d) => d.civil)), [anchor, mode, cal, svc.weekStart])
  if (!def) return <div className="db-error-box"><b>{t('Choose a date property')}</b><p>{t('Open View settings and pick the date to show items by.')}</p></div>
  if (q.error) return <div className="db-error-box" role="alert">{errorText(q.error.code, q.error.message)}</div>
  const model = scheduleModel(svc.state, ctl.rs, q.matchIds, def.id, days[0], days[days.length - 1], zone)
  const editable = model.editable && ctl.canEditRows
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7))
  const weekend = WEEKEND(svc.weekStart)

  const shiftNav = (n: number) => {
    if (cal === 'gregorian') setAnchor(mode === 'week' ? addDays(anchor, 7 * n) : addMonths(anchor, n))
    else if (mode === 'week') setAnchor(addDays(anchor, 7 * n))
    else {
      const j = civilToJalali(anchor)
      const tot = j.y * 12 + (j.m - 1) + n
      const ny = Math.floor(tot / 12)
      const nm = (tot % 12) + 1
      setAnchor(jalaliToCivil(ny, nm, Math.min(j.d, jalaliMonthLength(ny, nm))))
    }
  }
  const title = (() => {
    if (cal === 'jalali') { const j = civilToJalali(anchor); return `${JALALI_MONTHS[j.m - 1]} ${fa ? faDigits(j.y) : j.y}` }
    if (mode === 'week') return `${formatCivil(days[0], { locale: locale() })} – ${formatCivil(days[6], { locale: locale() })}`
    return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(parseCivil(anchor).y, parseCivil(anchor).m - 1, 1)))
  })()
  const dayNum = (c: string) => (cal === 'jalali' ? (fa ? faDigits(civilToJalali(c).d) : civilToJalali(c).d) : parseCivil(c).d)
  const inMonth = (c: string) => (mode === 'week' ? true : cal === 'jalali' ? civilToJalali(c).m === civilToJalali(anchor).m : parseCivil(c).m === parseCivil(anchor).m)

  const apply = async (cmds: { type: string; payload: Json }[]) => {
    const r = await svc.tryExec(cmds)
    if (!r.ok) ctl.notice(errorText(r.code, r.message))
  }
  const dropOn = async (day: string) => {
    const id = dragId
    setDragId(null)
    setOver(null)
    if (!id) return
    const it = model.items.find((x) => x.pageId === id)
    if (!it) {
      // from the tray: give it that day
      if (!editable) return
      return apply([{ type: 'row.patch', payload: { pageId: id, cellChanges: { [def.id]: { kind: 'date', value: { kind: 'date', start: day, end: null } } } } }])
    }
    const delta = diffDays(day, it.startCivil)
    if (!delta) return
    const plan = planDateDrag(svc.state, { pageId: id, datePropertyId: def.id, mode: 'move', days: delta, zone })
    if (!plan.ok) return ctl.notice(plan.reason)
    await apply(plan.commands)
  }
  const endResize = async (day: string | null) => {
    const r = resize.current
    resize.current = null
    setOver(null)
    if (!r || !day) return
    const delta = diffDays(day, r.from)
    if (!delta) return
    const plan = planDateDrag(svc.state, { pageId: r.id, datePropertyId: def.id, mode: r.side === 'start' ? 'resize_start' : 'resize_end', days: delta, zone })
    if (!plan.ok) return ctl.notice(plan.reason)
    await apply(plan.commands)
  }
  const startResize = (e: React.PointerEvent, it: ScheduleItem, side: 'start' | 'end') => {
    e.preventDefault()
    e.stopPropagation()
    resize.current = { id: it.pageId, side, from: side === 'start' ? it.startCivil : it.endCivil }
    const move = (ev: PointerEvent) => setOver((document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-day]')?.dataset.day ?? null)
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      void endResize((document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-day]')?.dataset.day ?? null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const create = async (day: string) => {
    if (!ctl.canEditRows || !model.editable) return
    const r = await ctl.createRow({ context: [{ propertyId: def.id, cell: { kind: 'date', value: { kind: 'date', start: day, end: null } } }] })
    if (r) nav.openRow(r.pageId, 'side')
  }
  const names = (() => { const a = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(today, svc.weekStart), i)); return a.map((c) => new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(parseCivil(c).y, parseCivil(c).m - 1, parseCivil(c).d)))) })()

  return (
    <div className="db-cal" data-mode={mode}>
      <div className="db-cal-head">
        <button type="button" className="icon-btn" aria-label={t('Previous')} onClick={() => shiftNav(-1)}><span style={{ display: 'inline-block', transform: 'scaleX(-1)' }}><Ic.Chevron size={14} /></span></button>
        <b>{title}</b>
        <button type="button" className="icon-btn" aria-label={t('Next')} onClick={() => shiftNav(1)}><Ic.Chevron size={14} /></button>
        <button type="button" className="db-tool" onClick={() => setAnchor(today)}>{t('Today')}</button>
        <span className="spacer" />
        <button type="button" className={'db-tool' + (mode === 'month' ? ' on' : '')} onClick={() => void ctl.patch({ calendarMode: 'month' })}>{t('Month')}</button>
        <button type="button" className={'db-tool' + (mode === 'week' ? ' on' : '')} onClick={() => void ctl.patch({ calendarMode: 'week' })}>{t('Week')}</button>
      </div>
      {!model.editable && <div className="db-date-hint">{t('This date is calculated, so items cannot be dragged. Change its inputs instead.')}</div>}
      <div className="db-cal-wd" aria-hidden>{names.map((n, i) => <span key={i}>{n}</span>)}</div>
      <div className="db-cal-weeks" role="grid" aria-label={title}>
        {weeks.map((w) => {
          const segs = model.items.map((it) => {
            const s = it.startCivil < w[0] ? w[0] : it.startCivil
            const e = it.endCivil > w[6] ? w[6] : it.endCivil
            return s > w[6] || e < w[0] ? null : { it, s: diffDays(s, w[0]), e: diffDays(e, w[0]), clipL: it.startCivil < w[0], clipR: it.endCivil > w[6] }
          }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s))
          const lanes: number[] = []
          const placed = segs.map((sg) => { let l = lanes.findIndex((end) => end < sg.s); if (l < 0) l = lanes.length; lanes[l] = sg.e; return { ...sg, lane: l } })
          const rows = Math.max(1, lanes.length)
          return (
            <div className="db-cal-week" key={w[0]} style={{ gridTemplateRows: `auto repeat(${rows}, minmax(22px, auto)) 1fr` }} role="row">
              {w.map((day, i) => (
                <div key={day} role="gridcell" data-day={day} aria-label={formatCivil(day, { calendar: cal, locale: locale() })}
                  className={'db-day-cell' + (day === today ? ' today' : '') + (inMonth(day) ? '' : ' out') + (weekend.includes(weekdayOf(day)) ? ' weekend' : '') + (over === day ? ' over' : '') + (selDay === day ? ' sel' : '')}
                  style={{ gridColumn: i + 1, gridRow: `1 / span ${rows + 2}` }}
                  onDragOver={(e) => { if (dragId) { e.preventDefault(); setOver(day) } }} onDragLeave={() => setOver(null)} onDrop={() => void dropOn(day)}
                  onClick={() => setSelDay(day)} onDoubleClick={() => void create(day)}>
                  <span className="db-day-n">{dayNum(day)}</span>
                </div>
              ))}
              {placed.map(({ it, s, e, lane, clipL, clipR }) => (
                <div key={it.pageId + w[0]} className={'db-ev' + (clipL ? ' cl' : '') + (clipR ? ' cr' : '') + (dragId === it.pageId ? ' dragging' : '')} style={{ gridColumn: `${s + 1} / ${e + 2}`, gridRow: lane + 2 }}
                  role="button" tabIndex={0} draggable={editable} title={it.title}
                  onDragStart={(ev) => { ev.dataTransfer.setData('text/plain', it.pageId); setDragId(it.pageId) }} onDragEnd={() => setDragId(null)}
                  onClick={(ev) => { ev.stopPropagation(); nav.openRow(it.pageId, 'side') }} onKeyDown={(ev) => ev.key === 'Enter' && nav.openRow(it.pageId, 'side')}>
                  {editable && !clipL && <span className="db-ev-h start" onPointerDown={(ev) => startResize(ev, it, 'start')} />}
                  <span className="db-ev-t" dir="auto">{!it.allDay && <small>{new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(it.startMs)} </small>}{plainTitle(it.title)}</span>
                  {editable && !clipR && <span className="db-ev-h end" onPointerDown={(ev) => startResize(ev, it, 'end')} />}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {selDay && (
        <div className="db-cal-day" aria-label={t('Items on {d}', { d: formatCivil(selDay, { calendar: cal, locale: locale() }) })}>
          <b>{formatCivil(selDay, { calendar: cal, locale: locale() })}</b>
          {model.items.filter((it) => it.startCivil <= selDay && it.endCivil >= selDay).map((it) => <button key={it.pageId} type="button" className="db-listrow" onClick={() => nav.openRow(it.pageId, 'side')}>{plainTitle(it.title)}</button>)}
          {ctl.canEditRows && model.editable && <button type="button" className="db-linkbtn" onClick={() => void create(selDay)}><Ic.Plus size={12} /> {t('New item on this day')}</button>}
        </div>
      )}
      <div className="db-tray" aria-label={t('Items without a date')}>
        <b>{t('No date')} <span className="db-count">{model.unscheduled.length}</span></b>
        <div className="db-tray-list">
          {model.unscheduled.slice(0, 60).map((id) => <span key={id} className="db-chip tray" draggable={editable} onDragStart={(e) => { e.dataTransfer.setData('text/plain', id); setDragId(id) }} onDragEnd={() => setDragId(null)} onClick={() => nav.openRow(id, 'side')}>{plainTitle(svc.state.pages.get(id)?.title)}</span>)}
          {model.unscheduled.length === 0 && <span className="db-empty-hint">{t('Every item has a date')}</span>}
        </div>
      </div>
    </div>
  )
}

// ───── Timeline ─────

type Scale = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'
const UNIT_MS: Record<Scale, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30.4375 * 86_400_000, quarter: 91.3125 * 86_400_000, year: 365.25 * 86_400_000 }
const UNIT_PX: Record<Scale, number> = { hour: 36, day: 44, week: 110, month: 120, quarter: 140, year: 160 }
const ROW_H = 32
const HEAD_H = 38

export function TimelineView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const def = dateProp(svc, view)
  const zone = svc.zone
  const scale = ((cfg.scale as string) ?? 'week') as Scale
  const showTable = cfg.showTable !== false
  const showDeps = cfg.showDependencies !== false
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 5000 })
  const [scroll, setScroll] = useState({ x: 0, y: 0, w: 900, h: 500 })
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ id: Id; mode: 'move' | 'start' | 'end'; x0: number; dx: number } | null>(null)
  const today = civilOf(svc.now(), zone)
  const px = UNIT_PX[scale] / UNIT_MS[scale] // pixels per millisecond
  const model = def ? scheduleModel(svc.state, ctl.rs, q.matchIds, def.id, '1900-01-01', '2200-12-31', zone) : null
  const { origin, items } = useMemo(() => {
    const its = model?.items ?? []
    const t0 = its.length ? Math.min(...its.map((i) => i.startMs)) : startOfDayMs(today, zone)
    const first = Math.min(t0, startOfDayMs(today, zone)) - UNIT_MS[scale] * 4
    return { origin: first, items: its }
  }, [model?.items.length, scale, today, zone]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!def || !model) return <div className="db-error-box"><b>{t('Choose a date property')}</b><p>{t('Open View settings and pick the date range to show.')}</p></div>
  if (q.error) return <div className="db-error-box" role="alert">{errorText(q.error.code, q.error.message)}</div>
  const lastEnd = items.length ? Math.max(...items.map((i) => i.endMs)) : origin
  const total = Math.max(scroll.w * 1.5, (Math.max(lastEnd, startOfDayMs(today, zone)) - origin + UNIT_MS[scale] * 8) * px)
  const xOf = (ms: number) => (ms - origin) * px
  const editable = model.editable && ctl.canEditRows
  const rows = items
  const first = Math.max(0, Math.floor(scroll.y / ROW_H) - 4)
  const last = Math.min(rows.length, Math.ceil((scroll.y + scroll.h) / ROW_H) + 4)
  // axis ticks (only those on screen)
  const tickMs = UNIT_MS[scale]
  const t0 = Math.floor((scroll.x / px + origin - tickMs) / tickMs) * tickMs
  const ticks: { x: number; label: string; top?: string }[] = []
  for (let ms = t0; xOf(ms) < scroll.x + scroll.w + 200; ms += tickMs) {
    if (xOf(ms) < scroll.x - 200) continue
    const c = civilOf(ms, zone)
    ticks.push({ x: xOf(ms), label: scale === 'hour' ? new Intl.DateTimeFormat(locale(), { hour: '2-digit', hour12: false, timeZone: zone }).format(ms) : scale === 'day' ? String(parseCivil(c).d) : scale === 'week' ? formatCivil(c, { locale: locale() }).replace(/\s?\d{4}$/, '') : scale === 'month' ? new Intl.DateTimeFormat(locale(), { month: 'short', year: '2-digit', timeZone: zone }).format(ms) : scale === 'quarter' ? `Q${Math.floor((parseCivil(c).m - 1) / 3) + 1} ${parseCivil(c).y}` : String(parseCivil(c).y) })
  }
  const commit = async (it: ScheduleItem, mode: 'move' | 'start' | 'end', dxPx: number) => {
    const deltaMs = dxPx / px
    const days = Math.round(deltaMs / UNIT_MS.day)
    const hours = Math.round(deltaMs / UNIT_MS.hour)
    if (scale === 'hour') {
      const cell = svc.state.row(it.pageId)?.ext.cells[def.id]?.value
      if (cell?.kind === 'date' && cell.value?.kind === 'datetime' && hours) {
        const v = cell.value
        const s = Date.parse(v.start) + (mode !== 'end' ? hours * UNIT_MS.hour : 0)
        const e = v.end ? Date.parse(v.end) + (mode !== 'start' ? hours * UNIT_MS.hour : 0) : null
        if (e !== null && e < s) return ctl.notice(t('The end cannot be before the start.'))
        const r = await svc.tryExec([{ type: 'row.patch', payload: { pageId: it.pageId, cellChanges: { [def.id]: { kind: 'date', value: { ...v, start: toIso(s), end: e === null ? null : toIso(e) } } as unknown as Json } } }])
        if (!r.ok) ctl.notice(errorText(r.code, r.message))
        return
      }
    }
    if (!days) return
    const plan = planDateDrag(svc.state, { pageId: it.pageId, datePropertyId: def.id, mode: mode === 'move' ? 'move' : mode === 'start' ? 'resize_start' : 'resize_end', days, zone })
    if (!plan.ok) return ctl.notice(plan.reason)
    const r = await svc.tryExec(plan.commands.map((c) => ({ type: c.type, payload: c.payload })))
    if (!r.ok) ctl.notice(errorText(r.code, r.message))
  }
  const startDrag = (e: React.PointerEvent, it: ScheduleItem, mode: 'move' | 'start' | 'end') => {
    if (!editable) return
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    setDrag({ id: it.pageId, mode, x0, dx: 0 })
    const move = (ev: PointerEvent) => setDrag({ id: it.pageId, mode, x0, dx: ev.clientX - x0 })
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      void commit(it, mode, ev.clientX - x0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const pos = new Map<Id, { x1: number; x2: number; y: number }>()
  rows.forEach((it, i) => pos.set(it.pageId, { x1: xOf(it.startMs), x2: xOf(it.endMs), y: i * ROW_H + ROW_H / 2 }))
  const arrows = showDeps && view.sourceId ? dependencyArrows(svc.state, view.sourceId, new Set(rows.map((r) => r.pageId))) : []
  const todayX = xOf(startOfDayMs(today, zone))

  return (
    <div className="db-tl" data-table={showTable}>
      {!model.editable && <div className="db-date-hint">{t('This date is calculated, so bars cannot be dragged.')}</div>}
      <div className="db-tl-main">
        {showTable && (
          <div className="db-tl-table" style={{ paddingTop: HEAD_H }}>
            <div style={{ transform: `translateY(${-scroll.y}px)` }}>
              {rows.map((it) => <button type="button" key={it.pageId} className="db-tl-trow" style={{ height: ROW_H }} onClick={() => nav.openRow(it.pageId, 'side')} dir="auto">{plainTitle(it.title)}</button>)}
            </div>
          </div>
        )}
        <div className="db-tl-scroll" ref={box} onScroll={(e) => { const el = e.currentTarget; setScroll({ x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight }) }}>
          <div className="db-tl-canvas" style={{ width: total, height: HEAD_H + rows.length * ROW_H }}>
            <div className="db-tl-axis" style={{ height: HEAD_H }}>{ticks.map((tk) => <span key={tk.x} style={{ insetInlineStart: tk.x }}>{tk.label}</span>)}</div>
            {ticks.map((tk) => <i key={'g' + tk.x} className="db-tl-grid" style={{ insetInlineStart: tk.x, top: HEAD_H }} />)}
            <i className="db-tl-today" style={{ insetInlineStart: todayX, top: 0 }} title={t('Today')} />
            <div className="db-tl-rows" style={{ top: HEAD_H }}>
              {rows.slice(first, last).map((it, k) => {
                const i = first + k
                const d = drag?.id === it.pageId ? drag : null
                const left = xOf(it.startMs) + (d && d.mode !== 'end' ? d.dx : 0)
                const right = xOf(it.endMs) + (d && d.mode !== 'start' ? d.dx : 0)
                return (
                  <div key={it.pageId} className={'db-tl-bar' + (d ? ' dragging' : '')} style={{ top: i * ROW_H + 5, height: ROW_H - 10, insetInlineStart: left, width: Math.max(10, right - left) }} role="button" tabIndex={0} title={it.title} onClick={() => nav.openRow(it.pageId, 'side')} onKeyDown={(e) => e.key === 'Enter' && nav.openRow(it.pageId, 'side')} onPointerDown={(e) => startDrag(e, it, 'move')}>
                    {editable && <span className="db-ev-h start" onPointerDown={(e) => startDrag(e, it, 'start')} />}
                    <span className="db-ev-t" dir="auto">{plainTitle(it.title)}</span>
                    {editable && <span className="db-ev-h end" onPointerDown={(e) => startDrag(e, it, 'end')} />}
                  </div>
                )
              })}
            </div>
            {arrows.length > 0 && (
              <svg className="db-tl-arrows" width={total} height={HEAD_H + rows.length * ROW_H} style={{ top: 0 }} aria-hidden>
                {arrows.map((a, i) => {
                  const f = pos.get(a.from)
                  const to = pos.get(a.to)
                  if (!f || !to) return null
                  const y1 = HEAD_H + f.y
                  const y2 = HEAD_H + to.y
                  return <path key={i} d={`M ${f.x2} ${y1} C ${f.x2 + 20} ${y1}, ${to.x1 - 20} ${y2}, ${to.x1} ${y2}`} fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.55" markerEnd="url(#tl-arrow)" />
                })}
                <defs><marker id="tl-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor" /></marker></defs>
              </svg>
            )}
          </div>
        </div>
      </div>
      <div className="db-tray" aria-label={t('Items without a date')}>
        <b>{t('No date')} <span className="db-count">{model.unscheduled.length}</span></b>
        <div className="db-tray-list">
          {model.unscheduled.slice(0, 60).map((id) => (
            <span key={id} className="db-chip tray" onClick={() => nav.openRow(id, 'side')}>
              {plainTitle(svc.state.pages.get(id)?.title)}
              {editable && <button type="button" className="db-chip-x" aria-label={t('Give it today’s date')} onClick={(e) => { e.stopPropagation(); void svc.tryExec([{ type: 'row.patch', payload: { pageId: id, cellChanges: { [def.id]: { kind: 'date', value: { kind: 'date', start: today, end: null } } } } }]) }}>＋</button>}
            </span>
          ))}
        </div>
      </div>
      <Chip muted>{t('Scale')}: {t(scale[0].toUpperCase() + scale.slice(1))}</Chip>
    </div>
  )
}

export { dateInterval }
