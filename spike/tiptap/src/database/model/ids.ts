// Identifier and ordering helpers. IDs are UUIDs generated offline; they are never titles, labels or positions.
import type { Id } from './types.ts'

export type IdGen = () => Id

export const randomId: IdGen = () => crypto.randomUUID()

/** Deterministic generator for tests: `seq('p')` -> p1, p2, ... (not valid UUIDs, which is fine for the engine). */
export function seqIds(prefix = 'id'): IdGen {
  let n = 0
  return () => `${prefix}${++n}`
}

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Midpoint of two fractional keys (a < b). Same idea as fractional indexing: keys never end in the zero digit. */
function midpoint(a: string, b: string | null): string {
  const zero = DIGITS[0]
  if (b !== null && a >= b) throw new Error(`sortKey order ${a} >= ${b}`)
  if (b !== null) {
    let n = 0
    while ((a[n] ?? zero) === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[digitA] + midpoint(a.slice(1), null)
}

/**
 * A key after `a`. Plain midpoints grow one character per few appends, which makes a 100k-row import build 10k-character keys, so past the
 * single-character range keys get a length head: 'z' + DIGITS[n] + n digits (a base-62 counter). Longer groups sort after shorter ones, so the
 * length grows with log62 of the number of appended rows. Keys of any other shape fall back to the midpoint rule.
 */
function appendKey(a: string): string {
  const da = DIGITS.indexOf(a[0])
  if (a[0] !== 'z' && da >= 0) return DIGITS[da + 1]
  if (a === 'z') return 'z11'
  const n = DIGITS.indexOf(a[1] ?? '')
  if (a[0] !== 'z' || n < 1 || a.length !== 2 + n) return midpoint(a, null)
  const digits = a.slice(2).split('').map((c) => DIGITS.indexOf(c))
  let i = digits.length - 1
  do {
    for (i = digits.length - 1; i >= 0 && digits[i] === 61; i--) digits[i] = 0
    if (i < 0) return 'z' + DIGITS[n + 1] + '0'.repeat(n) + '1' // overflow: next group
    digits[i]++
  } while (digits[digits.length - 1] === 0) // keys never end in the zero digit
  return 'z' + DIGITS[n] + digits.map((d) => DIGITS[d]).join('')
}

/** A key strictly between `a` and `b` (either may be null = open end). */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`sortKey order ${a} >= ${b}`)
  if (a === null && b === null) return 'V'
  if (a === null) return midpoint('', b)
  if (b === null) return appendKey(a)
  return midpoint(a, b)
}

/** `n` increasing keys between a and b. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  const out: string[] = []
  let prev = a
  for (let i = 0; i < n; i++) {
    const k = keyBetween(prev, b)
    out.push(k)
    prev = k
  }
  return out
}

export const compareKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
