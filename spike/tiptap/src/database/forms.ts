// Forms (handoff §17.9): schema-linked questions, required / conditional / acyclic branching, one validator shared by the local
// preview, the desktop and the hosted gateway so a public submission can never be accepted by a looser rule than a local one.
import type { Cell, Definition, Id, Json } from './model/types.ts'
import { DbError, fail } from './model/errors.ts'
import { DESCRIPTORS, validateCell, isEmptyCell } from './props/registry.ts'
import { optionsOf } from './props/config.ts'
import { textToRuns } from './text.ts'

export type Condition = { questionId: Id; op: 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty'; value?: Json }
export type Question = {
  id: Id
  propertyId: Id
  title: string
  description: string
  /** the question label mirrors the property name (renaming one asks to rename the other through a schema command) */
  syncLabel: boolean
  required: boolean
  order: number
  inputStyle?: 'default' | 'dropdown' | 'radio' | 'checkboxes' | 'multiline'
  maxSelections?: number
  visibleWhen?: Condition | null
  /** relation / people questions list only these ids; never the whole directory */
  optionProjection?: Id[]
}
export type FormConfig = {
  questions: Question[]
  version: number
  open: boolean
  anonymous: boolean
  submitMessage: string
  limit?: number
}

const NOT_ALLOWED = ['formula', 'rollup', 'button', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'connected', 'verification', 'title2']

export type FormProblem = { questionId: Id | null; code: string; message: string }

/** Static validation of the form definition. A deleted property marks its question broken and blocks publishing. */
export function validateFormConfig(cfg: FormConfig, prop: (id: Id) => Definition | undefined): FormProblem[] {
  const p: FormProblem[] = []
  const seen = new Set<Id>()
  const ordered = [...cfg.questions].sort((a, b) => a.order - b.order)
  const pos = new Map(ordered.map((q, i) => [q.id, i]))
  const usedProps = new Set<Id>()
  for (const q of ordered) {
    if (seen.has(q.id)) p.push({ questionId: q.id, code: 'DUPLICATE', message: 'duplicate question id' })
    seen.add(q.id)
    const d = prop(q.propertyId)
    if (!d) { p.push({ questionId: q.id, code: 'BROKEN', message: 'the linked property was deleted' }); continue }
    if (NOT_ALLOWED.includes(d.kind)) p.push({ questionId: q.id, code: 'KIND', message: `${d.kind} cannot be a form question` })
    if (usedProps.has(q.propertyId)) p.push({ questionId: q.id, code: 'DUPLICATE_PROPERTY', message: 'a property can be asked once' })
    usedProps.add(q.propertyId)
    if (q.visibleWhen) {
      const at = pos.get(q.visibleWhen.questionId)
      if (at === undefined) p.push({ questionId: q.id, code: 'BRANCH', message: 'the condition refers to an unknown question' })
      else if (at >= pos.get(q.id)!) p.push({ questionId: q.id, code: 'BRANCH', message: 'branching must point forward: a condition can only use an earlier question' })
    }
    if (q.maxSelections !== undefined && !(Number.isInteger(q.maxSelections) && q.maxSelections >= 1)) p.push({ questionId: q.id, code: 'MAX', message: 'maxSelections must be a whole number >= 1' })
    if ((d.kind === 'relation' || d.kind === 'people') && !q.optionProjection) p.push({ questionId: q.id, code: 'PROJECTION', message: `${d.kind} questions need an explicit list of allowed choices` })
  }
  return p
}

function condHolds(c: Condition, answers: Record<Id, Json>): boolean {
  const a = answers[c.questionId]
  const empty = a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0)
  switch (c.op) {
    case 'is_empty': return empty
    case 'is_not_empty': return !empty
    case 'equals': return JSON.stringify(a ?? null) === JSON.stringify(c.value ?? null)
    case 'not_equals': return JSON.stringify(a ?? null) !== JSON.stringify(c.value ?? null)
    case 'contains': return Array.isArray(a) ? a.some((x) => JSON.stringify(x) === JSON.stringify(c.value)) : typeof a === 'string' && typeof c.value === 'string' && a.includes(c.value)
  }
}

export function visibleQuestions(cfg: FormConfig, answers: Record<Id, Json>): Question[] {
  const ordered = [...cfg.questions].sort((a, b) => a.order - b.order)
  const shown = new Set<Id>()
  const out: Question[] = []
  for (const q of ordered) {
    // a question hidden by its condition is also hidden when the question it depends on is itself hidden
    if (q.visibleWhen && (!shown.has(q.visibleWhen.questionId) || !condHolds(q.visibleWhen, answers))) continue
    shown.add(q.id)
    out.push(q)
  }
  return out
}

/** Answer JSON -> Cell. Throws INVALID_VALUE with the question id. */
export function answerToCell(d: Definition, q: Question, a: Json): Cell | null {
  const kind = DESCRIPTORS[d.kind].cellKind
  if (!kind) fail('INVALID_VALUE', `${d.kind} cannot be answered`, { questionId: q.id })
  const bad = (m: string): never => fail('INVALID_VALUE', m, { questionId: q.id })
  if (a === undefined || a === null || a === '') return null
  switch (kind) {
    case 'text': return validateCell(d, { kind: 'text', runs: textToRuns(String(a)) })
    case 'number': return typeof a === 'number' ? validateCell(d, { kind: 'number', value: a }) : bad('a number is required')
    case 'select': return typeof a === 'string' ? validateCell(d, { kind: 'select', optionId: a }) : bad('choose one option')
    case 'status': return typeof a === 'string' ? validateCell(d, { kind: 'status', optionId: a }) : bad('choose one option')
    case 'multi_select': {
      if (!Array.isArray(a)) return bad('choose options')
      if (q.maxSelections && a.length > q.maxSelections) bad(`choose at most ${q.maxSelections}`)
      return validateCell(d, { kind: 'multi_select', optionIds: a as string[] })
    }
    case 'date': return validateCell(d, { kind: 'date', value: a as never })
    case 'checkbox': return typeof a === 'boolean' ? { kind: 'checkbox', value: a } : bad('true or false is required')
    case 'people': {
      const ids = Array.isArray(a) ? (a as string[]) : [String(a)]
      if (q.optionProjection && ids.some((i) => !q.optionProjection!.includes(i))) bad('that choice is not offered by this form')
      if (q.maxSelections && ids.length > q.maxSelections) bad(`choose at most ${q.maxSelections}`)
      return validateCell(d, { kind: 'people', principalIds: ids })
    }
    case 'files': return validateCell(d, { kind: 'files', attachmentIds: Array.isArray(a) ? (a as string[]) : [String(a)] })
    case 'url': case 'email': case 'phone': return validateCell(d, { kind, value: String(a) } as Cell)
    case 'place': return validateCell(d, { kind: 'place', value: a as never })
    default: return bad('unsupported question')
  }
}

export type FormResult = { title: string | null; cells: Record<Id, Cell>; relations: Record<Id, Id[]>; errors: { questionId: Id; message: string }[] }

/** Validate an answer set against the form. Hidden required questions are not required; hidden answers are discarded. */
export function evaluateSubmission(cfg: FormConfig, prop: (id: Id) => Definition | undefined, answers: Record<Id, Json>): FormResult {
  const out: FormResult = { title: null, cells: {}, relations: {}, errors: [] }
  for (const q of visibleQuestions(cfg, answers)) {
    const d = prop(q.propertyId)
    if (!d) { out.errors.push({ questionId: q.id, message: 'this question is broken' }); continue }
    const a = answers[q.id]
    try {
      if (d.kind === 'title') {
        const t = typeof a === 'string' ? a : ''
        if (q.required && !t.trim()) throw new DbError('INVALID_VALUE', 'this question is required')
        if (t) out.title = t
        continue
      }
      if (d.kind === 'relation') {
        const ids = a === undefined || a === null || a === '' ? [] : Array.isArray(a) ? (a as string[]) : [String(a)]
        if (q.optionProjection && ids.some((i) => !q.optionProjection!.includes(i))) throw new DbError('INVALID_VALUE', 'that choice is not offered by this form')
        if (q.required && !ids.length) throw new DbError('INVALID_VALUE', 'this question is required')
        if (ids.length) out.relations[d.id] = ids
        continue
      }
      const cell = answerToCell(d, q, a as Json)
      if (q.required) {
        if (d.kind === 'checkbox' ? !(cell && cell.kind === 'checkbox' && cell.value) : !cell || isEmptyCell(cell)) throw new DbError('INVALID_VALUE', d.kind === 'checkbox' ? 'this must be checked' : 'this question is required')
      }
      if (cell && !(d.kind === 'checkbox' && !(cell as { value: boolean }).value && !q.required)) out.cells[d.id] = cell
      else if (cell) out.cells[d.id] = cell
    } catch (e) {
      out.errors.push({ questionId: q.id, message: e instanceof DbError ? e.message : String(e) })
    }
  }
  const known = new Set(cfg.questions.map((q) => q.id))
  for (const k of Object.keys(answers)) if (!known.has(k)) out.errors.push({ questionId: k, message: 'unknown question' })
  return out
}

export { optionsOf }
