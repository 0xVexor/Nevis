// Date cells are stored in the Gregorian calendar as "2026-11-20" or "2026-11-20T08:30:00.000Z" (ADR-0004). The Persian (Jalali)
// calendar is only for typing and showing. The conversion uses the platform's Intl calendar as its single source of truth
// (the same one the UI displays), so what is shown and what is parsed can never disagree.
import { toAsciiDigits } from './decimal'

const persian = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' })
const parts = (ms: number) => {
  const p = Object.fromEntries(persian.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return [Number(p.relatedYear ?? p.year), Number(p.month), Number(p.day)] as const
}
const dayMs = 86_400_000
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const dim = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!

export function validGregorian(y: number, m: number, d: number): boolean {
  return Number.isInteger(y) && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= dim(y, m)
}

export function gregorianToJalali(y: number, m: number, d: number): [number, number, number] {
  const t = Date.UTC(y, m - 1, d)
  const [jy, jm, jd] = parts(t)
  return [jy, jm, jd]
}

/** null when the Jalali date does not exist (e.g. 30 Esfand of a common year). */
export function jalaliToGregorian(jy: number, jm: number, jd: number): [number, number, number] | null {
  if (!Number.isInteger(jy) || jm < 1 || jm > 12 || jd < 1 || jd > 31) return null
  const approx = Date.UTC(jy + 621, 2, 21) + ((jm <= 6 ? (jm - 1) * 31 : 186 + (jm - 7) * 30) + (jd - 1)) * dayMs
  for (let off = -4; off <= 4; off++) {
    const t = approx + off * dayMs
    const [a, b, c] = parts(t)
    if (a === jy && b === jm && c === jd) { const g = new Date(t); return [g.getUTCFullYear(), g.getUTCMonth() + 1, g.getUTCDate()] }
  }
  return null
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** What a person typed -> the stored form, or null. Accepts Persian/Arabic digits, "/" or "-" between parts, a Jalali date
 *  (year 1200-1699: no Gregorian date a person types lies there) and an ISO date-time in UTC ("...Z"). */
export function normalizeDate(input: string): string | null {
  const s = toAsciiDigits(input.replace(/[‎‏؜‌​]/g, '')).trim()
  const dt = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/.exec(s)
  if (dt) {
    const [y, mo, d, hh, mm] = [dt[1], dt[2], dt[3], dt[4], dt[5]].map(Number) as [number, number, number, number, number]
    const ss = Number(dt[6] ?? '0')
    if (!validGregorian(y, mo, d) || hh > 23 || mm > 59 || ss > 59) return null
    return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}.${(dt[7] ?? '0').padEnd(3, '0')}Z`
  }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s)
  if (!m) return null
  let [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number]
  if (y >= 1200 && y < 1700) { const g = jalaliToGregorian(y, mo, d); if (!g) return null; [y, mo, d] = g }
  return validGregorian(y, mo, d) ? `${pad(y, 4)}-${pad(mo)}-${pad(d)}` : null
}

/** "1405/08/29" style (Persian digits) for a stored date; the time part, if any, is shown in `timeZone` (default: the device's). */
export function formatDateFa(stored: string, timeZone?: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stored)
  if (day) {
    const [jy, jm, jd] = gregorianToJalali(Number(day[1]), Number(day[2]), Number(day[3]))
    return new Intl.NumberFormat('fa-IR', { useGrouping: false, minimumIntegerDigits: 1 }).format(jy) + '/' + new Intl.NumberFormat('fa-IR', { minimumIntegerDigits: 2, useGrouping: false }).format(jm) + '/' + new Intl.NumberFormat('fa-IR', { minimumIntegerDigits: 2, useGrouping: false }).format(jd)
  }
  const t = Date.parse(stored)
  if (Number.isNaN(t)) return stored
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { ...(timeZone ? { timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t))
}
