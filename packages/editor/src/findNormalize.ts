// Persian-aware matching for find-in-page (the official, shared normalization is ADR-0010 / M10: it replaces this then).
// Per character, so that an offset in the normalized text maps 1:1 back to a document position. A character may normalize to ''
// (diacritics, tatweel): it is skipped.
const MAP: Record<string, string> = { 'ي': 'ی', 'ى': 'ی', 'ك': 'ک', 'ۀ': 'ه', 'ة': 'ه', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا', '\u200c': ' ', '\u200d': '', '\u00a0': ' ' }
export function normalizeChar(ch: string): string {
  if (/[\u064b-\u065f\u0670\u0640\u200e\u200f\u061c]/.test(ch)) return ''
  if (/[\u06f0-\u06f9]/.test(ch)) return String(ch.charCodeAt(0) - 0x06f0)
  if (/[\u0660-\u0669]/.test(ch)) return String(ch.charCodeAt(0) - 0x0660)
  return (MAP[ch] ?? ch).toLowerCase()
}
export const normalizeFa = (s: string): string => Array.from(s, normalizeChar).join('')
