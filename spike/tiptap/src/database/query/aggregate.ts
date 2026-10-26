// One shared typed aggregation library (handoff §14). Table / group totals run it on matching rows, a rollup runs it on the
// distinct accessible related pages. Percent results are fractions in [0,1]; a zero denominator gives null (displayed empty).
import type { DateValue } from '../model/types.ts'
import { DbError, fail } from '../model/errors.ts'
import { dateInterval, normalizeDate } from '../dates.ts'
import type { RollupAggregation } from '../props/config.ts'
import { EMPTY, leafKey, leaves, num, qEmpty, type QValue } from './values.ts'

export type AggInput = {
  /** one value per distinct related row, in relation order */
  values: QValue[]
  zone: string
}

const bad = (m: string): never => fail('INVALID_VALUE', m)

function numericLeaves(values: QValue[]): number[] {
  const out: number[] = []
  for (const v of values)
    for (const l of leaves(v)) {
      if (l.c === 'number') out.push(l.n)
      else bad(`cannot do arithmetic on ${l.c}`)
    }
  return out
}

function dateLeaves(values: QValue[]): DateValue[] {
  const out: DateValue[] = []
  for (const v of values)
    for (const l of leaves(v)) {
      if (l.c === 'date') out.push(l.v)
      else bad(`expected dates, got ${l.c}`)
    }
  return out
}

const ratio = (a: number, b: number): QValue => (b === 0 ? EMPTY : num(a / b))

export function aggregate(op: RollupAggregation, input: AggInput): QValue {
  const { values, zone } = input
  for (const v of values) if (v.c === 'blocked') return v // restricted / pending input gives restricted / pending output, never a fake number
  const rows = values.length
  switch (op) {
    case 'count_all': return num(rows)
    case 'count_values': return num(values.reduce((n, v) => n + leaves(v).length, 0))
    case 'count_unique': {
      const seen = new Set<string>()
      for (const v of values) for (const l of leaves(v)) seen.add(leafKey(l, zone))
      return num(seen.size)
    }
    case 'count_empty': return num(values.filter(qEmpty).length)
    case 'count_not_empty': return num(values.filter((v) => !qEmpty(v)).length)
    case 'percent_empty': return ratio(values.filter(qEmpty).length, rows)
    case 'percent_not_empty': return ratio(values.filter((v) => !qEmpty(v)).length, rows)
    case 'checked': return num(values.filter((v) => v.c === 'bool' && v.b).length)
    case 'unchecked': return num(values.filter((v) => v.c === 'bool' && !v.b).length)
    case 'percent_checked': return ratio(values.filter((v) => v.c === 'bool' && v.b).length, rows)
    case 'percent_unchecked': return ratio(values.filter((v) => v.c === 'bool' && !v.b).length, rows)
    case 'sum': return num(numericLeaves(values).reduce((a, b) => a + b, 0)) // sum([]) = 0
    case 'average': {
      const n = numericLeaves(values)
      return n.length ? num(n.reduce((a, b) => a + b, 0) / n.length) : EMPTY
    }
    case 'median': {
      const n = numericLeaves(values).sort((a, b) => a - b)
      if (!n.length) return EMPTY
      const mid = n.length >> 1
      return num(n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2)
    }
    case 'min': {
      const n = numericLeaves(values)
      return n.length ? num(Math.min(...n)) : EMPTY
    }
    case 'max': {
      const n = numericLeaves(values)
      return n.length ? num(Math.max(...n)) : EMPTY
    }
    case 'range': {
      const n = numericLeaves(values)
      return n.length ? num(Math.max(...n) - Math.min(...n)) : EMPTY // one value -> 0
    }
    case 'earliest_date': {
      const d = dateLeaves(values)
      if (!d.length) return EMPTY
      return { c: 'date', v: d.reduce((a, b) => (dateInterval(b, zone).s < dateInterval(a, zone).s ? b : a)) }
    }
    case 'latest_date': {
      const d = dateLeaves(values)
      if (!d.length) return EMPTY
      // latest compares the END of each value (start when it has no end)
      const endOf = (v: DateValue) => dateInterval(v, zone).e
      return { c: 'date', v: d.reduce((a, b) => (endOf(b) > endOf(a) ? b : a)) }
    }
    case 'date_range': {
      const d = dateLeaves(values)
      if (!d.length) return EMPTY
      const first = d.reduce((a, b) => (dateInterval(b, zone).s < dateInterval(a, zone).s ? b : a))
      const last = d.reduce((a, b) => (dateInterval(b, zone).e > dateInterval(a, zone).e ? b : a))
      if (first.kind !== last.kind) return bad('date range mixes all-day and timed values')
      const lastEnd = last.end ?? last.start
      return { c: 'date', v: normalizeDate(first.kind === 'date' ? { kind: 'date', start: first.start, end: lastEnd === first.start ? null : lastEnd } : { kind: 'datetime', start: first.start, end: lastEnd, timeZone: first.timeZone }) }
    }
    case 'show_original': return { c: 'list', items: values.flatMap((v) => leaves(v)) }
    case 'show_unique': {
      const seen = new Set<string>()
      const items: QValue[] = []
      for (const v of values) for (const l of leaves(v)) {
        const k = leafKey(l, zone)
        if (!seen.has(k)) (seen.add(k), items.push(l))
      }
      return { c: 'list', items }
    }
  }
}

/** Safe wrapper: invalid operands become an error value instead of throwing through a whole table. */
export function aggregateSafe(op: RollupAggregation, input: AggInput): QValue {
  try {
    return aggregate(op, input)
  } catch (e) {
    if (e instanceof DbError) return { c: 'blocked', state: 'error', code: e.code, detail: e.message }
    throw e
  }
}
