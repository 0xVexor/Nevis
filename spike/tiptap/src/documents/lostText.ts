// Text that lost its letters on the way in: a client that encodes with a legacy code page (PowerShell 5, cmd, an ANSI pipe)
// turns every Persian letter into "?" before the request ever reaches Nevis. Such a request must not be saved: the letters
// are gone for good and the page would look broken. This only looks at the shape (runs of "?" that make up most of the text).

/** True for one string that is mostly "?" runs (or has the Unicode replacement character). A lone "??" or a question stays fine. */
export function isLostText(s: string): boolean {
  if (s.includes('�')) return true
  const runs = s.match(/\?{2,}/g)
  if (!runs) return false
  const marks = runs.reduce((n, r) => n + r.length, 0)
  const all = s.replace(/\s/g, '').length
  // several runs ("????? ????? NGDIR") need eight marks and a quarter of the text; a single run ("? ????") needs most of it
  return runs.length >= 2 ? marks >= 8 && marks / all > 0.25 : marks >= 4 && marks / all > 0.6
}

/** The first top-level key of `value` whose text looks lost, or null. */
export function lostTextField(value: unknown): string | null {
  const walk = (v: unknown): boolean => typeof v === 'string' ? isLostText(v) : Array.isArray(v) ? v.some(walk) : v && typeof v === 'object' ? Object.values(v).some(walk) : false
  if (!value || typeof value !== 'object') return null
  for (const [key, v] of Object.entries(value)) if (walk(v)) return key.slice(0, 128)
  return null
}

export const LOST_TEXT_MESSAGE = 'The text arrived with many "?" where letters should be, so a non-ASCII encoding step lost them. Nothing was saved. Send the request again as UTF-8 JSON with the real characters.'
