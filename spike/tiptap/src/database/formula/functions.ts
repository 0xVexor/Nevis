// The executable formula function registry (handoff §15): arity, argument/result types, lazy argument positions, docs and test
// ids for every name. `FUNCTIONS` is exported as data so the editor, the docs and the tests all read the same table.
import type { DateValue, FormulaValue, Id, RichRun } from '../model/types.ts'
import {
  addDays, addMonths, civilOf, civilParts, civilString, dateInterval, diffDays, isCivil, isoWeek, normalizeDate, parseCivil,
  parseIsoInstant, toIso, weekdayOf, zonedParts, zonedToEpoch,
} from '../dates.ts'
import { formatNumber } from '../props/numberFormat.ts'
import { numberConfig, OPTION_COLORS } from '../props/config.ts'
import { isSafeUrl } from '../props/registry.ts'
import { parseStrictNumber, runsToText } from '../text.ts'
import type { Ctx, Scope } from './runtime.ts'
import { newScope } from './runtime.ts'
import type { Node } from './syntax.ts'
import {
  boolV, compareValues, dateV, EMPTY_V, formatValue, formulaEmpty, listV, numV, plain, runsV, textV, typeName, valuesEqual,
} from './values.ts'

export type Arg = FormulaValue | Node

export interface FnSpec {
  name: string
  min: number
  max: number
  /** documentation signature, one entry per positional argument (variadic tail repeats the last) */
  params: string[]
  /** positions evaluated by the function itself (lazy). `from` = every position from that index on */
  lazy?: { at?: number[]; from?: number }
  /** an Empty value in a non-lazy argument makes the whole call Empty */
  propagateEmpty?: boolean
  /** static argument types ('number','text','boolean','date','list','page','person','any'; '|' unions) */
  args?: string[]
  /** result type from argument types */
  returns: (t: string[]) => string
  doc: string
  /** ids of tests in db/tests/database/formula.test.mjs that cover this function (positive / boundary / error) */
  tests: string[]
  hidden?: boolean
  impl: (a: Arg[], cx: Ctx, node: Node) => FormulaValue
}

// ───── helpers ─────

const T = {
  num: 'number', txt: 'text', bool: 'boolean', date: 'date', any: 'any', page: 'page', person: 'person',
}
const listOf = (t: string) => `list<${t}>`
export const isListType = (t: string) => t === 'list' || t.startsWith('list<')
export const elemType = (t: string) => (t.startsWith('list<') ? t.slice(5, -1) : 'any')
const sameOr = (a: string, b: string) => (a === b ? a : a === 'any' ? b : b === 'any' ? a : 'any')

function needNum(v: FormulaValue, cx: Ctx, node: Node, what = 'argument'): number {
  if (v.kind !== 'number') return cx.err(node, 'FORMULA_TYPE', `${what} must be a Number, got ${typeName(v)}`)
  return v.value
}
function needText(v: FormulaValue, cx: Ctx, node: Node, what = 'argument'): string {
  if (v.kind !== 'text') return cx.err(node, 'FORMULA_TYPE', `${what} must be Text, got ${typeName(v)}`)
  return plain(v)
}
function needList(v: FormulaValue, cx: Ctx, node: Node, what = 'argument'): FormulaValue[] {
  if (v.kind !== 'list') return cx.err(node, 'FORMULA_TYPE', `${what} must be a List, got ${typeName(v)}`)
  return v.items
}
function needDate(v: FormulaValue, cx: Ctx, node: Node, what = 'argument'): DateValue {
  if (v.kind !== 'date') return cx.err(node, 'FORMULA_TYPE', `${what} must be a Date, got ${typeName(v)}`)
  return v.value
}
function needBool(v: FormulaValue, cx: Ctx, node: Node, what = 'argument'): boolean {
  if (v.kind !== 'boolean') return cx.err(node, 'FORMULA_TYPE', `${what} must be a Boolean, got ${typeName(v)}`)
  return v.value
}
function needInt(v: FormulaValue, cx: Ctx, node: Node, what = 'argument'): number {
  const n = needNum(v, cx, node, what)
  if (!Number.isInteger(n)) return cx.err(node, 'FORMULA_DOMAIN', `${what} must be an integer`)
  return n
}

function finite(n: number, cx: Ctx, node: Node): FormulaValue {
  if (!Number.isFinite(n)) return cx.err(node, 'FORMULA_DOMAIN', 'result is not a finite number')
  return numV(n)
}

function checkList(len: number, cx: Ctx, node: Node) {
  if (len > cx.budget.maxListItems) cx.err(node, 'FORMULA_BUDGET', `list is longer than ${cx.budget.maxListItems} items`)
}
function checkText(len: number, cx: Ctx, node: Node) {
  if (len * 2 > cx.budget.maxTextBytes) cx.err(node, 'FORMULA_BUDGET', 'text is larger than 1 MB')
}

const cps = (s: string) => Array.from(s)

/** Evaluate a lazily-passed argument with `current` / `index` bound (nested calls get their own scope). */
function withElem(cx: Ctx, expr: Node, item: FormulaValue, index: number): FormulaValue {
  const sc: Scope = newScope(cx.scope)
  sc.vars.set('current', item)
  sc.vars.set('index', numV(index))
  return cx.eval(expr, sc)
}

/** Decimal rounding, ties toward +infinity: 2.5 -> 3, -2.5 -> -2, and 1.005 -> 1.01 because the shortest decimal is used, not binary noise. */
export function roundDecimal(x: number, places: number): number {
  if (!Number.isFinite(x) || x === 0) return x
  const neg = x < 0
  let s = Math.abs(x).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
  if (/e/i.test(s)) s = Math.abs(x).toFixed(20)
  const [ip, fp = ''] = s.split('.')
  const scale = fp.length
  if (places >= scale) return x
  const N = BigInt(ip + fp)
  const k = scale - places
  const p = 10n ** BigInt(k)
  let q = N / p
  const r = N % p
  if (neg ? r * 2n > p : r * 2n >= p) q += 1n
  const out = Number(`${neg ? '-' : ''}${q}e${-places}`)
  return Object.is(out, -0) ? 0 : out
}

// ───── regex safety: bounded, linear-ish patterns only ─────

export function safeRegex(pattern: string, flags: string, cx: Ctx, node: Node): RegExp {
  if (pattern.length > 500) cx.err(node, 'FORMULA_REGEX', 'pattern is longer than 500 characters')
  if (/\\[1-9]|\\k</.test(pattern)) cx.err(node, 'FORMULA_REGEX', 'backreferences are not supported')
  if (/\(\?<[=!]/.test(pattern)) cx.err(node, 'FORMULA_REGEX', 'lookbehind is not supported')
  // a quantified group that itself contains a quantifier is the classic catastrophic-backtracking shape
  const stack: { quant: boolean }[] = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') { i++; continue }
    if (c === '[') { while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1; continue }
    if (c === '(') stack.push({ quant: false })
    else if (c === ')') {
      const g = stack.pop()
      const nx = pattern[i + 1]
      const quantified = nx === '*' || nx === '+' || (nx === '{' && /^\{\d+,\d*\}/.test(pattern.slice(i + 1)))
      if (g?.quant && quantified) cx.err(node, 'FORMULA_REGEX', 'nested repetition is not supported')
      if (stack.length && (g?.quant || quantified)) stack[stack.length - 1].quant = true
    } else if ((c === '*' || c === '+' || (c === '{' && /^\{\d+,\d*\}/.test(pattern.slice(i)))) && stack.length) stack[stack.length - 1].quant = true
  }
  try {
    return new RegExp(pattern, flags + 'u')
  } catch (e) {
    return cx.err(node, 'FORMULA_REGEX', `invalid pattern: ${(e as Error).message}`)
  }
}
const MAX_SUBJECT = 100_000
const subject = (s: string, cx: Ctx, node: Node) => (s.length > MAX_SUBJECT ? cx.err(node, 'FORMULA_BUDGET', 'text is too long for pattern matching') : s)

// ───── date helpers ─────

const UNITS = ['years', 'quarters', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const
type Unit = (typeof UNITS)[number]
function unitOf(v: FormulaValue, cx: Ctx, node: Node): Unit {
  const s = needText(v, cx, node, 'unit').toLowerCase()
  const u = (s.endsWith('s') ? s : s + 's') as Unit
  if (!(UNITS as readonly string[]).includes(u)) return cx.err(node, 'FORMULA_DOMAIN', `unknown unit "${s}"`)
  return u
}

function shiftPoint(iso: string, tz: string, n: number, unit: Unit): string {
  const ms = parseIsoInstant(iso, tz)!
  if (unit === 'hours') return toIso(ms + n * 3_600_000)
  if (unit === 'minutes') return toIso(ms + n * 60_000)
  if (unit === 'seconds') return toIso(ms + n * 1000)
  if (unit === 'milliseconds') return toIso(ms + n)
  const p = zonedParts(ms, tz)
  const day = civilString(p.y, p.mo, p.d)
  const moved = unit === 'years' ? addMonths(day, n * 12) : unit === 'quarters' ? addMonths(day, n * 3) : unit === 'months' ? addMonths(day, n) : unit === 'weeks' ? addDays(day, n * 7) : addDays(day, n)
  return toIso(zonedToEpoch({ ...civilParts(moved, p.h, p.mi), s: p.s, ms: p.ms }, tz))
}

function dateAddImpl(d: DateValue, n: number, unit: Unit, cx: Ctx, node: Node): DateValue {
  if (d.kind === 'date') {
    if (unit === 'hours' || unit === 'minutes' || unit === 'seconds' || unit === 'milliseconds') return cx.err(node, 'FORMULA_DOMAIN', `${unit} need a date with a time`)
    const mv = (s: string) => (unit === 'years' ? addMonths(s, n * 12) : unit === 'quarters' ? addMonths(s, n * 3) : unit === 'months' ? addMonths(s, n) : unit === 'weeks' ? addDays(s, n * 7) : addDays(s, n))
    return { kind: 'date', start: mv(d.start), end: d.end === null ? null : mv(d.end) }
  }
  const tz = d.timeZone ?? cx.env.zone
  return { kind: 'datetime', start: shiftPoint(d.start, tz, n, unit), end: d.end === null ? null : shiftPoint(d.end, tz, n, unit), timeZone: d.timeZone }
}

/** First minus second, truncated toward zero, completed units only. */
function dateBetweenImpl(a: DateValue, b: DateValue, unit: Unit, zone: string): number {
  const startOf = (v: DateValue) => dateInterval(v, v.kind === 'datetime' ? (v.timeZone ?? zone) : zone).s
  const am = startOf(a)
  const bm = startOf(b)
  const diff = am - bm
  switch (unit) {
    case 'milliseconds': return diff
    case 'seconds': return Math.trunc(diff / 1000)
    case 'minutes': return Math.trunc(diff / 60_000)
    case 'hours': return Math.trunc(diff / 3_600_000)
    case 'days':
      if (a.kind === 'date' && b.kind === 'date') return diffDays(a.start, b.start)
      return Math.trunc(diff / 86_400_000)
    case 'weeks': {
      const days = a.kind === 'date' && b.kind === 'date' ? diffDays(a.start, b.start) : Math.trunc(diff / 86_400_000)
      return Math.trunc(days / 7)
    }
    case 'months':
    case 'quarters':
    case 'years': {
      const wall = (v: DateValue, ms: number) => {
        if (v.kind === 'date') return { day: v.start, tod: 0 }
        const z = v.timeZone ?? zone
        const p = zonedParts(ms, z)
        return { day: civilString(p.y, p.mo, p.d), tod: ((p.h * 60 + p.mi) * 60 + p.s) * 1000 + p.ms }
      }
      const x = wall(a, am)
      const y = wall(b, bm)
      const sign = diff < 0 ? -1 : 1
      const hi = sign > 0 ? x : y
      const lo = sign > 0 ? y : x
      const cmp = (p: { day: string; tod: number }, q: { day: string; tod: number }) => (p.day === q.day ? p.tod - q.tod : p.day < q.day ? -1 : 1)
      const pa = parseCivil(hi.day)
      const pb = parseCivil(lo.day)
      let m = (pa.y - pb.y) * 12 + (pa.m - pb.m)
      while (m > 0 && cmp({ day: addMonths(lo.day, m), tod: lo.tod }, hi) > 0) m--
      while (cmp({ day: addMonths(lo.day, m + 1), tod: lo.tod }, hi) <= 0) m++
      const per = unit === 'years' ? 12 : unit === 'quarters' ? 3 : 1
      return sign * Math.trunc(m / per)
    }
  }
}

const FORMAT_TOKENS = ['YYYY', 'YY', 'MMMM', 'MMM', 'MM', 'M', 'DD', 'D', 'dddd', 'ddd', 'HH', 'H', 'hh', 'h', 'mm', 'ss', 'A', 'a', 'ZZ', 'Z']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function formatDateImpl(d: DateValue, fmt: string, zone: string, cx: Ctx, node: Node): string {
  const z = d.kind === 'datetime' ? (d.timeZone ?? zone) : zone
  let day: string, h = 0, mi = 0, s = 0, offMin = 0
  if (d.kind === 'date') day = d.start
  else {
    const ms = parseIsoInstant(d.start, z)!
    const p = zonedParts(ms, z)
    day = civilString(p.y, p.mo, p.d)
    h = p.h; mi = p.mi; s = p.s
    offMin = Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000)
  }
  const { y, m, d: dd } = parseCivil(day)
  const wd = weekdayOf(day)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const sign = offMin < 0 ? '-' : '+'
  const abs = Math.abs(offMin)
  const out: string[] = []
  for (let i = 0; i < fmt.length; ) {
    if (fmt[i] === '[') {
      const end = fmt.indexOf(']', i)
      if (end < 0) return cx.err(node, 'FORMULA_DOMAIN', 'unterminated [escape] in date format')
      out.push(fmt.slice(i + 1, end))
      i = end + 1
      continue
    }
    if (/[A-Za-z]/.test(fmt[i])) {
      const tok = FORMAT_TOKENS.find((t) => fmt.startsWith(t, i))
      if (!tok) return cx.err(node, 'FORMULA_DOMAIN', `unsupported date format token "${fmt[i]}"`)
      i += tok.length
      switch (tok) {
        case 'YYYY': out.push(pad(y, 4)); break
        case 'YY': out.push(pad(y % 100)); break
        case 'MMMM': out.push(MONTHS[m - 1]); break
        case 'MMM': out.push(MONTHS[m - 1].slice(0, 3)); break
        case 'MM': out.push(pad(m)); break
        case 'M': out.push(String(m)); break
        case 'DD': out.push(pad(dd)); break
        case 'D': out.push(String(dd)); break
        case 'dddd': out.push(WEEKDAYS[wd - 1]); break
        case 'ddd': out.push(WEEKDAYS[wd - 1].slice(0, 3)); break
        case 'HH': out.push(pad(h)); break
        case 'H': out.push(String(h)); break
        case 'hh': out.push(pad(h % 12 === 0 ? 12 : h % 12)); break
        case 'h': out.push(String(h % 12 === 0 ? 12 : h % 12)); break
        case 'mm': out.push(pad(mi)); break
        case 'ss': out.push(pad(s)); break
        case 'A': out.push(h < 12 ? 'AM' : 'PM'); break
        case 'a': out.push(h < 12 ? 'am' : 'pm'); break
        case 'ZZ': out.push(`${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`); break
        case 'Z': out.push(`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`); break
      }
    } else out.push(fmt[i++])
  }
  return out.join('')
}

// ───── text helpers ─────

function mapRuns(runs: RichRun[], f: (s: string) => string): RichRun[] {
  return runs.map((r) => ({ ...r, text: f(r.text) }))
}

const STYLE_FLAGS: Record<string, keyof RichRun> = { bold: 'bold', b: 'bold', italic: 'italic', i: 'italic', underline: 'underline', u: 'underline', strike: 'strike', s: 'strike', code: 'code', c: 'code' }
function styleRuns(runs: RichRun[], tokens: string[], on: boolean, cx: Ctx, node: Node): RichRun[] {
  return runs.map((r) => {
    const out: RichRun = { ...r }
    for (const t of tokens) {
      const flag = STYLE_FLAGS[t]
      if (flag) {
        if (on) (out as Record<string, unknown>)[flag] = true
        else delete (out as Record<string, unknown>)[flag]
      } else if ((OPTION_COLORS as string[]).includes(t)) {
        if (on) out.color = t
        else if (out.color === t) delete out.color
      } else cx.err(node, 'FORMULA_DOMAIN', `unknown style "${t}"`)
    }
    return out
  })
}

// ───── the table ─────

const specs: FnSpec[] = []
function def(s: Omit<FnSpec, 'tests' | 'hidden'> & { tests?: string[]; hidden?: boolean }) {
  specs.push({ tests: [`fn:${s.name}`], ...s })
}

const num2 = (name: string, doc: string, f: (a: number, b: number) => number, domain?: (a: number, b: number) => string | null) =>
  def({
    name, min: 2, max: 2, params: ['Number', 'Number'], args: [T.num, T.num], propagateEmpty: true, returns: () => T.num, doc,
    impl: (a, cx, n) => {
      const x = needNum(a[0] as FormulaValue, cx, n, 'first operand')
      const y = needNum(a[1] as FormulaValue, cx, n, 'second operand')
      const why = domain?.(x, y)
      if (why) return cx.err(n, 'FORMULA_DOMAIN', why)
      return finite(f(x, y), cx, n)
    },
  })

// control flow
def({
  name: 'if', min: 3, max: 3, params: ['Boolean', 'Any', 'Any'], lazy: { at: [0, 1, 2] }, returns: (t) => sameOr(t[1], t[2]), doc: 'if(condition, then, else): only the chosen branch is evaluated.',
  impl: (a, cx) => (needBool(cx.eval(a[0] as Node, cx.scope), cx, a[0] as Node, 'condition') ? cx.eval(a[1] as Node, cx.scope) : cx.eval(a[2] as Node, cx.scope)),
})
def({
  name: 'ifs', min: 2, max: Infinity, params: ['Boolean', 'Any', '…', 'Any?'], lazy: { from: 0 }, returns: (t) => t.filter((_, i) => i % 2 === 1).reduce((acc, x) => (acc === '' ? x : sameOr(acc, x)), '') || 'any',
  doc: 'ifs(c1, v1, c2, v2, …, default?): first true condition wins; no match and no default gives Empty.',
  impl: (a, cx) => {
    const nodes = a as Node[]
    let i = 0
    for (; i + 1 < nodes.length; i += 2) if (needBool(cx.eval(nodes[i], cx.scope), cx, nodes[i], 'condition')) return cx.eval(nodes[i + 1], cx.scope)
    return nodes.length % 2 === 1 ? cx.eval(nodes[nodes.length - 1], cx.scope) : EMPTY_V
  },
})
def({
  name: 'and', min: 2, max: 2, params: ['Boolean', 'Boolean'], lazy: { at: [0, 1] }, args: [T.bool, T.bool], returns: () => T.bool, doc: 'Lazy logical and (Boolean only).',
  impl: (a, cx) => boolV(needBool(cx.eval(a[0] as Node, cx.scope), cx, a[0] as Node) && needBool(cx.eval(a[1] as Node, cx.scope), cx, a[1] as Node)),
})
def({
  name: 'or', min: 2, max: 2, params: ['Boolean', 'Boolean'], lazy: { at: [0, 1] }, args: [T.bool, T.bool], returns: () => T.bool, doc: 'Lazy logical or (Boolean only).',
  impl: (a, cx) => boolV(needBool(cx.eval(a[0] as Node, cx.scope), cx, a[0] as Node) || needBool(cx.eval(a[1] as Node, cx.scope), cx, a[1] as Node)),
})
def({ name: 'not', min: 1, max: 1, params: ['Boolean'], args: [T.bool], returns: () => T.bool, doc: 'Logical not (Boolean only).', impl: (a, cx, n) => boolV(!needBool(a[0] as FormulaValue, cx, n)) })
def({
  name: 'empty', min: 0, max: 1, params: ['Any?'], returns: () => T.bool,
  doc: 'Empty, 0, false, empty text and empty list are empty; whitespace-only text is not. (Different from filters, where 0 and false are not empty.)',
  impl: (a) => boolV(a.length === 0 ? true : formulaEmpty(a[0] as FormulaValue)),
})
def({ name: 'equal', min: 2, max: 2, params: ['Any', 'Any'], returns: () => T.bool, doc: 'Typed equality (also ==).', impl: (a, cx) => boolV(valuesEqual(a[0] as FormulaValue, a[1] as FormulaValue, cx.env.zone)) })
def({ name: 'unequal', min: 2, max: 2, params: ['Any', 'Any'], returns: () => T.bool, doc: 'Typed inequality (also !=).', impl: (a, cx) => boolV(!valuesEqual(a[0] as FormulaValue, a[1] as FormulaValue, cx.env.zone)) })
def({
  name: 'let', min: 3, max: 3, params: ['name', 'Any', 'body'], lazy: { at: [0, 1, 2] }, returns: (t) => t[2], doc: 'let(name, value, body): lexical binding visible in body.',
  impl: (a, cx, n) => {
    const nameNode = a[0] as Node
    if (nameNode.t !== 'ident') return cx.err(n, 'FORMULA_SYNTAX', 'the first argument of let must be a name')
    const sc = newScope(cx.scope)
    sc.vars.set(nameNode.name, cx.eval(a[1] as Node, cx.scope))
    return cx.eval(a[2] as Node, sc)
  },
})
def({
  name: 'lets', min: 3, max: Infinity, params: ['name', 'Any', '…', 'body'], lazy: { from: 0 }, returns: (t) => t[t.length - 1] ?? 'any',
  doc: 'lets(a, 1, b, a + 1, body): sequential lexical bindings; later bindings see earlier ones.',
  impl: (a, cx, n) => {
    const nodes = a as Node[]
    if (nodes.length % 2 === 0) return cx.err(n, 'FORMULA_ARITY', 'lets needs name/value pairs followed by a body')
    let sc = cx.scope
    for (let i = 0; i + 1 < nodes.length; i += 2) {
      const nm = nodes[i]
      if (nm.t !== 'ident') return cx.err(nm, 'FORMULA_SYNTAX', 'binding name expected')
      const next = newScope(sc)
      next.vars.set(nm.name, cx.eval(nodes[i + 1], sc))
      sc = next
    }
    return cx.eval(nodes[nodes.length - 1], sc)
  },
})
def({
  name: 'prop', min: 1, max: 1, params: ['name'], returns: () => T.any, doc: 'prop("Name"): value of a property of the current page (bound to its id at compile time, so renames keep working); page.prop("Name") reads another page.',
  impl: (_a, cx, n) => cx.err(n, 'FORMULA_SYNTAX', 'prop() needs a literal property name'),
})
def({ name: 'id', min: 0, max: 1, params: ['Page?'], returns: () => T.txt, doc: 'Id of the current page, or of the given page. Cannot enumerate inaccessible pages.', impl: (a, cx, n) => {
  if (!a.length) return textV(cx.env.currentPageId)
  const p = a[0] as FormulaValue
  if (p.kind !== 'page') return cx.err(n, 'FORMULA_TYPE', 'id() needs a Page')
  return textV(p.id)
} })

// text
def({
  name: 'length', min: 1, max: 1, params: ['Text|List'], args: ['text|list'], returns: () => T.num, doc: 'Unicode code points of a Text, or the number of items of a List.',
  impl: (a, cx, n) => {
    const v = a[0] as FormulaValue
    if (v.kind === 'text') return numV(cps(plain(v)).length)
    if (v.kind === 'list') return numV(v.items.length)
    if (v.kind === 'empty') return numV(0)
    return cx.err(n, 'FORMULA_TYPE', `length needs Text or List, got ${typeName(v)}`)
  },
})
def({
  name: 'substring', min: 2, max: 3, params: ['Text', 'Number', 'Number?'], args: [T.txt, T.num, T.num], propagateEmpty: true, returns: () => T.txt,
  doc: 'Zero-based start (inclusive), end (exclusive); negative offsets count from the end; clamped.',
  impl: (a, cx, n) => {
    const chars = cps(needText(a[0] as FormulaValue, cx, n))
    const cl = (i: number) => Math.max(0, Math.min(chars.length, i < 0 ? chars.length + i : i))
    const s = cl(needInt(a[1] as FormulaValue, cx, n, 'start'))
    const e = a[2] ? cl(needInt(a[2] as FormulaValue, cx, n, 'end')) : chars.length
    return textV(chars.slice(s, Math.max(s, e)).join(''))
  },
})
def({
  name: 'contains', min: 2, max: 2, params: ['Text', 'Text'], args: [T.txt, T.txt], returns: () => T.bool, doc: 'Text substring test (case-sensitive).',
  impl: (a, cx, n) => boolV(needText(a[0] as FormulaValue, cx, n).includes(needText(a[1] as FormulaValue, cx, n))),
})
def({
  name: 'test', min: 2, max: 2, params: ['Text', 'Pattern'], args: [T.txt, T.txt], returns: () => T.bool, doc: 'True if the bounded Unicode pattern matches anywhere (no backreferences / lookbehind / nested repetition).',
  impl: (a, cx, n) => boolV(safeRegex(needText(a[1] as FormulaValue, cx, n, 'pattern'), '', cx, n).test(subject(needText(a[0] as FormulaValue, cx, n), cx, n))),
})
def({
  name: 'match', min: 2, max: 2, params: ['Text', 'Pattern'], args: [T.txt, T.txt], returns: () => listOf(T.txt), doc: 'List of all full matches; no match gives [].',
  impl: (a, cx, n) => {
    const re = safeRegex(needText(a[1] as FormulaValue, cx, n, 'pattern'), 'g', cx, n)
    const out: FormulaValue[] = []
    for (const m of subject(needText(a[0] as FormulaValue, cx, n), cx, n).matchAll(re)) {
      out.push(textV(m[0]))
      checkList(out.length, cx, n)
      if (m[0] === '') re.lastIndex++
    }
    return listV(out)
  },
})
def({
  name: 'replace', min: 3, max: 3, params: ['Text', 'Pattern', 'Text'], args: [T.txt, T.txt, T.txt], returns: () => T.txt, doc: 'Replace the first match.',
  impl: (a, cx, n) => textV(subject(needText(a[0] as FormulaValue, cx, n), cx, n).replace(safeRegex(needText(a[1] as FormulaValue, cx, n, 'pattern'), '', cx, n), needText(a[2] as FormulaValue, cx, n, 'replacement'))),
})
def({
  name: 'replaceAll', min: 3, max: 3, params: ['Text', 'Pattern', 'Text'], args: [T.txt, T.txt, T.txt], returns: () => T.txt, doc: 'Replace every match.',
  impl: (a, cx, n) => {
    const out = subject(needText(a[0] as FormulaValue, cx, n), cx, n).replace(safeRegex(needText(a[1] as FormulaValue, cx, n, 'pattern'), 'g', cx, n), needText(a[2] as FormulaValue, cx, n, 'replacement'))
    checkText(out.length, cx, n)
    return textV(out)
  },
})
def({ name: 'lower', min: 1, max: 1, params: ['Text'], args: [T.txt], propagateEmpty: true, returns: () => T.txt, doc: 'Unicode lower case (styles kept).', impl: (a, cx, n) => {
  const v = a[0] as FormulaValue
  needText(v, cx, n)
  return runsV(mapRuns((v as { runs: RichRun[] }).runs, (s) => s.toLowerCase()))
} })
def({ name: 'upper', min: 1, max: 1, params: ['Text'], args: [T.txt], propagateEmpty: true, returns: () => T.txt, doc: 'Unicode upper case (styles kept).', impl: (a, cx, n) => {
  const v = a[0] as FormulaValue
  needText(v, cx, n)
  return runsV(mapRuns((v as { runs: RichRun[] }).runs, (s) => s.toUpperCase()))
} })
def({ name: 'trim', min: 1, max: 1, params: ['Text'], args: [T.txt], propagateEmpty: true, returns: () => T.txt, doc: 'Trim surrounding whitespace.', impl: (a, cx, n) => {
  const v = a[0] as FormulaValue
  needText(v, cx, n)
  const runs = (v as { runs: RichRun[] }).runs.map((r) => ({ ...r }))
  while (runs.length && runs[0].text.trimStart() === '') runs.shift()
  while (runs.length && runs[runs.length - 1].text.trimEnd() === '') runs.pop()
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart()
    runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd()
  }
  return runsV(runs)
} })
def({
  name: 'repeat', min: 2, max: 2, params: ['Text', 'Number'], args: [T.txt, T.num], propagateEmpty: true, returns: () => T.txt, doc: 'Repeat a Text a non-negative whole number of times (result at most 1 MB).',
  impl: (a, cx, n) => {
    const s = needText(a[0] as FormulaValue, cx, n)
    const k = needInt(a[1] as FormulaValue, cx, n, 'count')
    if (k < 0) return cx.err(n, 'FORMULA_DOMAIN', 'count must not be negative')
    checkText(s.length * k, cx, n)
    return textV(s.repeat(k))
  },
})
def({
  name: 'split', min: 2, max: 2, params: ['Text', 'Text'], args: [T.txt, T.txt], propagateEmpty: true, returns: () => listOf(T.txt), doc: 'Split by a separator; an empty separator splits into characters.',
  impl: (a, cx, n) => {
    const s = needText(a[0] as FormulaValue, cx, n)
    const sep = needText(a[1] as FormulaValue, cx, n, 'separator')
    const parts = sep === '' ? cps(s) : s.split(sep)
    checkList(parts.length, cx, n)
    return listV(parts.map(textV))
  },
})
def({
  name: 'join', min: 2, max: 2, params: ['List', 'Text'], args: [T.any, T.txt], returns: () => T.txt, doc: 'Join the display text of the items with a separator.',
  impl: (a, cx, n) => {
    const items = needList(a[0] as FormulaValue, cx, n)
    const sep = needText(a[1] as FormulaValue, cx, n, 'separator')
    const out = items.map((i) => formatValue(i, cx.env.pageTitle, (id) => cx.env.person(id)?.name ?? '')).join(sep)
    checkText(out.length, cx, n)
    return textV(out)
  },
})
def({
  name: 'link', min: 2, max: 2, params: ['Text', 'Text'], args: [T.txt, T.txt], returns: () => T.txt, doc: 'Styled link (http, https, mailto, tel only). Never opens the URL.',
  impl: (a, cx, n) => {
    const label = needText(a[0] as FormulaValue, cx, n, 'label')
    const url = needText(a[1] as FormulaValue, cx, n, 'url')
    if (!isSafeUrl(url)) return cx.err(n, 'FORMULA_DOMAIN', 'link scheme is not allowed')
    return runsV([{ text: label, href: url }])
  },
})
def({
  name: 'style', min: 1, max: Infinity, params: ['Text', 'Style…'], args: [T.txt, T.txt], returns: () => T.txt, doc: 'Apply bold / italic / underline / strike / code or a palette color.',
  impl: (a, cx, n) => {
    const v = a[0] as FormulaValue
    needText(v, cx, n)
    const tokens = a.slice(1).map((t) => needText(t as FormulaValue, cx, n, 'style'))
    return runsV(styleRuns((v as { runs: RichRun[] }).runs, tokens, true, cx, n))
  },
})
def({
  name: 'unstyle', min: 1, max: Infinity, params: ['Text', 'Style…'], args: [T.txt, T.txt], returns: () => T.txt, doc: 'Remove the given styles, or all styles when none are named.',
  impl: (a, cx, n) => {
    const v = a[0] as FormulaValue
    needText(v, cx, n)
    const runs = (v as { runs: RichRun[] }).runs
    if (a.length === 1) return textV(runsToText(runs))
    return runsV(styleRuns(runs, a.slice(1).map((t) => needText(t as FormulaValue, cx, n, 'style')), false, cx, n))
  },
})
def({
  name: 'format', min: 1, max: 1, params: ['Any'], returns: () => T.txt, doc: 'Display text of any value: Empty → "", shortest decimal for numbers, ISO dates, page titles, comma-joined lists.',
  impl: (a, cx) => textV(formatValue(a[0] as FormulaValue, cx.env.pageTitle, (id) => cx.env.person(id)?.name ?? '')),
})

// math
def({
  name: 'add', min: 2, max: 2, params: ['Number|Text', 'Number|Text'], args: ['number|text', 'number|text'], propagateEmpty: true,
  returns: (t) => (t[0] === T.txt && t[1] === T.txt ? T.txt : T.num), doc: 'Add two Numbers, or concatenate two Texts. Also +. Text + Number is a type error.',
  impl: (a, cx, n) => {
    const x = a[0] as FormulaValue
    const y = a[1] as FormulaValue
    if (x.kind === 'text' && y.kind === 'text') {
      const r = runsV([...x.runs, ...y.runs])
      checkText(plain(r).length, cx, n)
      return r
    }
    return finite(needNum(x, cx, n, 'first operand') + needNum(y, cx, n, 'second operand'), cx, n)
  },
})
num2('subtract', 'Subtract. Also -.', (x, y) => x - y)
num2('multiply', 'Multiply. Also *.', (x, y) => x * y)
num2('divide', 'Divide. Division by zero is an error (never 0 or Infinity). Also /.', (x, y) => x / y, (_x, y) => (y === 0 ? 'division by zero' : null))
num2('mod', 'Remainder (sign of the dividend). Also %.', (x, y) => x % y, (_x, y) => (y === 0 ? 'modulo by zero' : null))
num2('pow', 'Power. A non-finite or complex result is a domain error. Also ^.', (x, y) => Math.pow(x, y), (x, y) => (x < 0 && !Number.isInteger(y) ? 'result is not a real number' : null))

const numList = (a: Arg[], cx: Ctx, n: Node): number[] => {
  const out: number[] = []
  for (const x of a as FormulaValue[]) {
    const items = x.kind === 'list' ? x.items : [x]
    for (const v of items) {
      if (v.kind === 'empty') continue
      if (v.kind !== 'number') cx.err(n, 'FORMULA_TYPE', `expected Numbers, got ${typeName(v)}`)
      out.push((v as { value: number }).value)
    }
  }
  return out
}
const vari = (name: string, doc: string, f: (xs: number[]) => number | null) =>
  def({
    name, min: 1, max: Infinity, params: ['Number|List<Number>', '…'], args: ['number|list'], returns: () => T.num, doc,
    impl: (a, cx, n) => {
      const r = f(numList(a, cx, n))
      return r === null ? EMPTY_V : finite(r, cx, n)
    },
  })
vari('min', 'Smallest of the numbers (lists flatten one level; Empty is skipped); none gives Empty.', (xs) => (xs.length ? Math.min(...xs) : null))
vari('max', 'Largest of the numbers; none gives Empty.', (xs) => (xs.length ? Math.max(...xs) : null))
vari('sum', 'Sum of the numbers; sum of nothing is 0.', (xs) => xs.reduce((p, c) => p + c, 0))
vari('mean', 'Average; none gives Empty.', (xs) => (xs.length ? xs.reduce((p, c) => p + c, 0) / xs.length : null))
vari('median', 'Median (mean of the middle pair for an even count); none gives Empty.', (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((p, q) => p - q)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
})

const num1 = (name: string, doc: string, f: (x: number) => number, domain?: (x: number) => string | null) =>
  def({
    name, min: 1, max: 1, params: ['Number'], args: [T.num], propagateEmpty: true, returns: () => T.num, doc,
    impl: (a, cx, n) => {
      const x = needNum(a[0] as FormulaValue, cx, n)
      const why = domain?.(x)
      if (why) return cx.err(n, 'FORMULA_DOMAIN', why)
      return finite(f(x), cx, n)
    },
  })
num1('abs', 'Absolute value.', Math.abs)
num1('ceil', 'Round up to a whole number.', Math.ceil)
num1('floor', 'Round down to a whole number.', Math.floor)
num1('sqrt', 'Square root (negative is a domain error).', Math.sqrt, (x) => (x < 0 ? 'square root of a negative number' : null))
num1('cbrt', 'Cube root.', Math.cbrt)
num1('exp', 'e raised to the power.', Math.exp)
num1('ln', 'Natural logarithm (x must be > 0).', Math.log, (x) => (x <= 0 ? 'logarithm of a non-positive number' : null))
num1('log10', 'Base-10 logarithm (x must be > 0).', Math.log10, (x) => (x <= 0 ? 'logarithm of a non-positive number' : null))
num1('log2', 'Base-2 logarithm (x must be > 0).', Math.log2, (x) => (x <= 0 ? 'logarithm of a non-positive number' : null))
num1('sign', '-1, 0 or 1.', (x) => (x > 0 ? 1 : x < 0 ? -1 : 0))
def({
  name: 'round', min: 1, max: 2, params: ['Number', 'Number?'], args: [T.num, T.num], propagateEmpty: true, returns: () => T.num,
  doc: 'Round to a whole number or to N decimal places [-12, 12]; ties go toward +infinity (round(-2.5) = -2). Uses the shortest decimal, so round(1.005, 2) = 1.01.',
  impl: (a, cx, n) => {
    const x = needNum(a[0] as FormulaValue, cx, n)
    const places = a[1] ? needInt(a[1] as FormulaValue, cx, n, 'places') : 0
    if (places < -12 || places > 12) return cx.err(n, 'FORMULA_DOMAIN', 'places must be within -12..12')
    return finite(roundDecimal(x, places), cx, n)
  },
})
def({ name: 'pi', min: 0, max: 0, params: [], returns: () => T.num, doc: 'The constant π.', impl: () => numV(Math.PI) })
def({ name: 'e', min: 0, max: 0, params: [], returns: () => T.num, doc: 'The constant e.', impl: () => numV(Math.E) })
def({
  name: 'toNumber', min: 1, max: 1, params: ['Any'], returns: () => T.num,
  doc: 'Number → itself, Boolean → 0/1, strict numeric Text, Date → epoch milliseconds, Empty → Empty. No partial parsing.',
  impl: (a, cx, n) => {
    const v = a[0] as FormulaValue
    switch (v.kind) {
      case 'empty': return EMPTY_V
      case 'number': return v
      case 'boolean': return numV(v.value ? 1 : 0)
      case 'text': {
        const x = parseStrictNumber(plain(v))
        if (x === null) return cx.err(n, 'FORMULA_DOMAIN', `"${plain(v)}" is not a number`)
        return numV(x)
      }
      case 'date': return numV(dateInterval(v.value, cx.env.zone).s)
      default: return cx.err(n, 'FORMULA_TYPE', `cannot convert ${typeName(v)} to a Number`)
    }
  },
})
def({
  name: 'formatNumber', min: 1, max: 3, params: ['Number', 'Format?', 'Number?'], args: [T.num, T.txt, T.num], propagateEmpty: true, returns: () => T.txt,
  doc: 'Format a Number as Text: "plain", "grouped", "percent" or a 3-letter currency code; optional decimal places. Does not change the stored value.',
  impl: (a, cx, n) => {
    const x = needNum(a[0] as FormulaValue, cx, n)
    const f = a[1] ? needText(a[1] as FormulaValue, cx, n, 'format') : 'plain'
    const places = a[2] ? needInt(a[2] as FormulaValue, cx, n, 'decimal places') : undefined
    if (!['plain', 'grouped', 'percent'].includes(f) && !/^[A-Z]{3}$/.test(f)) return cx.err(n, 'FORMULA_DOMAIN', `unknown number format "${f}"`)
    let cfg
    try {
      cfg = /^[A-Z]{3}$/.test(f) ? numberConfig({ format: 'currency', currencyCode: f, precision: places ?? 2 }) : numberConfig({ format: f, precision: places ?? (f === 'plain' ? 0 : 0) })
    } catch (e) {
      return cx.err(n, 'FORMULA_DOMAIN', (e as Error).message)
    }
    if (f === 'plain' && places === undefined) return textV(formatValue(numV(x)))
    return textV(formatNumber(x, cfg, 'en-US'))
  },
})

// dates
def({ name: 'now', min: 0, max: 0, params: [], returns: () => T.date, doc: 'Current instant from the injected clock (refreshes each minute).', impl: (_a, cx) => dateV({ kind: 'datetime', start: toIso(cx.env.nowMs), end: null, timeZone: cx.env.zone }) })
def({ name: 'today', min: 0, max: 0, params: [], returns: () => T.date, doc: 'Today as an all-day date in the evaluation zone (refreshes at local midnight).', impl: (_a, cx) => dateV({ kind: 'date', start: civilOf(cx.env.nowMs, cx.env.zone), end: null }) })
const part = (name: string, doc: string, f: (d: DateValue, zone: string) => number) =>
  def({ name, min: 1, max: 1, params: ['Date'], args: [T.date], propagateEmpty: true, returns: () => T.num, doc, impl: (a, cx, n) => numV(f(needDate(a[0] as FormulaValue, cx, n), cx.env.zone)) })
const wallOf = (d: DateValue, zone: string) => {
  if (d.kind === 'date') return { day: d.start, h: 0, mi: 0 }
  const z = d.timeZone ?? zone
  const p = zonedParts(parseIsoInstant(d.start, z)!, z)
  return { day: civilString(p.y, p.mo, p.d), h: p.h, mi: p.mi }
}
part('minute', 'Minute of the hour in the date\'s zone (0 for all-day dates).', (d, z) => wallOf(d, z).mi)
part('hour', 'Hour of the day 0-23 (0 for all-day dates).', (d, z) => wallOf(d, z).h)
part('day', 'Weekday, Monday = 1 … Sunday = 7.', (d, z) => weekdayOf(wallOf(d, z).day))
part('date', 'Day of the month.', (d, z) => parseCivil(wallOf(d, z).day).d)
part('week', 'ISO week number.', (d, z) => isoWeek(wallOf(d, z).day).week)
part('month', 'Month 1-12.', (d, z) => parseCivil(wallOf(d, z).day).m)
part('year', 'Year.', (d, z) => parseCivil(wallOf(d, z).day).y)
def({
  name: 'dateAdd', min: 3, max: 3, params: ['Date', 'Number', 'Unit'], args: [T.date, T.num, T.txt], propagateEmpty: true, returns: () => T.date,
  doc: 'Add whole units (years, quarters, months, weeks, days, hours, minutes, seconds). Calendar units clamp to month end; the interval end moves with the start.',
  impl: (a, cx, n) => dateV(normalizeDate(dateAddImpl(needDate(a[0] as FormulaValue, cx, n), needInt(a[1] as FormulaValue, cx, n, 'amount'), unitOf(a[2] as FormulaValue, cx, n), cx, n))),
})
def({
  name: 'dateSubtract', min: 3, max: 3, params: ['Date', 'Number', 'Unit'], args: [T.date, T.num, T.txt], propagateEmpty: true, returns: () => T.date, doc: 'Subtract whole units (see dateAdd).',
  impl: (a, cx, n) => dateV(normalizeDate(dateAddImpl(needDate(a[0] as FormulaValue, cx, n), -needInt(a[1] as FormulaValue, cx, n, 'amount'), unitOf(a[2] as FormulaValue, cx, n), cx, n))),
})
def({
  name: 'dateBetween', min: 3, max: 3, params: ['Date', 'Date', 'Unit'], args: [T.date, T.date, T.txt], propagateEmpty: true, returns: () => T.num,
  doc: 'First minus second, in completed units, truncated toward zero. Months/years use calendar arithmetic; weeks are completed days / 7.',
  impl: (a, cx, n) => numV(dateBetweenImpl(needDate(a[0] as FormulaValue, cx, n), needDate(a[1] as FormulaValue, cx, n), unitOf(a[2] as FormulaValue, cx, n), cx.env.zone)),
})
def({
  name: 'dateRange', min: 2, max: 2, params: ['Date', 'Date'], args: [T.date, T.date], propagateEmpty: true, returns: () => T.date, doc: 'Interval from the start of the first to the end of the second; both must be all-day or both timed; an inverted interval is an error.',
  impl: (a, cx, n) => {
    const x = needDate(a[0] as FormulaValue, cx, n)
    const y = needDate(a[1] as FormulaValue, cx, n)
    if (x.kind !== y.kind) return cx.err(n, 'FORMULA_TYPE', 'dateRange needs two all-day dates or two timed dates')
    const end = y.end ?? y.start
    try {
      return dateV(normalizeDate(x.kind === 'date' ? { kind: 'date', start: x.start, end: end === x.start ? null : end } : { kind: 'datetime', start: x.start, end, timeZone: x.timeZone }))
    } catch {
      return cx.err(n, 'FORMULA_DOMAIN', 'the range end is before its start')
    }
  },
})
def({
  name: 'dateStart', min: 1, max: 1, params: ['Date'], args: [T.date], propagateEmpty: true, returns: () => T.date, doc: 'The start of a date or range.',
  impl: (a, cx, n) => { const d = needDate(a[0] as FormulaValue, cx, n); return dateV({ ...d, end: null } as DateValue) },
})
def({
  name: 'dateEnd', min: 1, max: 1, params: ['Date'], args: [T.date], propagateEmpty: true, returns: () => T.date, doc: 'The end of a range (the start when there is no end).',
  impl: (a, cx, n) => { const d = needDate(a[0] as FormulaValue, cx, n); return dateV({ ...d, start: d.end ?? d.start, end: null } as DateValue) },
})
def({
  name: 'timestamp', min: 1, max: 1, params: ['Date'], args: [T.date], propagateEmpty: true, returns: () => T.num, doc: 'Epoch milliseconds of the start (all-day dates use local midnight).',
  impl: (a, cx, n) => numV(dateInterval(needDate(a[0] as FormulaValue, cx, n), cx.env.zone).s),
})
def({
  name: 'fromTimestamp', min: 1, max: 1, params: ['Number'], args: [T.num], propagateEmpty: true, returns: () => T.date, doc: 'Instant from epoch milliseconds, truncated to the minute.',
  impl: (a, cx, n) => dateV({ kind: 'datetime', start: toIso(Math.floor(needNum(a[0] as FormulaValue, cx, n) / 60000) * 60000), end: null, timeZone: cx.env.zone }),
})
def({
  name: 'parseDate', min: 1, max: 1, params: ['Text'], args: [T.txt], propagateEmpty: true, returns: () => T.date, doc: 'Strict ISO date or date-time; a time without offset uses the evaluation zone.',
  impl: (a, cx, n) => {
    const s = needText(a[0] as FormulaValue, cx, n).trim()
    if (isCivil(s)) return dateV({ kind: 'date', start: s, end: null })
    const ms = parseIsoInstant(s, cx.env.zone)
    if (ms === null) return cx.err(n, 'FORMULA_DOMAIN', `"${s}" is not an ISO date`)
    return dateV({ kind: 'datetime', start: toIso(ms), end: null, timeZone: /Z|[+-]\d{2}:?\d{2}$/.test(s) ? null : cx.env.zone })
  },
})
def({
  name: 'formatDate', min: 2, max: 2, params: ['Date', 'Format'], args: [T.date, T.txt], propagateEmpty: true, returns: () => T.txt,
  doc: 'Tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A a Z ZZ; [text] escapes. Unknown letters are an error.',
  impl: (a, cx, n) => textV(formatDateImpl(needDate(a[0] as FormulaValue, cx, n), needText(a[1] as FormulaValue, cx, n, 'format'), cx.env.zone, cx, n)),
})

// people
def({
  name: 'name', min: 1, max: 1, params: ['Person'], args: [T.person], propagateEmpty: true, returns: () => T.txt, doc: 'Display name of a person (permission-aware).',
  impl: (a, cx, n) => { const v = a[0] as FormulaValue; if (v.kind !== 'person') return cx.err(n, 'FORMULA_TYPE', 'name() needs a Person'); return textV(cx.env.person(v.id)?.name ?? '') },
})
def({
  name: 'email', min: 1, max: 1, params: ['Person'], args: [T.person], propagateEmpty: true, returns: () => T.txt, doc: 'Email of a person; unavailable gives Empty.',
  impl: (a, cx, n) => { const v = a[0] as FormulaValue; if (v.kind !== 'person') return cx.err(n, 'FORMULA_TYPE', 'email() needs a Person'); const e = cx.env.person(v.id)?.email; return e ? textV(e) : EMPTY_V },
})

// lists
const idx = (i: number, len: number) => (i < 0 ? len + i : i)
def({ name: 'at', min: 2, max: 2, params: ['List', 'Number'], args: [T.any, T.num], returns: (t) => elemType(t[0]), doc: 'Item at an index; negative counts from the end; missing gives Empty.', impl: (a, cx, n) => {
  const l = needList(a[0] as FormulaValue, cx, n)
  const i = idx(needInt(a[1] as FormulaValue, cx, n, 'index'), l.length)
  return l[i] ?? EMPTY_V
} })
def({ name: 'first', min: 1, max: 1, params: ['List'], args: [T.any], returns: (t) => elemType(t[0]), doc: 'First item or Empty.', impl: (a, cx, n) => needList(a[0] as FormulaValue, cx, n)[0] ?? EMPTY_V })
def({ name: 'last', min: 1, max: 1, params: ['List'], args: [T.any], returns: (t) => elemType(t[0]), doc: 'Last item or Empty.', impl: (a, cx, n) => { const l = needList(a[0] as FormulaValue, cx, n); return l[l.length - 1] ?? EMPTY_V } })
def({
  name: 'slice', min: 2, max: 3, params: ['List', 'Number', 'Number?'], args: [T.any, T.num, T.num], returns: (t) => t[0], doc: 'Sub-list; zero-based start inclusive, end exclusive, negative from the end, clamped.',
  impl: (a, cx, n) => {
    const l = needList(a[0] as FormulaValue, cx, n)
    const cl = (i: number) => Math.max(0, Math.min(l.length, idx(i, l.length)))
    const s = cl(needInt(a[1] as FormulaValue, cx, n, 'start'))
    const e = a[2] ? cl(needInt(a[2] as FormulaValue, cx, n, 'end')) : l.length
    return listV(l.slice(s, Math.max(s, e)))
  },
})
def({ name: 'concat', min: 1, max: Infinity, params: ['List', '…'], args: [T.any], returns: (t) => t.reduce((acc, x) => sameOr(acc, x)), doc: 'Concatenate lists in order.', impl: (a, cx, n) => {
  const out = (a as FormulaValue[]).flatMap((x) => needList(x, cx, n))
  checkList(out.length, cx, n)
  return listV(out)
} })
def({ name: 'reverse', min: 1, max: 1, params: ['List'], args: [T.any], returns: (t) => t[0], doc: 'Reversed copy.', impl: (a, cx, n) => listV([...needList(a[0] as FormulaValue, cx, n)].reverse()) })
def({ name: 'unique', min: 1, max: 1, params: ['List'], args: [T.any], returns: (t) => t[0], doc: 'Remove duplicates by typed equality, keeping first occurrences.', impl: (a, cx, n) => {
  const out: FormulaValue[] = []
  for (const v of needList(a[0] as FormulaValue, cx, n)) if (!out.some((o) => valuesEqual(o, v, cx.env.zone))) out.push(v)
  return listV(out)
} })
def({ name: 'flat', min: 1, max: 1, params: ['List'], args: [T.any], returns: (t) => listOf(elemType(elemType(t[0]))), doc: 'Flatten one level.', impl: (a, cx, n) => {
  const out = needList(a[0] as FormulaValue, cx, n).flatMap((i) => (i.kind === 'list' ? i.items : [i]))
  checkList(out.length, cx, n)
  return listV(out)
} })
def({
  name: 'includes', min: 2, max: 2, params: ['List', 'Any'], args: [T.any, T.any], returns: () => T.bool, doc: 'True if the list contains the value (typed equality).',
  impl: (a, cx, n) => boolV(needList(a[0] as FormulaValue, cx, n).some((v) => valuesEqual(v, a[1] as FormulaValue, cx.env.zone))),
})
def({
  name: 'sort', min: 1, max: 2, params: ['List', 'Key?'], args: [T.any], lazy: { at: [1] }, returns: (t) => t[0],
  doc: 'Stable sort by the items themselves or by a key expression using current / index. Empty keys sort last; incomparable types are an error.',
  impl: (a, cx, n) => {
    const l = needList(a[0] as FormulaValue, cx, n)
    const keyed = l.map((v, i) => ({ v, i, k: a[1] ? withElem(cx, a[1] as Node, v, i) : v }))
    const titleOf = (id: Id) => cx.env.pageTitle(id) ?? id
    keyed.sort((x, y) => {
      if (x.k.kind === 'empty' || y.k.kind === 'empty') return x.k.kind === y.k.kind ? x.i - y.i : x.k.kind === 'empty' ? 1 : -1
      const c = compareValues(x.k, y.k, cx.env.zone, titleOf)
      if (c === null) return cx.err(n, 'FORMULA_TYPE', 'sort keys must be of one comparable type')
      return c || x.i - y.i
    })
    return listV(keyed.map((e) => e.v))
  },
})
const lazyList = (name: string, doc: string, ret: (t: string[]) => string, run: (l: FormulaValue[], test: (v: FormulaValue, i: number) => FormulaValue, cx: Ctx, n: Node) => FormulaValue) =>
  def({
    name, min: 2, max: 2, params: ['List', 'Expression'], args: [T.any], lazy: { at: [1] }, returns: ret, doc,
    impl: (a, cx, n) => {
      const l = needList(a[0] as FormulaValue, cx, n)
      return run(l, (v, i) => withElem(cx, a[1] as Node, v, i), cx, n)
    },
  })
lazyList('map', 'Evaluate the expression for every item (current, index) and collect the results.', () => listOf('any'), (l, f, cx, n) => {
  const out = l.map((v, i) => f(v, i))
  checkList(out.length, cx, n)
  return listV(out)
})
lazyList('filter', 'Keep the items for which the expression is true.', (t) => t[0], (l, f, cx, n) => listV(l.filter((v, i) => needBool(f(v, i), cx, n, 'filter condition'))))
lazyList('find', 'First item for which the expression is true, or Empty.', (t) => elemType(t[0]), (l, f, cx, n) => l.find((v, i) => needBool(f(v, i), cx, n, 'find condition')) ?? EMPTY_V)
lazyList('findIndex', 'Index of the first match, or -1.', () => T.num, (l, f, cx, n) => numV(l.findIndex((v, i) => needBool(f(v, i), cx, n, 'findIndex condition'))))
lazyList('some', 'True if any item matches (false for an empty list).', () => T.bool, (l, f, cx, n) => boolV(l.some((v, i) => needBool(f(v, i), cx, n, 'some condition'))))
lazyList('every', 'True if every item matches (true for an empty list).', () => T.bool, (l, f, cx, n) => boolV(l.every((v, i) => needBool(f(v, i), cx, n, 'every condition'))))

// operator-only comparison helpers (not part of the public name list)
const cmp = (name: string, test: (c: number) => boolean) =>
  def({
    name, min: 2, max: 2, params: ['Any', 'Any'], returns: () => T.bool, hidden: true, doc: `Comparison operator ${name}.`,
    impl: (a, cx, n) => {
      const x = a[0] as FormulaValue
      const y = a[1] as FormulaValue
      if (x.kind === 'empty' || y.kind === 'empty') return boolV(false) // ordering against Empty is never true
      const c = compareValues(x, y, cx.env.zone, (id) => cx.env.pageTitle(id) ?? id)
      if (c === null) return cx.err(n, 'FORMULA_TYPE', `cannot compare ${typeName(x)} with ${typeName(y)}`)
      return boolV(test(c))
    },
  })
cmp('lt', (c) => c < 0)
cmp('lte', (c) => c <= 0)
cmp('gt', (c) => c > 0)
cmp('gte', (c) => c >= 0)

export const FUNCTIONS: Record<string, FnSpec> = Object.fromEntries(specs.map((s) => [s.name, s]))

/** Every public name from the language contract; the registry must implement each one. */
export const PUBLIC_NAMES = [
  'prop', 'if', 'ifs', 'empty', 'length', 'substring', 'contains', 'test', 'match', 'replace', 'replaceAll', 'lower', 'upper', 'repeat',
  'link', 'style', 'unstyle', 'format', 'add', 'subtract', 'multiply', 'mod', 'pow', 'divide', 'min', 'max', 'sum', 'median', 'mean', 'abs',
  'round', 'ceil', 'floor', 'sqrt', 'cbrt', 'exp', 'ln', 'log10', 'log2', 'sign', 'pi', 'e', 'toNumber', 'now', 'today', 'minute', 'hour',
  'day', 'date', 'week', 'month', 'year', 'dateAdd', 'dateSubtract', 'dateBetween', 'dateRange', 'dateStart', 'dateEnd', 'timestamp',
  'fromTimestamp', 'formatDate', 'formatNumber', 'parseDate', 'name', 'email', 'at', 'first', 'last', 'slice', 'concat', 'sort', 'reverse',
  'join', 'split', 'unique', 'includes', 'find', 'findIndex', 'filter', 'some', 'every', 'map', 'flat', 'id', 'equal', 'unequal', 'let',
  'lets', 'trim',
] as const

/** Machine-readable registry (arity, argument / result types, lazy positions, docs, test ids) for tools and documentation. */
export function registryTable() {
  return Object.values(FUNCTIONS).filter((f) => !f.hidden).map((f) => ({
    name: f.name, min: f.min, max: f.max === Infinity ? null : f.max, params: f.params, args: f.args ?? [], lazy: f.lazy ?? null,
    propagatesEmpty: !!f.propagateEmpty, doc: f.doc, tests: f.tests,
  }))
}

