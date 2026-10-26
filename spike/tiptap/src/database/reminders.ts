// Date reminders (handoff §8): a date property may list offsets before the date ("10 minutes before", "1 day before"). The runtime asks which
// are due, fires each at most once per person (the receipt is an event record, so a second device or a restart does not repeat it) and
// catches up on reminders that came due while the app was closed, but only within the look-back window so old ones do not flood.
import type { DateValue, Id } from './model/types.ts'
import type { DbState } from './state.ts'
import { Access } from './access.ts'
import { civilToTimed, dateInterval, isInstantValue } from './dates.ts'

export const REMINDER_LOOKBACK_MS = 24 * 3600_000
/** A date without a time reminds relative to 09:00 local time. */
export const ALL_DAY_REMINDER_HOUR = 9

export type DueReminder = { eventId: Id; pageId: Id; propertyId: Id; offsetMinutes: number; startKey: string; fireAtMs: number; startMs: number; title: string; propertyName: string }

export const reminderEventId = (principalId: Id, pageId: Id, propertyId: Id, offsetMinutes: number, startKey: string) => `reminder:${principalId}:${pageId}:${propertyId}:${offsetMinutes}:${startKey}`

export function dueReminders(state: DbState, principalId: Id, nowMs: number, zone: string, lookbackMs = REMINDER_LOOKBACK_MS): DueReminder[] {
  const access = new Access(state)
  const out: DueReminder[] = []
  for (const def of state.live('property')) {
    if (def.kind !== 'date') continue
    const offsets = ((def.config as { reminders?: { offsetMinutes: number }[] }).reminders ?? []).map((r) => r.offsetMinutes)
    if (!offsets.length) continue
    for (const row of state.rows(def.sourceId)) {
      if (row.page.deletedAt !== null) continue
      const cell = row.ext.cells[def.id]?.value
      const v = cell && cell.kind === 'date' ? (cell.value as DateValue | null) : null
      if (!v) continue
      const startKey = v.start
      const startMs = isInstantValue(v) ? dateInterval(v, zone).s : dateInterval(civilToTimed(v, zone, ALL_DAY_REMINDER_HOUR), zone).s
      for (const off of offsets) {
        const fireAt = startMs - off * 60_000
        if (fireAt > nowMs || fireAt < nowMs - lookbackMs) continue
        if (!access.canSeeRow(principalId, row) || !access.canReadProperty(principalId, def, row)) continue
        const eventId = reminderEventId(principalId, row.page.id, def.id, off, startKey)
        if (state.get('event', eventId)) continue
        out.push({ eventId, pageId: row.page.id, propertyId: def.id, offsetMinutes: off, startKey, fireAtMs: fireAt, startMs, title: row.page.title, propertyName: def.name })
      }
    }
  }
  return out.sort((a, b) => a.fireAtMs - b.fireAtMs || (a.eventId < b.eventId ? -1 : 1))
}
