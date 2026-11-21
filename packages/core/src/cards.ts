// Flashcards (ROADMAP M11). A card is a toggle block of a page (title = question, body = answer), as in the old app: nothing is stored for
// the card itself. A REVIEW is an immutable event about the card (ADR-0004), and the schedule is a deterministic FOLD over a card's reviews
// in (hlc, id) order: two devices that review the same card at the same time both keep their review, and both compute the same schedule.
//
// The scheduler is the old app's (SM-2 flavoured), versioned by SCHEDULER_VERSION. (ROADMAP named FSRS; the old app's own scheduler was
// kept so that the schedules of existing cards continue unchanged. A different scheduler is a new SCHEDULER_VERSION and a refold.)
import { normalizeForSearch } from '@nevis/text-fa'
import type { Client } from './client'
import type { EventRow } from './store'

export const SCHEDULER_VERSION = 1
export type Grade = 0 | 1 | 2 | 3 // again, hard, good, easy
export const REVIEW_KIND = 'review'

export interface Rec { ease: number; interval: number; reps: number; due: number; last?: number }
export const AGAIN_MS = 10 * 60 * 1000
const DAY = 24 * 3600 * 1000
export const FRESH: Rec = { ease: 2.5, interval: 0, reps: 0, due: 0 }

/** The next state after a review at `now`. Pure. */
export function schedule(prev: Rec | undefined, grade: Grade, now: number): Rec {
  const r = prev ?? FRESH
  if (grade === 0) return { ease: Math.max(1.3, r.ease - 0.2), interval: 0, reps: 0, due: now + AGAIN_MS, last: now }
  let interval: number
  let ease = r.ease
  if (grade === 1) { interval = Math.max(1, Math.round((r.interval || 1) * 1.2)); ease = Math.max(1.3, ease - 0.15) }
  else if (grade === 2) interval = r.reps === 0 ? 1 : r.reps === 1 ? 3 : Math.round(r.interval * ease)
  else { interval = (r.reps === 0 ? 3 : Math.round(r.interval * ease * 1.3)) + 1; ease += 0.15 }
  return { ease, interval: Math.max(1, interval), reps: r.reps + 1, due: now + Math.max(1, interval) * DAY, last: now }
}

/** "10m", "3d", "2mo": the text under a rating button. */
export function intervalLabel(prev: Rec | undefined, grade: Grade, now: number): string {
  const next = schedule(prev, grade, now)
  if (next.interval === 0) return `${Math.round(AGAIN_MS / 60000)}m`
  return next.interval >= 60 ? `${Math.round(next.interval / 30)}mo` : `${next.interval}d`
}
export const isDue = (rec: Rec | undefined, now: number) => !rec || rec.due <= now

export interface ReviewBody { card: string; rating: Grade; reviewedAt: number; durationMs: number }

const cmp = (a: EventRow, b: EventRow) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The schedule of every card that was reviewed: a fold over its reviews in (hlc, id) order, each applied at ITS OWN review time. The
 *  result does not depend on the order the events arrived in. */
export function foldSchedules(events: EventRow[]): Map<string, Rec> {
  const out = new Map<string, Rec>()
  for (const e of [...events].filter(x => x.kind === REVIEW_KIND).sort(cmp)) {
    let b: ReviewBody
    try { b = JSON.parse(e.body) as ReviewBody } catch { continue }
    if (![0, 1, 2, 3].includes(b.rating) || !Number.isFinite(b.reviewedAt)) continue
    out.set(e.ent, schedule(out.get(e.ent), b.rating, b.reviewedAt))
  }
  return out
}

/** Every review, newest last, for the activity calendar. */
export function reviewTimes(events: EventRow[]): number[] {
  const out: number[] = []
  for (const e of events) if (e.kind === REVIEW_KIND) { try { const t = (JSON.parse(e.body) as ReviewBody).reviewedAt; if (Number.isFinite(t)) out.push(t) } catch { /* skip */ } }
  return out.sort((a, b) => a - b)
}

// ---- cards in a page -------------------------------------------------------------------------------------------------------------
export interface PMLike { type?: string; text?: string; content?: PMLike[] }
export interface RawCard { id: string; pageId: string; question: string; answer: string }

const textOf = (n: PMLike | undefined): string => (!n ? '' : (n.text ?? (n.content ?? []).map(textOf).join(n.type === 'paragraph' || n.type === 'heading' ? '' : ' ')))
const ATOMS = new Set(['image', 'mathBlock', 'mathInline', 'mermaid', 'pageLink', 'codeBlock', 'file', 'drawing'])
const hasContent = (n: PMLike | undefined): boolean => !!textOf(n).trim() || ATOMS.has(n?.type ?? '') || (n?.content ?? []).some(hasContent)

/** A card's identity: a UUID-shaped id from the page and the normalized question, so it survives edits elsewhere and letter variants. */
export function cardId(pageId: string, question: string): string {
  const s = `${pageId}\u0000${normalizeForSearch(question).replace(/\s+/g, ' ').trim()}`
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x9e3779b9, h4 = 0x85ebca6b
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); h3 = Math.imul(h3 ^ c, 2246822519); h4 = Math.imul(h4 ^ c, 3266489917)
  }
  const hex = [h1, h2, h3, h4].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Every toggle with a question and a non-empty body is a card. Two toggles with the same question on one page share one card. */
export function extractCards(pageId: string, doc: PMLike | null | undefined): RawCard[] {
  const out: RawCard[] = []
  const walk = (n: PMLike | undefined) => {
    if (!n) return
    if (n.type === 'toggle') {
      const [head, ...rest] = n.content ?? []
      const question = textOf(head).trim()
      if (question && rest.some(hasContent)) out.push({ id: cardId(pageId, question), pageId, question, answer: rest.map(textOf).join('\n').trim() })
    }
    ;(n.content ?? []).forEach(walk)
  }
  walk(doc ?? undefined)
  return out.filter((c, i) => out.findIndex(x => x.id === c.id) === i)
}

/** Records a review. The card id is the entity of the event. */
export function reviewCard(client: Client, card: string, rating: Grade, now: number, durationMs = 0): Promise<string> {
  return client.addEvent(card, REVIEW_KIND, { card, rating, reviewedAt: now, durationMs } satisfies ReviewBody)
}
