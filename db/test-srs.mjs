// Spaced-repetition scheduling and card extraction (src/srs.ts).
import assert from 'node:assert/strict'

const { schedule, label, isDue, extractCards, hashText, FRESH, AGAIN_MS } = await import('../spike/tiptap/src/srs.ts')
const DAY = 86400000
const T0 = 1_000_000_000_000

// ── scheduling ──
let r = schedule(undefined, 2, T0) // new card answered "good"
assert.equal(r.interval, 1, 'good on a new card -> 1 day')
assert.equal(r.due, T0 + DAY)
r = schedule(r, 2, T0 + DAY) // second good
assert.equal(r.interval, 3, 'second good -> 3 days')
r = schedule(r, 2, T0 + 4 * DAY)
assert.equal(r.interval, Math.round(3 * 2.5), 'then interval * ease')
assert.equal(r.reps, 3)

const lapsed = schedule(r, 0, T0)
assert.equal(lapsed.interval, 0, 'again resets the interval')
assert.equal(lapsed.reps, 0)
assert.equal(lapsed.due, T0 + AGAIN_MS, 'again comes back in minutes, not days')
assert.ok(lapsed.ease < r.ease, 'again lowers ease')
assert.ok(schedule(lapsed, 0, T0).ease >= 1.3, 'ease never drops below 1.3')

const hard = schedule(r, 1, T0), good = schedule(r, 2, T0), easy = schedule(r, 3, T0)
assert.ok(hard.interval < good.interval && good.interval < easy.interval, 'hard < good < easy')
assert.ok(easy.ease > r.ease && hard.ease < r.ease, 'easy raises, hard lowers ease')
for (const g of [0, 1, 2, 3]) assert.ok(schedule(r, g, T0).due >= T0, 'never schedules into the past')

assert.equal(label(undefined, 0), '10m')
assert.equal(label(undefined, 2), '1d')
assert.equal(label({ ...FRESH, interval: 100, reps: 5 }, 2), '8mo', 'long intervals are shown in months')
assert.ok(isDue(undefined) && isDue({ ...FRESH, due: 1 }) && !isDue({ ...FRESH, due: Date.now() + 10_000 }), 'due logic')

// ── cards = toggles with a title and a non-empty body ──
const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const doc = {
  type: 'doc',
  content: [
    { type: 'toggle', attrs: { open: false }, content: [P('سؤال یک؟'), P('جواب یک')] },
    { type: 'toggle', content: [P('بدون جواب')] }, // no body -> not a card
    { type: 'toggle', content: [P(''), P('جواب بی‌سؤال')] }, // no title -> not a card
    { type: 'toggle', content: [P('با کد'), { type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] }] }, // code counts as content
    { type: 'callout', content: [{ type: 'toggle', content: [P('تودرتو'), P('جواب تودرتو')] }] }, // found inside other blocks
    { type: 'toggle', content: [P('فرمول؟'), { type: 'paragraph', content: [{ type: 'mathInline', attrs: { latex: 'x' } }] }] }, // an answer that is only a formula
    { type: 'toggle', content: [P('تصویر؟'), { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'att:abc' } }] }] }, // ...or only an image
    { type: 'toggle', content: [P('سؤال یک؟'), P('جواب دیگر')] }, // duplicate question on the same page
  ],
}
const cards = extractCards('page1', doc)
assert.deepEqual(cards.map((c) => c.question), ['سؤال یک؟', 'با کد', 'تودرتو', 'فرمول؟', 'تصویر؟'], 'five real cards (formula-only and image-only answers count), duplicate dropped')
assert.ok(cards.every((c) => c.key.startsWith('page1:')))
assert.equal(hashText('كلاس چیست؟'), hashText('کلاس  چیست؟'), 'Arabic letters / spacing do not change the card identity')
assert.notEqual(hashText('الف'), hashText('ب'))
assert.notEqual(extractCards('a', doc)[0].key, extractCards('b', doc)[0].key, 'same question on two pages = two cards')
console.log('srs OK — scheduling and card extraction behave')

// ── review log (stats shown in the flashcards window) and its merge-friendly shape ──
import { bump, countOn, dayKey, lastDays, streak, total } from '../spike/tiptap/src/reviewlog.ts'
{
  const NOW = new Date(2026, 9, 24, 15, 0, 0).getTime()
  let log = {}
  log = bump(log, 'A', dayKey(NOW))
  log = bump(log, 'A', dayKey(NOW))
  log = bump(log, 'B', dayKey(NOW)) // another device, same day
  assert.equal(countOn(log, dayKey(NOW)), 3, 'devices add up for a day')
  for (const back of [1, 2]) log = bump(log, 'A', dayKey(NOW - back * DAY))
  assert.equal(streak(log, NOW), 3, 'today + 2 days before')
  assert.equal(streak({ [dayKey(NOW - DAY)]: { A: 1 } }, NOW), 1, 'nothing yet today does not break a streak')
  assert.equal(streak({ [dayKey(NOW - 3 * DAY)]: { A: 1 } }, NOW), 0, 'a gap does')
  assert.equal(total(log), 5)
  const days = lastDays(log, 14, NOW)
  assert.equal(days.length, 14)
  assert.equal(days.at(-1).count, 3)
  console.log('review log: ok')
}
