// Calendar and Timeline. Both read one date property (or a range), show undated items in an explicit tray, and turn drags into the
// same `row.patch` / `date.shift` commands the table uses (viewLogic.planDateDrag), so dependency shifting and DST rules apply everywhere.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Definition, Id, Json } from '../model/types.ts'
import {
  addDays,
  addMonths,
  civilOf,
  civilToJalali,
  diffDays,
  formatCivil,
  jalaliMonthLength,
  jalaliToCivil,
  parseCivil,
  startOfDayMs,
  startOfWeek,
  toIso,
  weekdayOf,
  JALALI_MONTHS,
} from '../dates.ts'
import { cfgOf } from '../props/config.ts'
import { dependencyArrows, planDateDrag, scheduleModel, type ScheduleItem } from '../viewLogic.ts'
import { Button, Icon, IconButton, Segmented, dirOf } from '../../design-system'
import { locale, t } from '../../i18n'
import { HorizontalScroll } from '../../HorizontalScroll'
import { Hint, ViewMessage, errorText, plainTitle } from './common'
import { useNav } from './CellView'
import { faDigits, monthGrid } from './DatePicker'
import { useViewQuery } from './useViewQuery'
import type { ViewProps } from './viewTypes'

function dateProp(svc: ViewProps['svc'], view: ViewProps['view']): Definition | undefined {
  const id = (view.configuration as { datePropertyId?: Id }).datePropertyId
  return id ? svc.state.prop(id) : undefined
}
const WEEKEND = (weekStart: number) => (weekStart === 6 ? [5] : [6, 7])

/** Items that have no date yet: open one, drag it onto a day, or give it today's date. */
function Undated({
  svc,
  ids,
  onOpen,
  onDragStart,
  onDragEnd,
  onToday,
}: {
  svc: ViewProps['svc']
  ids: Id[]
  onOpen: (id: Id) => void
  onDragStart?: (id: Id) => void
  onDragEnd?: () => void
  onToday?: (id: Id) => void
}) {
  if (!ids.length) return null
  return (
    <section className="dv-tray" aria-label={t('Items without a date')}>
      <h3 className="dv-section-head">
        {t('No date')}
        <span className="ds-badge">{ids.length}</span>
      </h3>
      <div className="dv-tray-list">
        {ids.slice(0, 60).map((id) => (
          <span key={id} className="dv-tray-item" draggable={!!onDragStart} onDragStart={(e) => (e.dataTransfer.setData('text/plain', id), onDragStart?.(id))} onDragEnd={onDragEnd}>
            <button type="button" className="dv-tray-open" dir="auto" onClick={() => onOpen(id)}>
              {plainTitle(svc.state.pages.get(id)?.title)}
            </button>
            {onToday && (
              <IconButton label={t('Give it today’s date')} onClick={() => onToday(id)}>
                <Icon name="calendar" size={14} />
              </IconButton>
            )}
          </span>
        ))}
        {ids.length > 60 && <span className="dv-hint">{t('{n} more', { n: ids.length - 60 })}</span>}
      </div>
    </section>
  )
}

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
  const days = useMemo(
    () => (mode === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor, svc.weekStart), i)) : monthGrid(anchor, cal, svc.weekStart).map((d) => d.civil)),
    [anchor, mode, cal, svc.weekStart],
  )
  if (!def) return <ViewMessage title={t('Choose a date property')}>{t('Open View settings and pick the date to show items by.')}</ViewMessage>
  if (q.error)
    return (
      <ViewMessage tone="bad" title={t('This view cannot be shown')}>
        {errorText(q.error.code, q.error.message)}
      </ViewMessage>
    )
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
    if (cal === 'jalali') {
      const j = civilToJalali(anchor)
      return `${JALALI_MONTHS[j.m - 1]} ${fa ? faDigits(j.y) : j.y}`
    }
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
  const dayAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-day]')?.dataset.day ?? null
  const startResize = (e: React.PointerEvent, it: ScheduleItem, side: 'start' | 'end') => {
    e.preventDefault()
    e.stopPropagation()
    resize.current = { id: it.pageId, side, from: side === 'start' ? it.startCivil : it.endCivil }
    const move = (ev: PointerEvent) => setOver(dayAt(ev.clientX, ev.clientY))
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      void endResize(dayAt(ev.clientX, ev.clientY))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const create = async (day: string) => {
    if (!ctl.canEditRows || !model.editable) return
    const r = await ctl.createRow({ context: [{ propertyId: def.id, cell: { kind: 'date', value: { kind: 'date', start: day, end: null } } }] })
    if (r) nav.openRow(r.pageId, 'side')
  }
  const names = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(today, svc.weekStart), i)).map((c) =>
    new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(parseCivil(c).y, parseCivil(c).m - 1, parseCivil(c).d))),
  )
  const dayItems = selDay ? model.items.filter((it) => it.startCivil <= selDay && it.endCivil >= selDay) : []

  return (
    <div className="dv-cal" data-mode={mode}>
      <header className="dv-period">
        <IconButton label={t('Previous')} onClick={() => shiftNav(-1)}>
          <Icon name="chevron-left" size={16} className="ds-flip" />
        </IconButton>
        <IconButton label={t('Next')} onClick={() => shiftNav(1)}>
          <Icon name="chevron-right" size={16} className="ds-flip" />
        </IconButton>
        <h3 className="dv-period-title">{title}</h3>
        <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>
          {t('Today')}
        </Button>
        <span className="dv-period-end">
          <Segmented
            label={t('Mode')}
            value={mode}
            onChange={(v) => void ctl.patch({ calendarMode: v })}
            options={[
              { value: 'month', label: t('Month') },
              { value: 'week', label: t('Week') },
            ]}
          />
        </span>
      </header>
      {!model.editable && <Hint>{t('This date is calculated, so items cannot be dragged. Change its inputs instead.')}</Hint>}
      <div className="dv-cal-frame">
        <div className="dv-cal-wd" aria-hidden>
          {names.map((n, i) => (
            <span key={i}>{n}</span>
          ))}
        </div>
        <div className="dv-cal-weeks" role="grid" aria-label={title}>
          {weeks.map((w) => {
            const segs = model.items
              .map((it) => {
                const s = it.startCivil < w[0] ? w[0] : it.startCivil
                const e = it.endCivil > w[6] ? w[6] : it.endCivil
                return s > w[6] || e < w[0] ? null : { it, s: diffDays(s, w[0]), e: diffDays(e, w[0]), clipS: it.startCivil < w[0], clipE: it.endCivil > w[6] }
              })
              .filter((x): x is NonNullable<typeof x> => !!x)
              .sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s))
            const lanes: number[] = []
            const placed = segs.map((sg) => {
              let l = lanes.findIndex((end) => end < sg.s)
              if (l < 0) l = lanes.length
              lanes[l] = sg.e
              return { ...sg, lane: l }
            })
            const rows = Math.max(1, lanes.length)
            return (
              <div className="dv-cal-week" key={w[0]} style={{ gridTemplateRows: `32px repeat(${rows}, minmax(24px, auto)) 1fr` }} role="row">
                {w.map((day, i) => (
                  <div
                    key={day}
                    role="gridcell"
                    data-day={day}
                    aria-label={formatCivil(day, { calendar: cal, locale: locale() })}
                    aria-selected={selDay === day}
                    className="dv-cal-day"
                    data-today={day === today || undefined}
                    data-out={!inMonth(day) || undefined}
                    data-weekend={weekend.includes(weekdayOf(day)) || undefined}
                    data-over={over === day || undefined}
                    style={{ gridColumn: i + 1, gridRow: `1 / span ${rows + 2}` }}
                    onDragOver={(e) => {
                      if (dragId) {
                        e.preventDefault()
                        if (over !== day) setOver(day)
                      }
                    }}
                    onDrop={() => void dropOn(day)}
                    onClick={() => setSelDay(day === selDay ? null : day)}
                    onDoubleClick={() => void create(day)}
                  >
                    <span className="dv-cal-n">{dayNum(day)}</span>
                  </div>
                ))}
                {placed.map(({ it, s, e, lane, clipS, clipE }) => (
                  <div
                    key={it.pageId + w[0]}
                    className="dv-event"
                    data-clip-start={clipS || undefined}
                    data-clip-end={clipE || undefined}
                    data-dragging={dragId === it.pageId || undefined}
                    style={{ gridColumn: `${s + 1} / ${e + 2}`, gridRow: lane + 2 }}
                    role="button"
                    tabIndex={0}
                    draggable={editable}
                    title={it.title}
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData('text/plain', it.pageId)
                      setDragId(it.pageId)
                    }}
                    onDragEnd={() => (setDragId(null), setOver(null))}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      nav.openRow(it.pageId, 'side')
                    }}
                    onKeyDown={(ev) => ev.key === 'Enter' && nav.openRow(it.pageId, 'side')}
                  >
                    {editable && !clipS && <span className="dv-event-edge" data-side="start" onPointerDown={(ev) => startResize(ev, it, 'start')} />}
                    <span className="dv-event-t" dir={dirOf(it.title)}>
                      {!it.allDay && <small>{new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(it.startMs)} </small>}
                      <span dir="auto">{plainTitle(it.title)}</span>
                    </span>
                    {editable && !clipE && <span className="dv-event-edge" data-side="end" onPointerDown={(ev) => startResize(ev, it, 'end')} />}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
      {selDay && (
        <section className="dv-cal-dayview" aria-label={t('Items on {d}', { d: formatCivil(selDay, { calendar: cal, locale: locale() }) })}>
          <h3 className="dv-section-head">
            {formatCivil(selDay, { calendar: cal, locale: locale() })}
            <span className="ds-badge">{dayItems.length}</span>
          </h3>
          {dayItems.length > 0 && (
            <div className="ds-list ds-list--framed">
              {dayItems.map((it) => (
                <button key={it.pageId} type="button" className="ds-list-row" onClick={() => nav.openRow(it.pageId, 'side')}>
                  <span className="dv-listrow-title" dir="auto">
                    {plainTitle(it.title)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {ctl.canEditRows && model.editable && (
            <Button size="sm" variant="ghost" icon={<Icon name="plus" size={15} />} onClick={() => void create(selDay)}>
              {t('New item on this day')}
            </Button>
          )}
        </section>
      )}
      <Undated svc={svc} ids={model.unscheduled} onOpen={(id) => nav.openRow(id, 'side')} onDragStart={editable ? setDragId : undefined} onDragEnd={() => (setDragId(null), setOver(null))} />
    </div>
  )
}

// ───── Timeline ─────

type Scale = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'
const UNIT_MS: Record<Scale, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30.4375 * 86_400_000, quarter: 91.3125 * 86_400_000, year: 365.25 * 86_400_000 }
const UNIT_PX: Record<Scale, number> = { hour: 36, day: 44, week: 110, month: 120, quarter: 140, year: 160 }
const ROW_H = 36
const HEAD_H = 40

export function TimelineView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as Record<string, Json>
  const nav = useNav()
  const def = dateProp(svc, view)
  const zone = svc.zone
  const scale = ((cfg.scale as string) ?? 'week') as Scale
  const showTable = cfg.showTable !== false
  const showDeps = cfg.showDependencies !== false
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 5000 })
  const [scroll, setScroll] = useState({ x: 0, w: 900 })
  const box = useRef<HTMLDivElement>(null)
  const [pageWindow, setPageWindow] = useState({ top: 0, height: 800 })
  useLayoutEffect(() => {
    const el = box.current,
      host = el?.closest<HTMLElement>('.scroller, .dv-peek-body')
    if (!el || !host) return
    const measure = () => {
      setPageWindow({ top: Math.max(0, host.getBoundingClientRect().top - el.getBoundingClientRect().top - HEAD_H), height: host.clientHeight })
      setScroll((s) => (s.w === el.clientWidth ? s : { ...s, w: el.clientWidth }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    ro.observe(el)
    host.addEventListener('scroll', measure, { passive: true })
    return () => {
      ro.disconnect()
      host.removeEventListener('scroll', measure)
    }
  }, [q.matchIds.length, def?.id, showTable])
  const [drag, setDrag] = useState<{ id: Id; mode: 'move' | 'start' | 'end'; x0: number; dx: number } | null>(null)
  const today = civilOf(svc.now(), zone)
  const px = UNIT_PX[scale] / UNIT_MS[scale] // pixels per millisecond
  const model = def ? scheduleModel(svc.state, ctl.rs, q.matchIds, def.id, '1900-01-01', '2200-12-31', zone) : null
  // items follow every edit (a moved bar must move); the origin only shifts when the earliest start does, so scrolling stays put
  const items = model?.items ?? []
  const earliest = items.length ? Math.min(...items.map((i) => i.startMs)) : Infinity
  const origin = useMemo(() => Math.min(earliest, startOfDayMs(today, zone)) - UNIT_MS[scale] * 4, [earliest, scale, today, zone])
  // Open on today (a third of the way in), not on the earliest item: once per view and scale, so scrolling is left alone after.
  const opened = useRef('')
  useLayoutEffect(() => {
    const el = box.current
    const key = view.id + ':' + scale
    if (!el || opened.current === key || !el.clientWidth) return
    opened.current = key
    const x = Math.max(0, (startOfDayMs(today, zone) - origin) * px - el.clientWidth / 3)
    el.scrollLeft = getComputedStyle(el).direction === 'rtl' ? -x : x
    setScroll({ x, w: el.clientWidth })
  })
  if (!def || !model) return <ViewMessage title={t('Choose a date property')}>{t('Open View settings and pick the date range to show.')}</ViewMessage>
  if (q.error)
    return (
      <ViewMessage tone="bad" title={t('This view cannot be shown')}>
        {errorText(q.error.code, q.error.message)}
      </ViewMessage>
    )
  const lastEnd = items.length ? Math.max(...items.map((i) => i.endMs)) : origin
  const total = Math.max(scroll.w * 1.5, (Math.max(lastEnd, startOfDayMs(today, zone)) - origin + UNIT_MS[scale] * 8) * px)
  const xOf = (ms: number) => (ms - origin) * px
  const editable = model.editable && ctl.canEditRows
  const rows = items
  const first = Math.min(Math.max(0, rows.length - 1), Math.max(0, Math.floor(pageWindow.top / ROW_H) - 6))
  const last = Math.min(rows.length, Math.ceil((pageWindow.top + pageWindow.height) / ROW_H) + 6)
  // axis ticks (only those on screen)
  const tickMs = UNIT_MS[scale]
  const t0 = Math.floor((scroll.x / px + origin - tickMs) / tickMs) * tickMs
  const ticks: { x: number; label: string }[] = []
  for (let ms = t0; xOf(ms) < scroll.x + scroll.w + 200; ms += tickMs) {
    if (xOf(ms) < scroll.x - 200) continue
    const c = civilOf(ms, zone)
    ticks.push({
      x: xOf(ms),
      label:
        scale === 'hour'
          ? new Intl.DateTimeFormat(locale(), { hour: '2-digit', hour12: false, timeZone: zone }).format(ms)
          : scale === 'day'
            ? String(parseCivil(c).d)
            : scale === 'week'
              ? formatCivil(c, { locale: locale() }).replace(/\s?\d{4}$/, '')
              : scale === 'month'
                ? new Intl.DateTimeFormat(locale(), { month: 'short', year: '2-digit', timeZone: zone }).format(ms)
                : scale === 'quarter'
                  ? `Q${Math.floor((parseCivil(c).m - 1) / 3) + 1} ${parseCivil(c).y}`
                  : String(parseCivil(c).y),
    })
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
        const r = await svc.tryExec([
          { type: 'row.patch', payload: { pageId: it.pageId, cellChanges: { [def.id]: { kind: 'date', value: { ...v, start: toIso(s), end: e === null ? null : toIso(e) } } as unknown as Json } } },
        ])
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
  const rtl = () => (box.current ? getComputedStyle(box.current).direction === 'rtl' : false)
  const startDrag = (e: React.PointerEvent, it: ScheduleItem, mode: 'move' | 'start' | 'end') => {
    if (!editable || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const sign = rtl() ? -1 : 1
    let moved = false
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true
      if (moved) setDrag({ id: it.pageId, mode, x0, dx: (ev.clientX - x0) * sign })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (moved) void commit(it, mode, (ev.clientX - x0) * sign)
      else if (mode === 'move') nav.openRow(it.pageId, 'side')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const pos = new Map<Id, { x1: number; x2: number; y: number }>()
  rows.forEach((it, i) => pos.set(it.pageId, { x1: xOf(it.startMs), x2: xOf(it.endMs), y: i * ROW_H + ROW_H / 2 }))
  const arrows = showDeps && view.sourceId ? dependencyArrows(svc.state, view.sourceId, new Set(rows.map((r) => r.pageId))) : []
  const todayX = xOf(startOfDayMs(today, zone))

  return (
    <div className="dv-tl">
      <header className="dv-period">
        <h3 className="dv-period-title">{t('{n} items', { n: rows.length })}</h3>
        <span className="dv-period-end">
          <Segmented
            label={t('Scale')}
            value={scale}
            onChange={(v) => void ctl.patch({ scale: v })}
            options={[
              { value: 'day', label: t('Day') },
              { value: 'week', label: t('Week') },
              { value: 'month', label: t('Month') },
              { value: 'quarter', label: t('Quarter') },
            ]}
          />
        </span>
      </header>
      {!model.editable && <Hint>{t('This date is calculated, so bars cannot be dragged.')}</Hint>}
      <div className="dv-tl-frame" data-table={showTable || undefined}>
        {showTable && (
          <div className="dv-tl-names" style={{ paddingTop: HEAD_H }}>
            {rows.map((it) => (
              <button type="button" key={it.pageId} className="dv-tl-name" dir={dirOf(it.title)} style={{ height: ROW_H }} onClick={() => nav.openRow(it.pageId, 'side')} title={it.title}>
                <span dir="auto">{plainTitle(it.title)}</span>
              </button>
            ))}
          </div>
        )}
        <HorizontalScroll
          className="dv-tl-track"
          viewportClassName="dv-tl-scroll"
          viewportRef={box}
          label={t('Timeline')}
          viewportProps={{
            onScroll: (e) => {
              const el = e.currentTarget
              setScroll({ x: Math.abs(el.scrollLeft), w: el.clientWidth })
            },
          }}
        >
          <div className="dv-tl-canvas" style={{ width: total, height: HEAD_H + rows.length * ROW_H }}>
            <div className="dv-tl-axis" style={{ height: HEAD_H }}>
              {ticks.map((tk) => (
                <span key={tk.x} style={{ insetInlineStart: tk.x }}>
                  {tk.label}
                </span>
              ))}
            </div>
            {ticks.map((tk) => (
              <i key={'g' + tk.x} className="dv-tl-grid" style={{ insetInlineStart: tk.x, top: HEAD_H }} />
            ))}
            <i className="dv-tl-today" style={{ insetInlineStart: todayX }} title={t('Today')} />
            <div className="dv-tl-rows" style={{ top: HEAD_H }}>
              {rows.slice(first, last).map((it, k) => {
                const i = first + k
                const d = drag?.id === it.pageId ? drag : null
                const left = xOf(it.startMs) + (d && d.mode !== 'end' ? d.dx : 0)
                const right = xOf(it.endMs) + (d && d.mode !== 'start' ? d.dx : 0)
                return (
                  <div
                    key={it.pageId}
                    className="dv-tl-bar"
                    data-dragging={d ? true : undefined}
                    data-narrow={right - left < 96 || undefined}
                    style={{ top: i * ROW_H + 6, height: ROW_H - 12, insetInlineStart: left, width: Math.max(12, right - left) }}
                    role="button"
                    tabIndex={0}
                    title={it.title}
                    onClick={() => !editable && nav.openRow(it.pageId, 'side')}
                    onKeyDown={(e) => e.key === 'Enter' && nav.openRow(it.pageId, 'side')}
                    onPointerDown={(e) => startDrag(e, it, 'move')}
                  >
                    {editable && <span className="dv-event-edge" data-side="start" onPointerDown={(e) => startDrag(e, it, 'start')} />}
                    <span className="dv-event-t" dir={dirOf(it.title)}>
                      <span dir="auto">{plainTitle(it.title)}</span>
                    </span>
                    {editable && <span className="dv-event-edge" data-side="end" onPointerDown={(e) => startDrag(e, it, 'end')} />}
                  </div>
                )
              })}
            </div>
            {arrows.length > 0 && (
              <svg className="dv-tl-arrows" width={total} height={HEAD_H + rows.length * ROW_H} aria-hidden>
                <defs>
                  <marker id="dv-tl-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
                  </marker>
                </defs>
                {arrows.map((a, i) => {
                  const f = pos.get(a.from)
                  const to = pos.get(a.to)
                  if (!f || !to) return null
                  const y1 = HEAD_H + f.y
                  const y2 = HEAD_H + to.y
                  return (
                    <path key={i} d={`M ${f.x2} ${y1} C ${f.x2 + 20} ${y1}, ${to.x1 - 20} ${y2}, ${to.x1} ${y2}`} fill="none" stroke="currentColor" strokeWidth="1.4" markerEnd="url(#dv-tl-arrow)" />
                  )
                })}
              </svg>
            )}
          </div>
        </HorizontalScroll>
      </div>
      <Undated
        svc={svc}
        ids={model.unscheduled}
        onOpen={(id) => nav.openRow(id, 'side')}
        onToday={
          editable
            ? (id) => void svc.tryExec([{ type: 'row.patch', payload: { pageId: id, cellChanges: { [def.id]: { kind: 'date', value: { kind: 'date', start: today, end: null } } } } }])
            : undefined
        }
      />
    </div>
  )
}
