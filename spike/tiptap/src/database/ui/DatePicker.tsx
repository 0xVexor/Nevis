// Date editor: month grid (Gregorian or Jalali, the stored value is always Gregorian), range toggle, time toggle, zone.
import { useMemo, useState } from 'react'
import type { DateValue } from '../model/types.ts'
import {
  addDays, civilOf, civilParts, civilString, civilToDays, civilToJalali, civilToTimed, formatCivil, isValidZone, jalaliMonthLength, jalaliToCivil, parseCivil,
  parseIsoInstant, startOfWeek, timedToCivil, zonedParts, zonedToEpochDetailed, JALALI_MONTHS, toIso,
} from '../dates.ts'
import type { DateConfig } from '../props/config.ts'
import { locale, t } from '../../i18n'
import { Select } from '../../ui'
import * as Ic from '../../icons'

type Props = {
  value: DateValue | null
  config: DateConfig
  zone: string
  weekStart: number
  todayCivil: string
  onChange: (v: DateValue | null) => void
  onClose: () => void
}

const WD = { en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], fa: ['د', 'س', 'چ', 'پ', 'ج', 'ش', 'ی'] }

export function monthGrid(anchor: string, cal: 'gregorian' | 'jalali', weekStart: number): { civil: string; inMonth: boolean }[] {
  if (cal === 'gregorian') {
    const { y, m } = parseCivil(anchor)
    const first = civilString(y, m, 1)
    const start = startOfWeek(first, weekStart)
    return Array.from({ length: 42 }, (_, i) => {
      const c = addDays(start, i)
      return { civil: c, inMonth: parseCivil(c).m === m }
    })
  }
  const j = civilToJalali(anchor)
  const first = jalaliToCivil(j.y, j.m, 1)
  const start = startOfWeek(first, weekStart)
  return Array.from({ length: 42 }, (_, i) => {
    const c = addDays(start, i)
    return { civil: c, inMonth: civilToJalali(c).m === j.m }
  })
}

const pad = (n: number) => String(n).padStart(2, '0')
const timeOf = (iso: string, zone: string) => {
  const p = zonedParts(parseIsoInstant(iso, zone)!, zone)
  return `${pad(p.h)}:${pad(p.mi)}`
}

export function DatePicker({ value, config, zone, weekStart, todayCivil, onChange, onClose }: Props) {
  const cal = config.displayCalendar
  const vz = value?.kind === 'datetime' ? (value.timeZone ?? zone) : zone
  const startCivil = value ? (value.kind === 'date' ? value.start : civilOf(parseIsoInstant(value.start, vz)!, vz)) : null
  const endCivil = value?.end ? (value.kind === 'date' ? value.end : civilOf(parseIsoInstant(value.end, vz)!, vz)) : null
  const [anchor, setAnchor] = useState(startCivil ?? todayCivil)
  const [pickingEnd, setPickingEnd] = useState(false)
  const hasTime = value?.kind === 'datetime'
  const isRange = !!value?.end
  const grid = useMemo(() => monthGrid(anchor, cal, weekStart), [anchor, cal, weekStart])
  const fa = locale().startsWith('fa')
  const names = (fa ? WD.fa : WD.en)
  const header = (() => {
    if (cal === 'jalali') {
      const j = civilToJalali(anchor)
      return `${JALALI_MONTHS[j.m - 1]} ${fa ? String(j.y).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]) : j.y}`
    }
    return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(civilToDays(anchor) * 86400000))
  })()
  const shift = (n: number) => {
    if (cal === 'gregorian') {
      const { y, m, d } = parseCivil(anchor)
      const tot = y * 12 + (m - 1) + n
      const ny = Math.floor(tot / 12)
      const nm = (tot % 12) + 1
      setAnchor(civilString(ny, nm, Math.min(d, 28)))
    } else {
      const j = civilToJalali(anchor)
      const tot = j.y * 12 + (j.m - 1) + n
      const ny = Math.floor(tot / 12)
      const nm = (tot % 12) + 1
      setAnchor(jalaliToCivil(ny, nm, Math.min(j.d, jalaliMonthLength(ny, nm))))
    }
  }
  const dayLabel = (c: string) => (cal === 'jalali' ? (fa ? String(civilToJalali(c).d).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]) : civilToJalali(c).d) : parseCivil(c).d)

  const build = (s: string, e: string | null, timed: { s: string; e: string; zone: string } | null): DateValue => {
    if (timed) {
      const [sh, sm] = timed.s.split(':').map(Number)
      const st = zonedToEpochDetailed(civilParts(s, sh, sm), timed.zone).epochMs
      let en: number | null = null
      if (e) {
        const [eh, em] = timed.e.split(':').map(Number)
        en = zonedToEpochDetailed(civilParts(e, eh, em), timed.zone).epochMs
        if (en < st) en = st
      }
      return { kind: 'datetime', start: toIso(st), end: en === null ? null : toIso(en), timeZone: timed.zone }
    }
    return { kind: 'date', start: s, end: e && e > s ? e : e === s ? null : e }
  }
  const timed = () => (value && value.kind === 'datetime' ? { s: timeOf(value.start, vz), e: value.end ? timeOf(value.end, vz) : timeOf(value.start, vz), zone: vz } : null)

  const pick = (c: string) => {
    if (isRange && pickingEnd && startCivil) {
      const [a, b] = c < startCivil ? [c, startCivil] : [startCivil, c]
      onChange(build(a, b, timed()))
      setPickingEnd(false)
      return
    }
    onChange(build(c, isRange && endCivil && endCivil >= c ? endCivil : isRange ? c : null, timed()))
  }

  const toggleRange = () => {
    if (!value || !startCivil) return
    if (isRange) onChange(build(startCivil, null, timed()))
    else {
      setPickingEnd(true)
      onChange(build(startCivil, addDays(startCivil, 1), timed()))
    }
  }
  const toggleTime = () => {
    if (!value) return
    if (hasTime) onChange(timedToCivil(value as Extract<DateValue, { kind: 'datetime' }>, vz)) // preview: the time of day is dropped
    else onChange(civilToTimed(value as Extract<DateValue, { kind: 'date' }>, config.defaultZone ?? zone)) // default 09:00 local, visible in the inputs
  }
  const setTime = (which: 's' | 'e', hhmm: string) => {
    if (!value || value.kind !== 'datetime' || !startCivil) return
    const cur = timed()!
    onChange(build(startCivil, endCivil, { ...cur, [which]: hhmm }))
  }
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')
    } catch {
      return ['UTC']
    }
  }, [])

  const inRange = (c: string) => startCivil && endCivil && c >= startCivil && c <= endCivil
  return (
    <div className="db-date-pop" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="db-date-head">
        <button type="button" className="icon-btn" aria-label={t('Previous month')} onClick={() => shift(-1)}><span style={{ display: 'inline-block', transform: 'scaleX(-1)' }}><Ic.Chevron size={14} /></span></button>
        <b>{header}</b>
        <button type="button" className="icon-btn" aria-label={t('Next month')} onClick={() => shift(1)}><Ic.Chevron size={14} /></button>
      </div>
      <div className="db-date-grid" role="grid" aria-label={header}>
        {Array.from({ length: 7 }, (_, i) => <span key={i} className="db-date-wd">{names[((weekStart - 1 + i) % 7)]}</span>)}
        {grid.map(({ civil: c, inMonth }) => (
          <button
            key={c}
            type="button"
            role="gridcell"
            aria-label={formatCivil(c, { calendar: cal, locale: locale() })}
            aria-selected={c === startCivil || c === endCivil}
            className={'db-day' + (inMonth ? '' : ' out') + (c === todayCivil ? ' today' : '') + (c === startCivil || c === endCivil ? ' sel' : '') + (inRange(c) ? ' range' : '')}
            onClick={() => pick(c)}
          >
            {dayLabel(c)}
          </button>
        ))}
      </div>
      {hasTime && (
        <div className="db-date-time">
          <input type="time" aria-label={t('Start time')} value={timed()!.s} onChange={(e) => setTime('s', e.target.value)} />
          {isRange && <input type="time" aria-label={t('End time')} value={timed()!.e} onChange={(e) => setTime('e', e.target.value)} />}
          <Select title={t('Time zone')} value={isValidZone(vz) ? vz : zone} onChange={(nextZone) => { if (value?.kind === 'datetime' && startCivil) onChange(build(startCivil, endCivil, { ...timed()!, zone: nextZone })) }} options={(zones.includes(vz) ? zones : [vz, ...zones]).map((value) => ({ value, label: value }))} />
        </div>
      )}
      {value && (
        <div className="db-date-opts">
          <label><input type="checkbox" checked={isRange} onChange={toggleRange} /> {t('End date')}</label>
          <label><input type="checkbox" checked={hasTime} onChange={toggleTime} /> {t('Include time')}</label>
        </div>
      )}
      {hasTime && <div className="db-date-hint">{t('Switching off the time keeps only the day.')}</div>}
      <div className="db-date-foot">
        <button type="button" onClick={() => onChange({ kind: 'date', start: todayCivil, end: null })}>{t('Today')}</button>
        <button type="button" className="danger" onClick={() => (onChange(null), onClose())}>{t('Clear')}</button>
        <button type="button" className="primary" onClick={onClose}>{t('Done')}</button>
      </div>
    </div>
  )
}
