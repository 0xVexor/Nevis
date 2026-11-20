// Sort keys (ADR-0004 §4): fractional index + random suffix.
import { generateKeyBetween } from 'fractional-indexing'

const SUFFIX_CHARS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' // never '0': a fractional key must not end in the lowest digit

/** A sort key between two neighbours (either may be null = the end), with a random suffix so two devices inserting at the same
 *  spot at the same time get different keys (ADR-0004 §4). */
export function sortKeyBetween(before: string | null, after: string | null, rnd: () => number = Math.random): string {
  const base = generateKeyBetween(before, after) // strictly between the neighbours, without a suffix
  // base + suffix is > before (it extends base), but it can reach or pass `after` when `after` itself starts with `base`
  // (neighbours carry suffixes!): then it would land in the wrong place. Retry with another suffix; a key with no suffix is always valid.
  for (let attempt = 0; attempt < 8; attempt++) {
    let suffix = ''
    for (let i = 0; i < 4; i++) suffix += SUFFIX_CHARS[Math.floor(rnd() * SUFFIX_CHARS.length)]
    const key = base + suffix
    if ((before === null || key > before) && (after === null || key < after)) return key
  }
  return base
}
