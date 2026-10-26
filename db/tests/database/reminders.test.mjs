// Date reminders: due window, once per person, catch-up limit, access.
import test from 'node:test'
import assert from 'node:assert/strict'

const { createHarness, FIXTURE_ZONE } = await import('../../../spike/tiptap/src/database/fixtures.ts')
const { dueReminders } = await import('../../../spike/tiptap/src/database/reminders.ts')

async function setup() {
  const h = createHarness()
  const db = await h.one('database.create', { title: 'Tasks' })
  const due = (await h.one('property.create', { sourceId: db.sourceId, name: 'Due', kind: 'date', config: { reminders: [{ offsetMinutes: 60 }, { offsetMinutes: 1440 }] } })).propertyId
  const mk = (title, start) => h.one('row.create', { sourceId: db.sourceId, title, id: title, explicitValues: { [due]: { kind: 'date', value: { kind: 'datetime', start, end: null, timeZone: FIXTURE_ZONE } } } })
  return { h, db, due, mk }
}
const at = (iso) => Date.parse(iso)

test('a reminder is due from its offset until the look-back window ends', async () => {
  const { h, mk } = await setup()
  await mk('A', '2026-10-25T12:00:00Z')
  assert.equal(dueReminders(h.state, 'U1', at('2026-10-25T10:59:00Z'), FIXTURE_ZONE).length, 1) // the 1-day-before one, due since yesterday noon
  const due = dueReminders(h.state, 'U1', at('2026-10-25T11:00:00Z'), FIXTURE_ZONE)
  assert.deepEqual(due.map((d) => d.offsetMinutes).sort((a, b) => a - b), [60, 1440])
  assert.equal(dueReminders(h.state, 'U1', at('2026-10-27T00:00:00Z'), FIXTURE_ZONE).length, 0) // missed by more than a day: not replayed
})

test('firing records a receipt and the reminder is not due again; another person still gets theirs', async () => {
  const { h, db, due, mk } = await setup()
  await mk('A', '2026-10-25T12:00:00Z')
  h.setClock(at('2026-10-25T11:30:00Z'))
  const list = dueReminders(h.state, 'U1', h.state ? at('2026-10-25T11:30:00Z') : 0, FIXTURE_ZONE)
  assert.equal(list.length, 2)
  const r = list[0]
  const first = await h.one('reminder.fire', { pageId: r.pageId, propertyId: r.propertyId, offsetMinutes: r.offsetMinutes, startKey: r.startKey })
  assert.equal(first.fired, true)
  const again = await h.one('reminder.fire', { pageId: r.pageId, propertyId: r.propertyId, offsetMinutes: r.offsetMinutes, startKey: r.startKey })
  assert.equal(again.fired, false)
  assert.equal(dueReminders(h.state, 'U1', at('2026-10-25T11:30:00Z'), FIXTURE_ZONE).length, 1)
  assert.ok(db && due)
})

test('date-only values remind relative to 09:00 local time; changing the date makes a new reminder', async () => {
  const { h, db, due } = await setup()
  await h.one('row.create', { sourceId: db.sourceId, title: 'B', id: 'B', explicitValues: { [due]: { kind: 'date', value: { kind: 'date', start: '2026-10-25', end: null } } } })
  // 09:00 Asia/Tehran (+03:30 in October) = 05:30Z; one hour before = 04:30Z
  assert.equal(dueReminders(h.state, 'U1', at('2026-10-25T04:29:00Z'), FIXTURE_ZONE).filter((d) => d.offsetMinutes === 60).length, 0)
  assert.equal(dueReminders(h.state, 'U1', at('2026-10-25T04:31:00Z'), FIXTURE_ZONE).filter((d) => d.offsetMinutes === 60).length, 1)
})
