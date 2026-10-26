// Text helpers shared by the query engine, conversion and formulas. Matching is NFC + Persian normalization + case folding
// (handoff §10); original content is never altered, only the derived keys.
import { normalizeFa } from '../normalize.ts'
import type { RichRun } from './model/types.ts'

export const runsToText = (runs: RichRun[]): string => runs.map((r) => r.text).join('')
export const textToRuns = (s: string): RichRun[] => (s ? [{ text: s }] : [])

/** Key used for substring matching, equality and search. */
export const matchKey = (s: string): string => normalizeFa(s.normalize('NFC'))

/** Pinned sort key: NFC, Persian normalization, case fold; compared by Unicode code point (not locale order). */
export const collationKey = (s: string): string => matchKey(s)

/** Compare two strings by code point, not UTF-16 unit, so astral characters order consistently across adapters. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0
  const ai = a[Symbol.iterator]()
  const bi = b[Symbol.iterator]()
  for (;;) {
    const x = ai.next()
    const y = bi.next()
    if (x.done && y.done) return 0
    if (x.done) return -1
    if (y.done) return 1
    const cx = x.value.codePointAt(0)!
    const cy = y.value.codePointAt(0)!
    if (cx !== cy) return cx < cy ? -1 : 1
  }
}

const DIGIT_MAP: Record<string, string> = {}
'۰۱۲۳۴۵۶۷۸۹'.split('').forEach((c, i) => (DIGIT_MAP[c] = String(i)))
'٠١٢٣٤٥٦٧٨٩'.split('').forEach((c, i) => (DIGIT_MAP[c] = String(i)))

/** Persian / Arabic-Indic digits to ASCII. */
export const asciiDigits = (s: string): string => s.replace(/[۰-۹٠-٩]/g, (c) => DIGIT_MAP[c] ?? c)

/**
 * Strict decimal parsing (handoff §9 rule 3): trim, normalize digits and the configured decimal separator, accept a full finite
 * decimal only. No partial parseFloat, no currency stripping, empty is not zero.
 */
export function parseStrictNumber(input: string, decimalSeparator = '.'): number | null {
  let s = asciiDigits(input.normalize('NFC')).trim()
  if (!s) return null
  // the Arabic decimal separator U+066B is unambiguous, so it is always accepted; a comma only when the user configured it
  s = s.replace(/٫/g, '.')
  if (decimalSeparator === ',') s = s.replace(/,/g, '.')
  s = s.replace(/−/g, '-') // typographic minus
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Stable CSV-safe check: a spreadsheet would execute a cell that starts with one of these. */
export const startsLikeFormula = (s: string): boolean => /^[=+\-@\t\r]/.test(s)

export const isBlankText = (s: string): boolean => s.length === 0
