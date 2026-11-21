// Page history (ROADMAP M11). A version is an immutable event about the page: `{at, manual, json}` where `json` is the page as ProseMirror
// JSON text. Versions are made by the app 5 minutes after the last edit (auto) or by the person (manual). To look at the history the
// versions are THINNED by a deterministic rule; the events are physically removed later by the purge of M13 (events are immutable until then).
// Restoring a version is an ordinary edit of the page's Yjs document (the app writes the old body in one transaction), so it syncs and
// converges like any other change.
import type { Client } from './client'
import type { EventRow } from './store'

export const VERSION_KIND = 'version'
/** A page whose JSON text is longer than this is not versioned automatically (one op may carry at most ~1.5M characters). */
export const MAX_VERSION_CHARS = 1_000_000
export const AUTO_AFTER_MS = 5 * 60 * 1000

export interface Version { id: string; page: string; at: number; manual: boolean; label: string; json: string }

const HOUR = 3600_000, DAY = 24 * HOUR

/** Writes a version. Returns the event id, or null if the page is too large to keep a version of. */
export async function addVersion(client: Client, page: string, json: string, o: { at: number; manual?: boolean; label?: string }): Promise<string | null> {
  if (json.length > MAX_VERSION_CHARS) return null
  return client.addEvent(page, VERSION_KIND, { at: o.at, manual: !!o.manual, label: o.label ?? '', json })
}

export function readVersions(events: EventRow[], page: string): Version[] {
  const out: Version[] = []
  for (const e of events) {
    if (e.kind !== VERSION_KIND || e.ent !== page) continue
    try { const b = JSON.parse(e.body) as { at: number; manual: boolean; label?: string; json: string }; out.push({ id: e.id, page, at: b.at, manual: !!b.manual, label: b.label ?? '', json: b.json }) } catch { /* unreadable: skipped */ }
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)) // newest first
}

/** Which versions stay visible at `now`: every one up to an hour old, one per hour up to 24 hours, one per day up to 30 days, one per week
 *  after that (the LATEST of each bucket). A manual version and the newest version are never dropped. */
export function thinVersions(versions: Version[], now: number): Version[] {
  const kept: Version[] = []
  const seen = new Set<string>()
  const sorted = [...versions].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
  sorted.forEach((v, i) => {
    const age = Math.max(0, now - v.at)
    const bucket = age <= HOUR ? `x${v.id}` : age <= DAY ? `h${Math.floor(v.at / HOUR)}` : age <= 30 * DAY ? `d${Math.floor(v.at / DAY)}` : `w${Math.floor(v.at / (7 * DAY))}`
    if (v.manual || i === 0 || !seen.has(bucket)) { kept.push(v); seen.add(bucket) }
  })
  return kept
}
