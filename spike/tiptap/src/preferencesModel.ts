export type Preferences = Record<string, string | null>
const parse = (v: unknown): unknown => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v) } catch { return v } }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v ?? null
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
export const preferenceKey = (v: Preferences) => JSON.stringify(canonical(Object.fromEntries(Object.entries(v).map(([k, value]) => [k, parse(value)]))))
function merge(b: unknown, l: unknown, r: unknown): unknown {
  if (equal(l, r) || equal(b, r)) return l
  if (equal(b, l)) return r
  if (object(l) && object(r)) {
    const base = object(b) ? b : {}
    return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(l), ...Object.keys(r)])].sort().map((k) => [k, merge(base[k] ?? null, l[k] ?? null, r[k] ?? null)]))
  }
  return l // newest unsaved input remains local; the native writer archives a conflicting durable version.
}
/** Rebase unsaved control changes onto a newly durable/remote preference snapshot, including individual Settings fields. */
export function rebasePreferences(base: Preferences, local: Preferences, remote: Preferences): Preferences {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort().map((k) => {
    const value = merge(parse(base[k]), parse(local[k]), parse(remote[k]))
    return [k, value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value)]
  }))
}
