// Dates, time zones and calendars (handoff §8). Civil dates are strict Gregorian YYYY-MM-DD strings that never pass through
// UTC midnight; instants are ISO instants plus an optional IANA zone. Jalali is only a presentation / input calendar.
import type { CivilDate, DateValue, InstantDate } from './model/types.ts'
import { fail } from './model/errors.ts'

// ───── civil (calendar-day) arithmetic ─────

const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86400000

export function isCivil(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = CIVIL_RE.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)
}

export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

export function parseCivil(s: string): { y: number; m: number; d: number } {
  if (!isCivil(s)) fail('INVALID_VALUE', `not a civil date: ${s}`)
  const m = CIVIL_RE.exec(s)!
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

export const civilString = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`

/** Days since 1970-01-01 of a civil date. */
export function civilToDays(s: string): number {
  const { y, m, d } = parseCivil(s)
  const dt = new Date(0)
  dt.setUTCFullYear(y, m - 1, d) // Date.UTC would map years 0-99 to 1900-1999
  return Math.round(dt.getTime() / DAY_MS)
}

export function daysToCivil(n: number): string {
  const dt = new Date(n * DAY_MS)
  return civilString(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

export const addDays = (s: string, n: number) => daysToCivil(civilToDays(s) + n)
export const diffDays = (a: string, b: string) => civilToDays(a) - civilToDays(b)
export const compareCivil = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** ISO weekday: Monday = 1 ... Sunday = 7. */
export function weekdayOf(s: string): number {
  const wd = (((civilToDays(s) + 4) % 7) + 7) % 7 // 1970-01-01 was a Thursday (4 with Sunday=0)
  return wd === 0 ? 7 : wd
}

/** Month arithmetic with end-of-month clamp (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(s: string, n: number): string {
  const { y, m, d } = parseCivil(s)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = total - ny * 12 + 1
  return civilString(ny, nm, Math.min(d, daysInMonth(ny, nm)))
}
export const addYears = (s: string, n: number) => addMonths(s, n * 12)

/** First day of the week containing `s`. `weekStart` is an ISO weekday (Persian default Saturday = 6). */
export function startOfWeek(s: string, weekStart: number): string {
  const back = (weekdayOf(s) - weekStart + 7) % 7
  return addDays(s, -back)
}

export const startOfMonth = (s: string) => civilString(parseCivil(s).y, parseCivil(s).m, 1)
export const endOfMonth = (s: string) => {
  const { y, m } = parseCivil(s)
  return civilString(y, m, daysInMonth(y, m))
}

/** ISO-8601 week number (Monday-based), and the year it belongs to. */
export function isoWeek(s: string): { year: number; week: number } {
  const days = civilToDays(s)
  const thursday = days + (4 - weekdayOf(s))
  const y = parseCivil(daysToCivil(thursday)).y
  const jan1 = civilToDays(civilString(y, 1, 1))
  return { year: y, week: Math.floor((thursday - jan1) / 7) + 1 }
}

// ───── Jalali (Persian) calendar: presentation only ─────

const div = (a: number, b: number) => Math.trunc(a / b)
const mod = (a: number, b: number) => a - Math.trunc(a / b) * b

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178]

function jalCal(jy: number) {
  const bl = BREAKS.length
  const gy = jy + 621
  let leapJ = -14
  let jp = BREAKS[0]
  let jump = 0
  if (jy < jp || jy >= BREAKS[bl - 1]) fail('INVALID_VALUE', `Jalali year out of range: ${jy}`)
  for (let i = 1; i < bl; i++) {
    const jm = BREAKS[i]
    jump = jm - jp
    if (jy < jm) break
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4)
    jp = jm
  }
  let n = jy - jp
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4)
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150
  const march = 20 + leapJ - leapG
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33
  let leap = mod(mod(n + 1, 33) - 1, 4)
  if (leap === -1) leap = 4
  return { leap, gy, march }
}

function g2d(gy: number, gm: number, gd: number) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752
  return d
}

function d2g(jdn: number) {
  let j = 4 * jdn + 139361631
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908
  const i = div(mod(j, 1461), 4) * 5 + 308
  const gd = div(mod(i, 153), 5) + 1
  const gm = mod(div(i, 153), 12) + 1
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6)
  return { gy, gm, gd }
}

export function jalaliToGregorian(jy: number, jm: number, jd: number): { y: number; m: number; d: number } {
  const r = jalCal(jy)
  const jdn = g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1
  const g = d2g(jdn)
  return { y: g.gy, m: g.gm, d: g.gd }
}

export function gregorianToJalali(gy: number, gm: number, gd: number): { y: number; m: number; d: number } {
  const jdn = g2d(gy, gm, gd)
  let jy = d2g(jdn).gy - 621
  const r = jalCal(jy)
  const jdn1f = g2d(d2g(jdn).gy, 3, r.march)
  let k = jdn - jdn1f
  if (k >= 0) {
    if (k <= 185) return { y: jy, m: 1 + div(k, 31), d: mod(k, 31) + 1 }
    k -= 186
  } else {
    jy -= 1
    k += 179
    if (r.leap === 1) k += 1
  }
  return { y: jy, m: 7 + div(k, 30), d: mod(k, 30) + 1 }
}

export const jalaliMonthLength = (jy: number, jm: number) => {
  if (jm <= 6) return 31
  if (jm <= 11) return 30
  return jalCal(jy).leap === 0 ? 30 : 29
}

export function civilToJalali(s: string) {
  const { y, m, d } = parseCivil(s)
  return gregorianToJalali(y, m, d)
}

/** Canonical Gregorian civil string for a Jalali date typed by the user. */
export function jalaliToCivil(jy: number, jm: number, jd: number): string {
  if (jm < 1 || jm > 12 || jd < 1 || jd > jalaliMonthLength(jy, jm)) fail('INVALID_VALUE', `invalid Jalali date ${jy}/${jm}/${jd}`)
  const g = jalaliToGregorian(jy, jm, jd)
  return civilString(g.y, g.m, g.d)
}

export const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند']

// ───── time zones (Intl-based; no tz database shipped) ─────

const dtfCache = new Map<string, Intl.DateTimeFormat>()
function dtf(zone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(zone)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    } catch {
      fail('INVALID_VALUE', `unknown time zone: ${zone}`)
    }
    dtfCache.set(zone, f!)
  }
  return f!
}

export function isValidZone(zone: string): boolean {
  try {
    dtf(zone)
    return true
  } catch {
    return false
  }
}

export type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number }

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(epochMs: number, zone: string): Parts {
  const out: Record<string, number> = {}
  for (const p of dtf(zone).formatToParts(new Date(epochMs))) if (p.type !== 'literal') out[p.type] = Number(p.value)
  return { y: out.year, mo: out.month, d: out.day, h: out.hour === 24 ? 0 : out.hour, mi: out.minute, s: out.second, ms: ((epochMs % 1000) + 1000) % 1000 }
}

const partsAsUtc = (p: Parts) => Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms)

/** UTC offset (ms) of a zone at an instant. */
export const zoneOffsetMs = (epochMs: number, zone: string) => partsAsUtc(zonedParts(epochMs, zone)) - epochMs

export type ZoneResolution = { epochMs: number; adjusted: boolean; fold: boolean }

/**
 * Wall-clock time to instant. DST gap (the local time does not exist): advance to the first valid local instant.
 * DST fold (the local time happens twice): pick the earlier instant (handoff §8; a product decision, not Notion behavior).
 */
export function zonedToEpochDetailed(p: Parts, zone: string): ZoneResolution {
  const local = partsAsUtc(p)
  const oBefore = zoneOffsetMs(local - DAY_MS, zone)
  const oAfter = zoneOffsetMs(local + DAY_MS, zone)
  const cands = [...new Set([local - oBefore, local - oAfter])].filter((t) => partsAsUtc(zonedParts(t, zone)) === local).sort((a, b) => a - b)
  if (cands.length) return { epochMs: cands[0], adjusted: false, fold: cands.length > 1 }
  // gap: find the transition instant between the two candidate readings
  let lo = Math.min(local - oBefore, local - oAfter) - DAY_MS
  let hi = Math.max(local - oBefore, local - oAfter) + DAY_MS
  const startOffset = zoneOffsetMs(lo, zone)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (zoneOffsetMs(mid, zone) === startOffset) lo = mid
    else hi = mid
  }
  return { epochMs: hi, adjusted: true, fold: false }
}

export const zonedToEpoch = (p: Parts, zone: string) => zonedToEpochDetailed(p, zone).epochMs

export const civilParts = (s: string, h = 0, mi = 0): Parts => {
  const { y, m, d } = parseCivil(s)
  return { y, mo: m, d, h, mi, s: 0, ms: 0 }
}

export const startOfDayMs = (civil: string, zone: string) => zonedToEpoch(civilParts(civil), zone)

export function civilOf(epochMs: number, zone: string): string {
  const p = zonedParts(epochMs, zone)
  return civilString(p.y, p.mo, p.d)
}

// ───── instants ─────

const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?$/

/** Strict ISO parsing. A timed string without an offset is read in `zone` (if given). */
export function parseIsoInstant(s: string, zone: string | null): number | null {
  const m = ISO_INSTANT_RE.exec(s)
  if (!m) return null
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]
  const sec = m[6] ? Number(m[6]) : 0
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  if (!isCivil(`${m[1]}-${m[2]}-${m[3]}`) || h > 23 || mi > 59 || sec > 59) return null
  if (m[8]) {
    if (m[8] === 'Z') return Date.UTC(y, mo - 1, d, h, mi, sec, ms)
    const sign = m[8][0] === '-' ? -1 : 1
    const digits = m[8].slice(1).replace(':', '')
    const off = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000
    return Date.UTC(y, mo - 1, d, h, mi, sec, ms) - off
  }
  return zonedToEpoch({ y, mo, d, h, mi, s: sec, ms }, zone ?? 'UTC')
}

export const toIso = (epochMs: number) => new Date(epochMs).toISOString()

// ───── DateValue helpers ─────

export const isInstantValue = (v: DateValue): v is InstantDate => v.kind === 'datetime'

export function civil(start: string, end: string | null = null): CivilDate {
  return { kind: 'date', start, end }
}
export function instant(startMs: number, endMs: number | null = null, timeZone: string | null = null): InstantDate {
  return { kind: 'datetime', start: toIso(startMs), end: endMs === null ? null : toIso(endMs), timeZone }
}

/** Validate and normalize (instants become UTC ISO). Throws INVALID_VALUE with a precise reason. */
export function normalizeDate(v: DateValue): DateValue {
  if (v.kind === 'date') {
    if (!isCivil(v.start)) fail('INVALID_VALUE', `invalid start date: ${v.start}`)
    if (v.end !== null && !isCivil(v.end)) fail('INVALID_VALUE', `invalid end date: ${v.end}`)
    if (v.end !== null && v.end < v.start) fail('INVALID_VALUE', 'end is before start')
    return { kind: 'date', start: v.start, end: v.end }
  }
  if (v.kind !== 'datetime') fail('INVALID_VALUE', 'unknown date kind')
  if (v.timeZone !== null && !isValidZone(v.timeZone)) fail('INVALID_VALUE', `unknown time zone: ${v.timeZone}`)
  const s = parseIsoInstant(v.start, v.timeZone)
  if (s === null) fail('INVALID_VALUE', `invalid start time: ${v.start}`)
  let e: number | null = null
  if (v.end !== null) {
    e = parseIsoInstant(v.end, v.timeZone)
    if (e === null) fail('INVALID_VALUE', `invalid end time: ${v.end}`)
    if (e! < s!) fail('INVALID_VALUE', 'end is before start')
  }
  return { kind: 'datetime', start: toIso(s!), end: e === null ? null : toIso(e), timeZone: v.timeZone }
}

/** Half-open [start, end) interval in epoch ms, anchored in `zone` (civil dates anchor at local midnight). */
export function dateInterval(v: DateValue, zone: string): { s: number; e: number } {
  if (v.kind === 'date') {
    const s = startOfDayMs(v.start, zone)
    const e = startOfDayMs(addDays(v.end ?? v.start, 1), zone)
    return { s, e }
  }
  const s = parseIsoInstant(v.start, v.timeZone ?? zone) ?? NaN
  const e = v.end === null ? s : (parseIsoInstant(v.end, v.timeZone ?? zone) ?? NaN)
  return { s, e: e === s ? s + 1 : e } // an instant is a 1ms interval so it can intersect and compare
}

/** Sort anchor: start of a date value in epoch ms (civil start-of-day in `zone`). */
export const dateStartMs = (v: DateValue, zone: string) => dateInterval(v, zone).s

export type RelativeKind =
  | 'today' | 'yesterday' | 'tomorrow' | 'this_week' | 'last_week' | 'next_calendar_week' | 'past_week' | 'next_week'
  | 'this_month' | 'last_month' | 'next_month' | 'past_month' | 'next_30_days' | 'this_year' | 'past_n_days' | 'next_n_days'

export const RELATIVE_KINDS: RelativeKind[] = [
  'today', 'yesterday', 'tomorrow', 'this_week', 'last_week', 'next_calendar_week', 'past_week', 'next_week', 'this_month', 'last_month',
  'next_month', 'past_month', 'next_30_days', 'this_year', 'past_n_days', 'next_n_days',
]

/**
 * Relative predicate range with an injected clock. `past_week` / `next_week` are *rolling* (seven days before / after today,
 * excluding today); `this_week` / `last_week` / `next_calendar_week` are calendar weeks starting on `weekStart`.
 */
export function relativeInterval(kind: RelativeKind, nowMs: number, zone: string, weekStart: number, n = 7): { s: number; e: number } {
  const today = civilOf(nowMs, zone)
  const range = (a: string, bExclusive: string) => ({ s: startOfDayMs(a, zone), e: startOfDayMs(bExclusive, zone) })
  switch (kind) {
    case 'today': return range(today, addDays(today, 1))
    case 'yesterday': return range(addDays(today, -1), today)
    case 'tomorrow': return range(addDays(today, 1), addDays(today, 2))
    case 'this_week': { const s = startOfWeek(today, weekStart); return range(s, addDays(s, 7)) }
    case 'last_week': { const s = addDays(startOfWeek(today, weekStart), -7); return range(s, addDays(s, 7)) }
    case 'next_calendar_week': { const s = addDays(startOfWeek(today, weekStart), 7); return range(s, addDays(s, 7)) }
    case 'past_week': return range(addDays(today, -7), today)
    case 'next_week': return range(addDays(today, 1), addDays(today, 8))
    case 'this_month': { const s = startOfMonth(today); return range(s, addMonths(s, 1)) }
    case 'last_month': { const s = addMonths(startOfMonth(today), -1); return range(s, addMonths(s, 1)) }
    case 'next_month': { const s = addMonths(startOfMonth(today), 1); return range(s, addMonths(s, 1)) }
    case 'past_month': return range(addMonths(today, -1), today)
    case 'next_30_days': return range(addDays(today, 1), addDays(today, 31))
    case 'this_year': { const y = parseCivil(today).y; return range(civilString(y, 1, 1), civilString(y + 1, 1, 1)) }
    case 'past_n_days': return range(addDays(today, -n), today)
    case 'next_n_days': return range(addDays(today, 1), addDays(today, n + 1))
  }
}

/** Next midnight after the instant in the zone: when a `today`-based computation must refresh. */
export const nextMidnightMs = (nowMs: number, zone: string) => startOfDayMs(addDays(civilOf(nowMs, zone), 1), zone)

// ───── editing: moving, resizing, converting ─────

/** Calendar drag: move a value by whole days. All-day keeps its length in days; timed keeps local wall time and duration. */
export function shiftDays(v: DateValue, days: number, zone: string): DateValue {
  if (v.kind === 'date') return { kind: 'date', start: addDays(v.start, days), end: v.end === null ? null : addDays(v.end, days) }
  const z = v.timeZone ?? zone
  const s = parseIsoInstant(v.start, z)!
  const e = v.end === null ? null : parseIsoInstant(v.end, z)!
  const sp = zonedParts(s, z)
  const newStartCivil = addDays(civilString(sp.y, sp.mo, sp.d), days)
  const ns = zonedToEpoch({ ...civilParts(newStartCivil, sp.h, sp.mi), s: sp.s, ms: sp.ms }, z)
  return { kind: 'datetime', start: toIso(ns), end: e === null ? null : toIso(ns + (e - s)), timeZone: v.timeZone }
}

/** Dragging one endpoint changes that endpoint only; an inverted result is rejected. */
export function moveEndpoint(v: DateValue, which: 'start' | 'end', days: number, zone: string): DateValue {
  if (v.kind === 'date') {
    const next: CivilDate = which === 'start' ? { kind: 'date', start: addDays(v.start, days), end: v.end ?? v.start } : { kind: 'date', start: v.start, end: addDays(v.end ?? v.start, days) }
    if (next.end! < next.start) fail('INVALID_VALUE', 'end is before start')
    return next.end === next.start && v.end === null ? { kind: 'date', start: next.start, end: null } : next
  }
  const z = v.timeZone ?? zone
  const moveIso = (iso: string) => {
    const ms = parseIsoInstant(iso, z)!
    const p = zonedParts(ms, z)
    return toIso(zonedToEpoch({ ...civilParts(addDays(civilString(p.y, p.mo, p.d), days), p.h, p.mi), s: p.s, ms: p.ms }, z))
  }
  const next: InstantDate = which === 'start' ? { ...v, start: moveIso(v.start), end: v.end ?? v.start } : { ...v, end: moveIso(v.end ?? v.start) }
  if (Date.parse(next.end!) < Date.parse(next.start)) fail('INVALID_VALUE', 'end is before start')
  return next
}

/** All-day -> timed: caller shows the chosen zone/time before committing. Default 09:00 local. */
export function civilToTimed(v: CivilDate, zone: string, hour = 9, minute = 0): InstantDate {
  const s = zonedToEpochDetailed(civilParts(v.start, hour, minute), zone).epochMs
  const e = v.end === null ? null : zonedToEpochDetailed(civilParts(v.end, hour, minute), zone).epochMs
  return { kind: 'datetime', start: toIso(s), end: e === null ? null : toIso(e), timeZone: zone }
}

/** Timed -> all-day: discards the time of day (preview shows this first). */
export function timedToCivil(v: InstantDate, zone: string): CivilDate {
  const z = v.timeZone ?? zone
  const s = civilOf(parseIsoInstant(v.start, z)!, z)
  const e = v.end === null ? null : civilOf(parseIsoInstant(v.end, z)!, z)
  return { kind: 'date', start: s, end: e === s ? null : e }
}

export function datesEqual(a: DateValue | null, b: DateValue | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'date' && b.kind === 'date') return a.start === b.start && (a.end ?? null) === (b.end ?? null)
  const x = a as InstantDate
  const y = b as InstantDate
  return Date.parse(x.start) === Date.parse(y.start) && (x.end === null ? null : Date.parse(x.end)) === (y.end === null ? null : Date.parse(y.end))
}

// ───── display ─────

export type DateFormatOptions = { calendar?: 'gregorian' | 'jalali'; zone: string; locale?: string; withTime?: boolean }

const faDigits = (s: string) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])

export function formatCivil(s: string, opts: { calendar?: 'gregorian' | 'jalali'; locale?: string } = {}): string {
  if (opts.calendar === 'jalali') {
    const j = civilToJalali(s)
    const txt = `${j.d} ${JALALI_MONTHS[j.m - 1]} ${j.y}`
    return opts.locale?.startsWith('fa') ? faDigits(txt) : txt
  }
  const { y, m, d } = parseCivil(s)
  return new Intl.DateTimeFormat(opts.locale ?? 'en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)))
}

export function formatDateValue(v: DateValue, o: DateFormatOptions): string {
  if (v.kind === 'date') {
    const a = formatCivil(v.start, o)
    return v.end && v.end !== v.start ? `${a} → ${formatCivil(v.end, o)}` : a
  }
  const z = v.timeZone ?? o.zone
  const fmt = (iso: string) => {
    const ms = parseIsoInstant(iso, z)!
    const p = zonedParts(ms, z)
    const day = formatCivil(civilString(p.y, p.mo, p.d), o)
    const time = `${pad(p.h)}:${pad(p.mi)}`
    return `${day} ${o.locale?.startsWith('fa') ? faDigits(time) : time}`
  }
  const a = fmt(v.start)
  return v.end && v.end !== v.start ? `${a} → ${fmt(v.end)}` : a
}
