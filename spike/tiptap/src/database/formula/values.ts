// Formula value algebra (handoff §15): Empty, finite Number, Boolean, StyledText, DateValue, PageRef, PersonRef, List, Error.
// Empty is not Error; page / person values are references resolved through the permission-aware environment.
import type { DateValue, FormulaValue, Id, RichRun } from '../model/types.ts'
import { dateInterval } from '../dates.ts'
import { plainDecimal } from '../props/numberFormat.ts'
import { runsToText } from '../text.ts'
import type { QValue } from '../query/values.ts'

export const EMPTY_V: FormulaValue = { kind: 'empty' }
export const numV = (value: number): FormulaValue => ({ kind: 'number', value: value === 0 ? 0 : value }) // never -0
export const boolV = (value: boolean): FormulaValue => ({ kind: 'boolean', value })
export const textV = (s: string): FormulaValue => ({ kind: 'text', runs: s ? [{ text: s }] : [] })
export const runsV = (runs: RichRun[]): FormulaValue => ({ kind: 'text', runs: runs.filter((r) => r.text !== '' || r.mention) })
export const dateV = (value: DateValue): FormulaValue => ({ kind: 'date', value })
export const listV = (items: FormulaValue[]): FormulaValue => ({ kind: 'list', items })
export const pageV = (id: Id, vaultId: Id): FormulaValue => ({ kind: 'page', id, vaultId })
export const personV = (id: Id): FormulaValue => ({ kind: 'person', id })

export const plain = (v: FormulaValue): string => (v.kind === 'text' ? runsToText(v.runs) : '')

export function typeName(v: FormulaValue): string {
  return v.kind === 'empty' ? 'Empty' : v.kind === 'number' ? 'Number' : v.kind === 'boolean' ? 'Boolean' : v.kind === 'text' ? 'Text' : v.kind === 'date' ? 'Date' : v.kind === 'page' ? 'Page' : v.kind === 'person' ? 'Person' : 'List'
}

/**
 * `empty()` compatibility rule (§15): Empty, 0, false, empty text and empty list are empty; whitespace-only text is NOT.
 * (Differs from filtering, where 0 and false are not empty.)
 */
export function formulaEmpty(v: FormulaValue): boolean {
  switch (v.kind) {
    case 'empty': return true
    case 'number': return v.value === 0
    case 'boolean': return !v.value
    case 'text': return plain(v).length === 0
    case 'list': return v.items.length === 0
    default: return false
  }
}

/** Typed structural equality. Different kinds are never equal; IDs identify references; instants compare by epoch, all-day by day. */
export function valuesEqual(a: FormulaValue, b: FormulaValue, zone = 'UTC'): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'empty': return true
    case 'number': return a.value === (b as typeof a).value
    case 'boolean': return a.value === (b as typeof a).value
    case 'text': return plain(a) === plain(b)
    case 'date': {
      const x = a.value
      const y = (b as typeof a).value
      if (x.kind !== y.kind) return false
      if (x.kind === 'date' && y.kind === 'date') return x.start === y.start && (x.end ?? x.start) === (y.end ?? y.start)
      const i = dateInterval(x, zone)
      const j = dateInterval(y, zone)
      return i.s === j.s && i.e === j.e
    }
    case 'page': return a.id === (b as typeof a).id && a.vaultId === (b as typeof a).vaultId
    case 'person': return a.id === (b as typeof a).id
    case 'list': {
      const y = b as typeof a
      return a.items.length === y.items.length && a.items.every((v, i) => valuesEqual(v, y.items[i], zone))
    }
  }
}

/** Ordering for sort/min/max/comparison operators. Returns null when the two are not comparable. */
export function compareValues(a: FormulaValue, b: FormulaValue, zone = 'UTC', titleOf?: (id: Id) => string | undefined): number | null {
  if (a.kind !== b.kind) return null
  switch (a.kind) {
    case 'number': return a.value < (b as typeof a).value ? -1 : a.value > (b as typeof a).value ? 1 : 0
    case 'boolean': return Number(a.value) - Number((b as typeof a).value)
    case 'text': {
      const x = plain(a)
      const y = plain(b)
      return x < y ? -1 : x > y ? 1 : 0
    }
    case 'date': {
      const i = dateInterval(a.value, zone).s
      const j = dateInterval((b as typeof a).value, zone).s
      return i < j ? -1 : i > j ? 1 : 0
    }
    case 'page': {
      const x = titleOf?.(a.id) ?? a.id
      const y = titleOf?.((b as typeof a).id) ?? (b as typeof a).id
      return x < y ? -1 : x > y ? 1 : a.id < (b as typeof a).id ? -1 : a.id > (b as typeof a).id ? 1 : 0
    }
    case 'person': return a.id < (b as typeof a).id ? -1 : a.id > (b as typeof a).id ? 1 : 0
    default: return null
  }
}

/** Deterministic text of any value for `format()` / `join()`: shortest decimal, ISO dates, visible titles, comma-joined lists. */
export function formatValue(v: FormulaValue, titleOf?: (id: Id) => string | undefined, personName?: (id: Id) => string | undefined): string {
  switch (v.kind) {
    case 'empty': return ''
    case 'number': return plainDecimal(v.value)
    case 'boolean': return v.value ? 'true' : 'false'
    case 'text': return plain(v)
    case 'date': return v.value.end && v.value.end !== v.value.start ? `${v.value.start} → ${v.value.end}` : v.value.start
    case 'page': return titleOf?.(v.id) ?? ''
    case 'person': return personName?.(v.id) ?? ''
    case 'list': return v.items.map((i) => formatValue(i, titleOf, personName)).join(', ')
  }
}

/** FormulaValue -> QValue so a formula / rollup result can be filtered, sorted and grouped by its actual static type. */
export function toQValue(v: FormulaValue): QValue {
  switch (v.kind) {
    case 'empty': return { c: 'empty' }
    case 'number': return { c: 'number', n: v.value }
    case 'boolean': return { c: 'bool', b: v.value }
    case 'text': return { c: 'text', text: plain(v) }
    case 'date': return { c: 'date', v: v.value }
    case 'page': return { c: 'members', ids: [v.id], shape: 'relation' }
    case 'person': return { c: 'members', ids: [v.id], shape: 'people' }
    case 'list': {
      if (v.items.length && v.items.every((i) => i.kind === 'page')) return { c: 'members', ids: v.items.map((i) => (i as { id: Id }).id), shape: 'relation' }
      if (v.items.length && v.items.every((i) => i.kind === 'person')) return { c: 'members', ids: v.items.map((i) => (i as { id: Id }).id), shape: 'people' }
      return { c: 'list', items: v.items.map(toQValue) }
    }
  }
}

/** QValue -> FormulaValue for rollup results consumed by other formulas. */
export function fromQValue(q: QValue, vaultId: Id): FormulaValue {
  switch (q.c) {
    case 'empty': return EMPTY_V
    case 'text': return textV(q.text)
    case 'number': return numV(q.n)
    case 'bool': return boolV(q.b)
    case 'date': return dateV(q.v)
    case 'members': return listV(q.ids.map((id) => (q.shape === 'relation' ? pageV(id, vaultId) : q.shape === 'people' || q.shape === 'created_by' || q.shape === 'last_edited_by' ? personV(id) : textV(id))))
    case 'list': return listV(q.items.map((i) => fromQValue(i, vaultId)))
    case 'blocked': return EMPTY_V
  }
}
