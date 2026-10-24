import { normalizeFa } from './normalize.ts' // explicit extension: this module is also run directly by Node in db/test-srs.mjs

/** Spaced repetition (SM-2 flavoured). Pure, so it can be tested in Node (db/test-srs.mjs). */

export interface Rec {
  ease: number // growth factor of the interval
  interval: number // days; 0 = "again", due again in minutes
  reps: number // successful reviews in a row
  due: number // ms timestamp
}

export type Grade = 0 | 1 | 2 | 3 // again, hard, good, easy

export const AGAIN_MS = 10 * 60 * 1000
const DAY = 24 * 3600 * 1000

export const FRESH: Rec = { ease: 2.5, interval: 0, reps: 0, due: 0 }

export function schedule(prev: Rec | undefined, grade: Grade, now = Date.now()): Rec {
  const r = prev ?? FRESH
  if (grade === 0) return { ease: Math.max(1.3, r.ease - 0.2), interval: 0, reps: 0, due: now + AGAIN_MS }
  let interval: number
  let ease = r.ease
  if (grade === 1) {
    interval = Math.max(1, Math.round((r.interval || 1) * 1.2))
    ease = Math.max(1.3, ease - 0.15)
  } else if (grade === 2) {
    interval = r.reps === 0 ? 1 : r.reps === 1 ? 3 : Math.round(r.interval * ease)
  } else {
    interval = (r.reps === 0 ? 3 : Math.round(r.interval * ease * 1.3)) + 1
    ease += 0.15
  }
  return { ease, interval: Math.max(1, interval), reps: r.reps + 1, due: now + Math.max(1, interval) * DAY }
}

/** "10m", "3d", "2mo" for the buttons under a card. */
export function label(prev: Rec | undefined, grade: Grade): string {
  const next = schedule(prev, grade)
  if (next.interval === 0) return `${Math.round(AGAIN_MS / 60000)}m`
  return next.interval >= 60 ? `${Math.round(next.interval / 30)}mo` : `${next.interval}d`
}

export const isDue = (rec: Rec | undefined, now = Date.now()) => !rec || rec.due <= now

export interface RawCard {
  key: string
  pageId: string
  question: string
  answer: any[]
}

const textOf = (n: any): string => (!n || typeof n === 'string' ? '' : (n.text ?? (n.content ?? []).map(textOf).join(' ')))
// text is not the only content: a formula, a diagram, an image, a page link or a code block is an answer too
const ATOMS = new Set(['image', 'mathBlock', 'mathInline', 'mermaid', 'pageLink', 'codeBlock'])
const hasContent = (n: any): boolean => !!textOf(n).trim() || ATOMS.has(n?.type) || (n?.content ?? []).some(hasContent)

/** Stable id of a question: survives edits elsewhere in the page and Persian letter variants. */
export function hashText(s: string): string {
  let h = 5381
  for (const ch of normalizeFa(s).replace(/\s+/g, ' ').trim()) h = ((h << 5) + h + ch.codePointAt(0)!) | 0
  return (h >>> 0).toString(36)
}

/** Every toggle with a non-empty title and non-empty body is a card: title = question, body = answer. */
export function extractCards(pageId: string, doc: any): RawCard[] {
  const out: RawCard[] = []
  const walk = (n: any) => {
    if (!n || typeof n === 'string') return
    if (n.type === 'toggle') {
      const [head, ...rest] = n.content ?? []
      const question = textOf(head).trim()
      if (question && rest.some(hasContent)) out.push({ key: `${pageId}:${hashText(question)}`, pageId, question, answer: rest })
    }
    ;(n.content ?? []).forEach(walk)
  }
  walk(doc)
  // two toggles with the same question on one page would share a schedule: keep the first
  return out.filter((c, i) => out.findIndex((x) => x.key === c.key) === i)
}
