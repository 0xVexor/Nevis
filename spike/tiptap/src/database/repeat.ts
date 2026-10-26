// Repeating templates (handoff §18): occurrences are computed from the schedule, never from a running timer, and every
// occurrence has a stable key so a restart cannot create it twice.
import type { RepeatSchedule } from './model/types.ts'
import { addDays, addMonths, civilParts, civilString, daysInMonth, parseCivil, startOfWeek, weekdayOf, zonedToEpochDetailed } from './dates.ts'

export type Occurrence = { key: string; scheduledMs: number; civil: string; adjusted: boolean }

function* civilDays(r: RepeatSchedule, fromCivil: string, toCivil: string): Generator<string> {
  const start = r.startDate
  const step = Math.max(1, Math.trunc(r.interval))
  if (r.frequency === 'daily') {
    for (let d = start; d <= toCivil; d = addDays(d, step)) if (d >= fromCivil) yield d
  } else if (r.frequency === 'weekly') {
    const wds = (r.weekdays?.length ? r.weekdays : [weekdayOf(start)]).slice().sort((a, b) => a - b)
    const weekStart = startOfWeek(start, 1) // intervals count ISO weeks from the start week
    for (let w = weekStart; w <= toCivil; w = addDays(w, 7 * step)) for (const wd of wds) {
      const d = addDays(w, wd - 1)
      if (d >= start && d >= fromCivil && d <= toCivil) yield d
    }
  } else if (r.frequency === 'monthly') {
    const dom = r.dayOfMonth ?? parseCivil(start).d
    for (let i = 0; ; i += step) {
      const first = addMonths(civilString(parseCivil(start).y, parseCivil(start).m, 1), i)
      if (first > toCivil) break
      const { y, m } = parseCivil(first)
      const d = civilString(y, m, Math.min(dom, daysInMonth(y, m))) // a day beyond the month clamps to its last day
      if (d >= start && d >= fromCivil && d <= toCivil) yield d
    }
  } else {
    const { m: sm, d: sd } = parseCivil(start)
    for (let i = 0; ; i += step) {
      const y = parseCivil(start).y + i
      const d = civilString(y, sm, Math.min(sd, daysInMonth(y, sm)))
      if (d > toCivil) break
      if (d >= start && d >= fromCivil) yield d
    }
  }
}

/** Occurrences with scheduled instant in (afterMs, upToMs]. Local time + IANA zone; DST gap/fold per handoff §8. */
export function repeatOccurrences(r: RepeatSchedule, templateId: string, version: number, afterMs: number, upToMs: number, limit = 10_000): Occurrence[] {
  if (!(r.interval >= 1) || !Number.isInteger(r.interval)) throw new Error('repeat interval must be a whole number >= 1')
  const [hh, mm] = r.time.split(':').map(Number)
  const out: Occurrence[] = []
  const lo = new Date(afterMs - 2 * 86400000).toISOString().slice(0, 10)
  const hi = new Date(upToMs + 2 * 86400000).toISOString().slice(0, 10)
  for (const civil of civilDays(r, lo > r.startDate ? lo : r.startDate, hi)) {
    if (r.endDate && civil > r.endDate) break
    const z = zonedToEpochDetailed(civilParts(civil, hh, mm), r.timeZone)
    if (z.epochMs <= afterMs || z.epochMs > upToMs) continue
    out.push({ key: `${templateId}|${version}|${new Date(z.epochMs).toISOString()}`, scheduledMs: z.epochMs, civil, adjusted: z.adjusted })
    if (out.length >= limit) break
  }
  return out.sort((a, b) => a.scheduledMs - b.scheduledMs)
}

export const MAX_CATCH_UP_WITHOUT_PREVIEW = 30
