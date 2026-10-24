
/**
 * How many cards were reviewed on which day, per device: { '2026-10-24': { <deviceId>: 12 } }.
 * Counters per device only ever grow, so two devices can be merged by taking the larger one (see merge_kv in src-tauri/src/sync).
 * The pure functions below have no storage and are tested in db/test-srs.mjs.
 */
export type ReviewLog = Record<string, Record<string, number>>

const DAY_MS = 24 * 3600 * 1000

/** Local calendar day, 'YYYY-MM-DD'. */
export const dayKey = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const bump = (log: ReviewLog, device: string, day: string): ReviewLog => ({ ...log, [day]: { ...log[day], [device]: (log[day]?.[device] ?? 0) + 1 } })

export const countOn = (log: ReviewLog, day: string) => Object.values(log[day] ?? {}).reduce((a, b) => a + b, 0)

export const total = (log: ReviewLog) => Object.keys(log).reduce((a, d) => a + countOn(log, d), 0)

/** Days in a row with at least one review, counting back from today (a day that is not over yet does not break the streak). */
export function streak(log: ReviewLog, now: number): number {
  let n = 0
  for (let t = now; ; t -= DAY_MS) {
    if (countOn(log, dayKey(t)) > 0) n++
    else if (t === now) continue // nothing yet today
    else break
    if (n > 3660) break
  }
  return n
}

/** The last `n` days, oldest first. */
export const lastDays = (log: ReviewLog, n: number, now: number) => Array.from({ length: n }, (_, i) => dayKey(now - (n - 1 - i) * DAY_MS)).map((day) => ({ day, count: countOn(log, day) }))
