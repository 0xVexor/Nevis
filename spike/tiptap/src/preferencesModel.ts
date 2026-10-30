export type Preferences = Record<string, string | null>
const parse = (v: unknown): unknown => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v) } catch { return v } }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v ?? null
/** A stable fingerprint of a preference snapshot: key order and JSON spacing do not change it. */
export const preferenceKey = (v: Preferences) => JSON.stringify(canonical(Object.fromEntries(Object.entries(v).map(([k, value]) => [k, parse(value)]))))
