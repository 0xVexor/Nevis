// Numeric cells are DECIMAL STRINGS, never JSON numbers (ADR-0004): "12.50" stays "12.50", a long number never loses a digit.
// `normalizeDecimal` turns what a person typed (Persian or Arabic-Indic digits, Persian separators) into that form, or refuses.
//
// Rules (documented in docs/formats/records-v1.md; refusing is better than a silent misreading):
//  - digits ۰-۹ and ٠-٩ become 0-9; LRM, RLM, ALM, ZWNJ, ZWSP and surrounding spaces are removed; "−" (U+2212) is a minus; a leading "+" is dropped;
//  - the decimal separator is "٫" (U+066B) or "."; "/" is NOT one ("1/2" is a fraction, not 1.2): refused;
//  - "٬" (U+066C), "," and "،" are THOUSANDS separators, accepted only in valid groups (1-3 digits, then groups of exactly 3):
//    "1,234" is 1234; "1,5" is refused (it could mean 1.5 or 15);
//  - no exponent, no other characters; at most 100 characters;
//  - the result drops leading zeros and a bare trailing ".", keeps trailing zeros ("12.50"), and has no "-0".
const INVISIBLE = /[‎‏؜‌​⁦-⁩]/g

export function toAsciiDigits(s: string): string {
  return s.replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660))
}

export function normalizeDecimal(input: string): string | null {
  if (input.length > 100) return null
  let s = toAsciiDigits(input.replace(INVISIBLE, '')).trim()
  if (s === '') return null
  let neg = false
  if (s[0] === '-' || s[0] === '−') { neg = true; s = s.slice(1) } else if (s[0] === '+') s = s.slice(1)
  s = s.replace(/٫/g, '.')
  const dot = s.indexOf('.')
  if (dot !== s.lastIndexOf('.')) return null
  let int = dot < 0 ? s : s.slice(0, dot)
  let frac = dot < 0 ? '' : s.slice(dot + 1)
  if (/[^0-9]/.test(frac)) return null
  if (/[,٬،]/.test(int)) {
    const groups = int.split(/[,٬،]/)
    if (!(/^[0-9]{1,3}$/.test(groups[0]!) && groups.slice(1).every(g => /^[0-9]{3}$/.test(g)))) return null
    int = groups.join('')
  }
  if (int === '' && frac === '') return null
  if (/[^0-9]/.test(int)) return null
  int = int.replace(/^0+(?=[0-9])/, '')
  if (int === '') int = '0'
  const zero = /^0*$/.test(int + frac)
  return `${neg && !zero ? '-' : ''}${int}${frac ? '.' + frac : ''}`
}

/** Exact comparison of two normalized decimals (no floating point). */
export function compareDecimal(a: string, b: string): number {
  const na = a.startsWith('-'), nb = b.startsWith('-')
  if (na !== nb) return na ? -1 : 1
  const [ia = '', fa = ''] = (na ? a.slice(1) : a).split('.')
  const [ib = '', fb = ''] = (nb ? b.slice(1) : b).split('.')
  let c = ia.length !== ib.length ? (ia.length < ib.length ? -1 : 1) : ia < ib ? -1 : ia > ib ? 1 : 0
  if (c === 0) { const n = Math.max(fa.length, fb.length); const x = fa.padEnd(n, '0'), y = fb.padEnd(n, '0'); c = x < y ? -1 : x > y ? 1 : 0 }
  return na ? -c : c
}
