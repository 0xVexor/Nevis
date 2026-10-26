// QValue: the typed, static value class that filters, sorts, groups and aggregates work on. Every property (stored, system,
// relation, formula, rollup) is first reduced to a QValue, so the operators exist once.
import type { DateValue, Id } from '../model/types.ts'
import { dateInterval } from '../dates.ts'

export type MemberShape = 'select' | 'multi_select' | 'status' | 'people' | 'files' | 'relation' | 'created_by' | 'last_edited_by'

export type QValue =
  | { c: 'empty' }
  | { c: 'text'; text: string }
  | { c: 'number'; n: number }
  | { c: 'bool'; b: boolean }
  | { c: 'date'; v: DateValue }
  | { c: 'members'; ids: Id[]; shape: MemberShape }
  | { c: 'list'; items: QValue[] }
  | { c: 'blocked'; state: 'pending' | 'restricted' | 'error'; code?: string; detail?: string }

export const EMPTY: QValue = { c: 'empty' }

/** Empty for filtering (handoff §10). A blocked value is never "empty": it must not be used to infer matches. */
export function qEmpty(q: QValue): boolean {
  switch (q.c) {
    case 'empty': return true
    case 'text': return q.text.length === 0
    case 'members': return q.ids.length === 0
    case 'list': return q.items.length === 0
    case 'number':
    case 'bool':
    case 'date':
    case 'blocked': return false
  }
}

/** Scalar leaves of a value: members and lists flatten one level, empties vanish. */
export function leaves(q: QValue): QValue[] {
  switch (q.c) {
    case 'empty': return []
    case 'text': return q.text.length ? [q] : []
    case 'members': return q.ids.map((id) => ({ c: 'text', text: id }) as QValue)
    case 'list': return q.items.flatMap((i) => (i.c === 'list' ? i.items.flatMap(leaves) : leaves(i)))
    default: return [q]
  }
}

/** Typed equality key (IDs define identity for members; text compares exactly). */
export function leafKey(q: QValue, zone: string): string {
  switch (q.c) {
    case 'empty': return 'e'
    case 'text': return `t:${q.text}`
    case 'number': return `n:${q.n}`
    case 'bool': return `b:${q.b}`
    case 'date': {
      const i = dateInterval(q.v, zone)
      return `d:${i.s}:${i.e}`
    }
    case 'members': return `m:${q.ids.join(',')}`
    case 'list': return `l:[${q.items.map((i) => leafKey(i, zone)).join(';')}]`
    case 'blocked': return `x:${q.state}`
  }
}

export const num = (n: number): QValue => ({ c: 'number', n })
export const text = (s: string): QValue => ({ c: 'text', text: s })
export const bool = (b: boolean): QValue => ({ c: 'bool', b })
