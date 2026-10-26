// Dates, calendars and zones (handoff §8): civil arithmetic, Jalali, DST gap/fold, relative ranges, drag semantics.
import test from 'node:test'
import assert from 'node:assert/strict'

const D = await import('../../../spike/tiptap/src/database/dates.ts')

test('civil validation and arithmetic', () => {
  assert.ok(D.isCivil('2026-10-25'))
  assert.ok(!D.isCivil('2026-02-29'))
  assert.ok(D.isCivil('2028-02-29'))
  assert.ok(!D.isCivil('2026-1-5'))
  assert.equal(D.addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(D.addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(D.diffDays('2026-10-28', '2026-10-25'), 3)
  assert.equal(D.addMonths('2026-01-31', 1), '2026-02-28')
  assert.equal(D.addMonths('2028-01-31', 1), '2028-02-29')
  assert.equal(D.addMonths('2026-12-15', 2), '2027-02-15')
  assert.equal(D.addMonths('2026-01-15', -2), '2025-11-15')
  assert.equal(D.weekdayOf('2026-10-25'), 7) // Sunday
  assert.equal(D.weekdayOf('2026-10-24'), 6) // Saturday
  assert.equal(D.startOfWeek('2026-10-25', 6), '2026-10-24') // Saturday-start week
  assert.equal(D.startOfWeek('2026-10-25', 1), '2026-10-19')
  assert.deepEqual(D.isoWeek('2026-01-01'), { year: 2026, week: 1 })
  assert.deepEqual(D.isoWeek('2027-01-01'), { year: 2026, week: 53 })
})

test('Jalali conversion is exact in both directions', () => {
  assert.deepEqual(D.civilToJalali('2026-03-21'), { y: 1405, m: 1, d: 1 })
  assert.deepEqual(D.civilToJalali('2026-10-25'), { y: 1405, m: 8, d: 3 })
  assert.equal(D.jalaliToCivil(1405, 8, 3), '2026-10-25')
  assert.equal(D.jalaliToCivil(1403, 12, 30), '2025-03-20') // 1403 is a leap year
  assert.throws(() => D.jalaliToCivil(1404, 12, 30)) // 1404 is not
  for (let n = D.civilToDays('2000-01-01'); n < D.civilToDays('2040-01-01'); n += 17) {
    const c = D.daysToCivil(n)
    const j = D.civilToJalali(c)
    assert.equal(D.jalaliToCivil(j.y, j.m, j.d), c)
  }
  assert.equal(D.formatCivil('2026-10-25', { calendar: 'jalali', locale: 'fa-IR' }), '۳ آبان ۱۴۰۵')
})

test('zones: Tehran has no DST, New York has a gap and a fold', () => {
  const teh = D.zonedToEpochDetailed(D.civilParts('2026-10-25', 12, 0), 'Asia/Tehran')
  assert.equal(new Date(teh.epochMs).toISOString(), '2026-10-25T08:30:00.000Z')
  // spring forward 2026-03-08 02:00 -> 03:00 in New York: 02:30 does not exist -> first valid local instant (03:00 EDT = 07:00Z)
  const gap = D.zonedToEpochDetailed(D.civilParts('2026-03-08', 2, 30), 'America/New_York')
  assert.equal(gap.adjusted, true)
  assert.equal(new Date(gap.epochMs).toISOString(), '2026-03-08T07:00:00.000Z')
  // fall back 2026-11-01 02:00 -> 01:00: 01:30 happens twice -> earlier (EDT = 05:30Z)
  const fold = D.zonedToEpochDetailed(D.civilParts('2026-11-01', 1, 30), 'America/New_York')
  assert.equal(fold.fold, true)
  assert.equal(new Date(fold.epochMs).toISOString(), '2026-11-01T05:30:00.000Z')
  assert.equal(D.civilOf(Date.parse('2026-10-24T21:00:00Z'), 'Asia/Tehran'), '2026-10-25') // 00:30 local
})

test('instants parse strictly and normalize to UTC', () => {
  assert.equal(D.parseIsoInstant('2026-10-25T12:00:00+03:30', null), Date.parse('2026-10-25T08:30:00Z'))
  assert.equal(D.parseIsoInstant('2026-10-25T12:00', 'Asia/Tehran'), Date.parse('2026-10-25T08:30:00Z'))
  assert.equal(D.parseIsoInstant('2026-13-25T12:00:00Z', null), null)
  assert.equal(D.parseIsoInstant('hello', null), null)
  const n = D.normalizeDate({ kind: 'datetime', start: '2026-10-25T12:00:00+03:30', end: null, timeZone: 'Asia/Tehran' })
  assert.equal(n.start, '2026-10-25T08:30:00.000Z')
  assert.throws(() => D.normalizeDate({ kind: 'date', start: '2026-10-26', end: '2026-10-25' }))
  assert.throws(() => D.normalizeDate({ kind: 'datetime', start: '2026-10-25T12:00:00Z', end: null, timeZone: 'Nope/Zone' }))
})

test('civil dates keep their day across zones; intervals anchor in the query zone', () => {
  const v = D.civil('2026-10-25')
  const teh = D.dateInterval(v, 'Asia/Tehran')
  const ny = D.dateInterval(v, 'America/New_York')
  assert.equal(teh.e - teh.s, 86400000)
  assert.notEqual(teh.s, ny.s)
  assert.equal(D.civilOf(teh.s, 'Asia/Tehran'), '2026-10-25')
  const range = D.dateInterval(D.civil('2026-10-26', '2026-10-28'), 'Asia/Tehran')
  assert.equal((range.e - range.s) / 86400000, 3) // inclusive end
})

test('relative intervals: rolling vs calendar weeks, injected clock', () => {
  const now = Date.parse('2026-10-25T08:00:00Z')
  const zone = 'Asia/Tehran'
  const dayOf = (ms) => D.civilOf(ms, zone)
  const t = D.relativeInterval('today', now, zone, 6)
  assert.equal(dayOf(t.s), '2026-10-25')
  assert.equal(t.e - t.s, 86400000)
  const past = D.relativeInterval('past_week', now, zone, 6)
  assert.equal(dayOf(past.s), '2026-10-18')
  assert.equal(dayOf(past.e - 1), '2026-10-24') // excludes today
  const nxt = D.relativeInterval('next_week', now, zone, 6)
  assert.equal(dayOf(nxt.s), '2026-10-26')
  assert.equal(dayOf(nxt.e - 1), '2026-11-01')
  const cal = D.relativeInterval('this_week', now, zone, 6) // Saturday start
  assert.equal(dayOf(cal.s), '2026-10-24')
  assert.equal(dayOf(cal.e - 1), '2026-10-30')
  const month = D.relativeInterval('this_month', now, zone, 6)
  assert.equal(dayOf(month.s), '2026-10-01')
  assert.equal(dayOf(month.e - 1), '2026-10-31')
  assert.equal(D.nextMidnightMs(now, zone), D.startOfDayMs('2026-10-26', zone))
})

test('calendar drag keeps duration; endpoint drag rejects inversion', () => {
  const due = D.civil('2026-10-26', '2026-10-28')
  assert.deepEqual(D.shiftDays(due, 1, 'Asia/Tehran'), D.civil('2026-10-27', '2026-10-29'))
  assert.deepEqual(D.moveEndpoint(due, 'end', 2, 'Asia/Tehran'), D.civil('2026-10-26', '2026-10-30'))
  assert.throws(() => D.moveEndpoint(due, 'end', -5, 'Asia/Tehran'))
  assert.deepEqual(D.moveEndpoint(D.civil('2026-10-26'), 'end', 1, 'Asia/Tehran'), D.civil('2026-10-26', '2026-10-27'))
  // timed value keeps local wall time across DST
  const timed = { kind: 'datetime', start: '2026-03-07T14:00:00.000Z', end: '2026-03-07T15:30:00.000Z', timeZone: 'America/New_York' } // 09:00 EST
  const moved = D.shiftDays(timed, 2, 'America/New_York')
  assert.equal(moved.start, '2026-03-09T13:00:00.000Z') // 09:00 EDT
  assert.equal(Date.parse(moved.end) - Date.parse(moved.start), 90 * 60000)
})

test('all-day <-> timed conversion', () => {
  const t = D.civilToTimed(D.civil('2026-10-25'), 'Asia/Tehran')
  assert.equal(t.start, '2026-10-25T05:30:00.000Z') // 09:00 +03:30
  assert.deepEqual(D.timedToCivil(t, 'Asia/Tehran'), D.civil('2026-10-25'))
})
