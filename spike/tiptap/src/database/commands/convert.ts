// Property conversion (handoff §9): a planned command — preview -> report -> explicit commit — with a schema revision guard,
// archived original values and one undo group. Every pair not listed in the dispatch is unsupported, never guessed.
import type { Cell, DateValue, Definition, Id, Json, Kind, PageLike, RelationDefinition } from '../model/types.ts'
import { DbError, fail } from '../model/errors.ts'
import { hash, same } from '../model/json.ts'
import { keyBetween } from '../model/ids.ts'
import { isCivil, normalizeDate, civilString, jalaliToCivil, startOfDayMs, toIso, parseIsoInstant } from '../dates.ts'
import { validateConfig, statusConfig, selectConfig, type OptionColor, type SelectOption, type StatusConfig } from '../props/config.ts'
import { cellToText, defaultCell, findOptionByLabel, parseBoolean, parseIsoDateText, validateCell } from '../props/registry.ts'
import { asciiDigits, matchKey, parseStrictNumber, runsToText, textToRuns } from '../text.ts'
import { register, type Ctx, type Coordinator } from './coordinator.ts'
import type { DbState, Row } from '../state.ts'
import type { Draft } from './draft.ts'
import { bumpSchema, property } from './util.ts'
import { addEdge } from './relations.ts'
import { Resolver } from '../resolver.ts'
import { toQValue } from '../formula/values.ts'

export type InvalidPolicy = 'rejectInvalid' | 'clearInvalid'

export type ConvertMapping = {
  /** text -> select/multi/status: explicit label -> option id (or "create") */
  labels?: Record<string, Id | 'create'>
  autoCreateOptions?: boolean
  createGroup?: 'todo' | 'active' | 'complete'
  /** explicit list delimiter; without it commas are never split */
  delimiter?: string
  decimalSeparator?: string
  /** text -> date: explicit input format, otherwise strict ISO only */
  dateFormat?: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY/MM/DD' | 'jalali'
  timestampUnit?: 'ms' | 's'
  zone?: string
  /** multi -> single when several are selected */
  pick?: 'first_by_order'
  /** select/multi <-> status explicit option mapping (source option id -> destination option id) */
  optionMap?: Record<Id, Id>
  statusTrue?: Id
  statusFalse?: Id
  /** text -> people */
  principals?: Record<string, Id>
  yesLabels?: string[]
  noLabels?: string[]
  /** text -> relation: label -> page id (explicit; titles never resolve implicitly) */
  pages?: Record<string, Id>
}

export type ConvertPlan = { propertyId: Id; destinationKind: Kind; destinationConfig?: Json; mapping?: ConvertMapping; invalidPolicy?: InvalidPolicy }

export type ConversionEntry = { pageId: Id; before: string; after: string; loss: 'lossless' | 'lossy' | 'invalid'; reason?: string }
export type ConversionReport = {
  supported: boolean
  unsupportedReason?: string
  counts: { total: number; lossless: number; lossy: number; invalid: number }
  samples: ConversionEntry[]
  invalid: ConversionEntry[]
  newConfig: Json
  createdOptions: string[]
}

type Planned = { report: ConversionReport; apply: Map<Id, Cell | null>; archived: Map<Id, Cell | null>; hash: string; edgesFor?: { pageId: Id; target: Id }[] }

const TEXTLIKE: Kind[] = ['text', 'url', 'email', 'phone']
const STATIC: Kind[] = ['text', 'number', 'select', 'multi_select', 'status', 'date', 'people', 'files', 'checkbox', 'url', 'email', 'phone', 'place', 'relation']

export function isConvertible(from: Kind, to: Kind): boolean {
  if (from === 'title' || to === 'title') return false
  if (from === to) return true
  if (!STATIC.includes(from)) return false // formula / rollup / system / button / id leave only via materialize or duplicate
  if (to === 'formula' || to === 'rollup' || to === 'button') return true // rule 11 (archive + new definition)
  if (!STATIC.includes(to)) return false
  if (to === 'text') return true // rule 2
  if (TEXTLIKE.includes(to)) return from === 'text' || TEXTLIKE.includes(from) // text <-> url/email/phone by validation
  const pairs: [Kind, Kind][] = [
    ['text', 'number'], ['text', 'checkbox'], ['number', 'checkbox'], ['checkbox', 'number'], ['text', 'date'], ['date', 'number'], ['number', 'date'],
    ['text', 'select'], ['text', 'multi_select'], ['text', 'status'], ['select', 'multi_select'], ['multi_select', 'select'],
    ['select', 'status'], ['status', 'select'], ['multi_select', 'status'], ['status', 'multi_select'], ['status', 'checkbox'], ['checkbox', 'status'],
    ['text', 'people'], ['text', 'relation'], ['text', 'place'], ['place', 'text'], ['url', 'text'], ['date', 'date'],
  ]
  return pairs.some(([a, b]) => a === from && b === to)
}

const plainFromCell = (def: Definition, c: Cell | undefined) => cellToText(def, c)

function parseDateByFormat(text: string, m: ConvertMapping, zone: string): DateValue | 'invalid' {
  const t = asciiDigits(text.trim())
  try {
    if (!m.dateFormat) return parseIsoDateText(t, zone) // strict ISO only: "01/02/03" is invalid, not guessed
    const parts = t.split(/[/-]/).map((x) => Number(x))
    if (parts.length !== 3 || parts.some((x) => !Number.isInteger(x))) return 'invalid'
    let c: string
    switch (m.dateFormat) {
      case 'YYYY-MM-DD': return parseIsoDateText(t, zone)
      case 'YYYY/MM/DD': c = civilString(parts[0], parts[1], parts[2]); break
      case 'DD/MM/YYYY': c = civilString(parts[2], parts[1], parts[0]); break
      case 'MM/DD/YYYY': c = civilString(parts[2], parts[0], parts[1]); break
      case 'jalali': c = jalaliToCivil(parts[0], parts[1], parts[2]); break
    }
    return isCivil(c) ? { kind: 'date', start: c, end: null } : 'invalid'
  } catch {
    return 'invalid'
  }
}

type Conv = { out: Cell | null; loss: 'lossless' | 'lossy' | 'invalid'; reason?: string }

export function planConversion(base: DbState | Draft, plan: ConvertPlan, ctxInfo: { zone: string; principalName?: (id: Id) => string; pageTitle?: (id: Id) => string; labelIsAmbiguous?: boolean }): Planned {
  const def = base.get('property', plan.propertyId)
  if (!def || def.deletedAt !== null) return fail('NOT_FOUND', 'property not found', { propertyId: plan.propertyId })
  const from = def.kind
  const to = plan.destinationKind
  const m = plan.mapping ?? {}
  const zone = m.zone ?? ctxInfo.zone
  const empty = (reason: string): Planned => ({
    report: { supported: false, unsupportedReason: reason, counts: { total: 0, lossless: 0, lossy: 0, invalid: 0 }, samples: [], invalid: [], newConfig: def.config, createdOptions: [] },
    apply: new Map(), archived: new Map(), hash: '',
  })
  if (!isConvertible(from, to)) return empty(`${from} cannot be converted to ${to}`)
  if (from === 'rollup' || from === 'formula') return empty('use materialize to turn a computed property into values')
  const rows = base instanceof Object && 'rowsOf' in base ? (base as Draft).rowsOf(def.sourceId) : (base as DbState).rows(def.sourceId)

  // destination config + option resolution
  let destCfg: Json = plan.destinationConfig ?? {}
  const created: string[] = []
  const toOptionKinds: Kind[] = ['select', 'multi_select', 'status']
  let options: (SelectOption & { statusGroupId?: Id })[] = []
  let statusCfg: StatusConfig | null = null
  if (toOptionKinds.includes(to)) {
    if (from === to) {
      options = (selectOrStatus(def).options ?? []) as typeof options
    } else if (to === 'status') {
      const dc = destCfg as { options?: unknown[] }
      if (dc.options?.length) statusCfg = statusConfig(destCfg)
      else statusCfg = null
    }
    if (to !== 'status' || from !== 'status') {
      const dc = destCfg as { options?: (SelectOption & { statusGroupId?: Id })[] }
      if (to !== 'status') options = dc.options ? selectConfig(destCfg).options : from === 'select' || from === 'multi_select' ? selectConfig(def.config).options : []
    }
  }
  const newOptionKey = (opts: { sortKey: string }[]) => keyBetween(opts.length ? opts[opts.length - 1].sortKey : null, null)
  const makeOption = (label: string): Id => {
    created.push(label)
    const id = `new-${created.length}-${hash(label)}`
    if (to === 'status') {
      if (!statusCfg) statusCfg = defaultStatusStub()
      const g = statusCfg.groups.find((x) => x.semantic === (m.createGroup ?? 'todo'))!
      statusCfg.options.push({ id, name: label, color: 'default', sortKey: newOptionKey(statusCfg.options), statusGroupId: g.id })
    } else options.push({ id, name: label, color: 'default' as OptionColor, sortKey: newOptionKey(options) })
    return id
  }
  const destOptions = () => (to === 'status' ? (statusCfg?.options ?? []) : options)
  const labelToOption = (label: string): { id: Id } | { error: string } => {
    const k = label.trim()
    if (!k) return { error: 'empty label' }
    const mapped = m.labels?.[k] ?? m.labels?.[matchKey(k)]
    if (mapped && mapped !== 'create') {
      return destOptions().some((o) => o.id === mapped) ? { id: mapped } : { error: `mapped option ${mapped} does not exist` }
    }
    if (mapped === 'create') {
      const have = destOptions().find((o) => matchKey(o.name).trim() === matchKey(k))
      return { id: have ? have.id : makeOption(k) }
    }
    try {
      const hit = findOptionByLabel(destOptions(), k)
      if (hit) return { id: hit.id }
    } catch (e) {
      return { error: (e as DbError).message }
    }
    if (m.autoCreateOptions) return { id: makeOption(k) }
    return { error: `no option for "${k}" (map it or allow creating options)` }
  }

  const principalIdFor = (name: string): Id | undefined => m.principals?.[name.trim()]

  const apply = new Map<Id, Cell | null>()
  const archived = new Map<Id, Cell | null>()
  const entries: ConversionEntry[] = []
  const counts = { total: 0, lossless: 0, lossy: 0, invalid: 0 }
  const edgeSpecs: { pageId: Id; target: Id }[] = []
  const destDef = { ...def, kind: to } as Definition

  for (const row of rows) {
    const stored = row.ext.cells[def.id]?.value
    const cur: Cell | undefined = stored ?? defaultCell(def)
    const r = convertCell(def, from, to, cur, m, zone, { options: destOptions, labelToOption, principalIdFor, ctxInfo, makeBool: m, row })
    counts.total++
    counts[r.loss]++
    const e: ConversionEntry = { pageId: row.page.id, before: plainFromCell(def, cur), after: r.out ? plainFromCell(destDef, r.out) : '', loss: r.loss, reason: r.reason }
    if (r.loss !== 'lossless' || entries.length < 10) entries.push(e)
    if (r.loss === 'invalid') {
      apply.set(row.page.id, null)
      archived.set(row.page.id, stored ?? null)
    } else {
      apply.set(row.page.id, r.out)
      if (stored && r.loss === 'lossy') archived.set(row.page.id, stored)
      if (to === 'relation' && r.out && r.out.kind === 'text') edgeSpecs.push({ pageId: row.page.id, target: runsToText(r.out.runs) })
    }
  }

  // destination config
  let newConfig: Json
  if (to === 'status') {
    const cfg = statusCfg ?? (from === 'status' ? statusConfig(def.config) : defaultStatusStub())
    newConfig = cfg as unknown as Json
  } else if (to === 'select' || to === 'multi_select') newConfig = { options } as unknown as Json
  else newConfig = destCfg
  if (to === 'formula' || to === 'rollup' || to === 'button' || to === 'relation') newConfig = destCfg
  const report: ConversionReport = {
    supported: true, counts, samples: entries.slice(0, 20), invalid: entries.filter((x) => x.loss === 'invalid'), newConfig, createdOptions: created,
  }
  const h = hash([plan, def.revision, rows.map((r) => [r.page.id, r.page.recordMeta?.revision ?? 0])])
  return { report, apply, archived, hash: h, edgesFor: edgeSpecs }
}

function defaultStatusStub(): StatusConfig {
  const [a, b, c] = ['V', 'l', 'x']
  const groups = [
    { id: 'g-todo', semantic: 'todo' as const, label: 'To-do', sortKey: a },
    { id: 'g-active', semantic: 'active' as const, label: 'In progress', sortKey: b },
    { id: 'g-complete', semantic: 'complete' as const, label: 'Complete', sortKey: c },
  ]
  return { groups, options: [], defaultOptionId: '' }
}

function selectOrStatus(def: Definition): { options: (SelectOption & { statusGroupId?: Id })[] } {
  return def.kind === 'status' ? statusConfig(def.config) : selectConfig(def.config)
}

type CellCtx = {
  options: () => (SelectOption & { statusGroupId?: Id })[]
  labelToOption: (l: string) => { id: Id } | { error: string }
  principalIdFor: (n: string) => Id | undefined
  ctxInfo: { zone: string; principalName?: (id: Id) => string; pageTitle?: (id: Id) => string }
  makeBool: ConvertMapping
  row: Row
}

const ok = (out: Cell | null, loss: Conv['loss'] = 'lossless', reason?: string): Conv => ({ out, loss, reason })
const bad = (reason: string): Conv => ({ out: null, loss: 'invalid', reason })

function convertCell(def: Definition, from: Kind, to: Kind, cur: Cell | undefined, m: ConvertMapping, zone: string, cc: CellCtx): Conv {
  const text = cur ? cellToText(def, cur, { personName: cc.ctxInfo.principalName }) : ''
  if (from === 'relation') return to === 'text' ? ok({ kind: 'text', runs: textToRuns('') }, 'lossy', 'relation links are archived') : bad('relation cannot convert')
  if (to === 'formula' || to === 'rollup' || to === 'button') return ok(null, 'lossy', 'values are archived')
  // rule 1: same kind (settings change)
  if (from === to) {
    if (!cur) return ok(null)
    if (cur.kind === 'select' && cur.optionId && !cc.options().some((o) => o.id === cur.optionId)) return bad('option no longer exists')
    if (cur.kind === 'multi_select') {
      const kept = cur.optionIds.filter((i) => cc.options().some((o) => o.id === i))
      return kept.length === cur.optionIds.length ? ok(cur) : ok({ kind: 'multi_select', optionIds: kept }, 'lossy', 'options removed')
    }
    return ok(cur)
  }
  // rule 2: anything -> text
  if (to === 'text') {
    if (!cur) return ok(null)
    const lossy = ['multi_select', 'people', 'files', 'place', 'date'].includes(from)
    return ok(text ? { kind: 'text', runs: textToRuns(text) } : null, lossy ? 'lossy' : 'lossless')
  }
  if (TEXTLIKE.includes(to)) {
    const t = text.trim()
    if (!t) return ok(null)
    try {
      return ok(validateCell({ ...def, kind: to } as Definition, { kind: to, value: t } as Cell))
    } catch (e) {
      return bad((e as Error).message)
    }
  }
  const empty = !text.trim()
  switch (`${from}>${to}`) {
    case 'text>number':
    case 'url>number': {
      if (empty) return ok(null)
      const n = parseStrictNumber(text, m.decimalSeparator)
      return n === null ? bad(`"${text}" is not a number`) : ok({ kind: 'number', value: n })
    }
    case 'text>checkbox': {
      if (empty) return ok(null)
      const b = parseBoolean(text, { yesLabels: m.yesLabels, noLabels: m.noLabels })
      return b === null ? bad(`"${text}" is not true/false`) : ok({ kind: 'checkbox', value: b })
    }
    case 'number>checkbox': {
      if (!cur || cur.kind !== 'number' || cur.value === null) return ok(null)
      return cur.value === 0 || cur.value === 1 ? ok({ kind: 'checkbox', value: cur.value === 1 }) : bad('only 0 and 1 convert to a checkbox')
    }
    case 'checkbox>number': return ok({ kind: 'number', value: cur?.kind === 'checkbox' && cur.value ? 1 : 0 })
    case 'text>date': {
      if (empty) return ok(null)
      const d = parseDateByFormat(text, m, zone)
      return d === 'invalid' ? bad(`"${text}" is not a date (choose a format)`) : ok({ kind: 'date', value: d })
    }
    case 'date>number': {
      if (!cur || cur.kind !== 'date' || !cur.value) return ok(null)
      if (!m.timestampUnit) return bad('choose a timestamp unit and zone to convert dates to numbers')
      const ms = cur.value.kind === 'date' ? startOfDayMs(cur.value.start, zone) : (parseIsoInstant(cur.value.start, zone) ?? NaN)
      return ok({ kind: 'number', value: m.timestampUnit === 's' ? Math.floor(ms / 1000) : ms }, 'lossy', 'end of range dropped')
    }
    case 'number>date': {
      if (!cur || cur.kind !== 'number' || cur.value === null) return ok(null)
      if (!m.timestampUnit) return bad('choose a timestamp unit and zone to convert numbers to dates')
      const ms = m.timestampUnit === 's' ? cur.value * 1000 : cur.value
      if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return bad('not a valid timestamp')
      return ok({ kind: 'date', value: normalizeDate({ kind: 'datetime', start: toIso(ms), end: null, timeZone: zone }) })
    }
    case 'text>select':
    case 'text>status': {
      if (empty) return to === 'status' ? ok(null) : ok(null)
      const r = cc.labelToOption(text)
      return 'error' in r ? bad(r.error) : ok({ kind: to === 'status' ? 'status' : 'select', optionId: r.id } as Cell)
    }
    case 'text>multi_select': {
      if (empty) return ok(null)
      const parts = m.delimiter ? text.split(m.delimiter).map((s) => s.trim()).filter(Boolean) : [text]
      const ids: Id[] = []
      for (const p of parts) {
        const r = cc.labelToOption(p)
        if ('error' in r) return bad(r.error)
        if (!ids.includes(r.id)) ids.push(r.id)
      }
      return ok({ kind: 'multi_select', optionIds: ids })
    }
    case 'select>multi_select': return !cur || cur.kind !== 'select' || !cur.optionId ? ok(null) : ok({ kind: 'multi_select', optionIds: [cur.optionId] })
    case 'multi_select>select': {
      if (!cur || cur.kind !== 'multi_select' || !cur.optionIds.length) return ok(null)
      if (cur.optionIds.length === 1) return ok({ kind: 'select', optionId: cur.optionIds[0] })
      if (m.pick !== 'first_by_order') return bad('several options selected: choose how to pick one')
      const order = cc.options()
      const first = [...cur.optionIds].sort((a, b) => order.findIndex((o) => o.id === a) - order.findIndex((o) => o.id === b))[0]
      return ok({ kind: 'select', optionId: first }, 'lossy', 'extra options dropped')
    }
    case 'select>status':
    case 'multi_select>status':
    case 'status>select':
    case 'status>multi_select': {
      const ids = !cur ? [] : cur.kind === 'multi_select' ? cur.optionIds : 'optionId' in cur && cur.optionId ? [cur.optionId] : []
      if (!ids.length) return ok(null)
      const mapped = ids.map((i) => m.optionMap?.[i])
      if (mapped.some((x) => !x)) return bad('map every option explicitly')
      if (mapped.some((x) => !cc.options().some((o) => o.id === x))) return bad('mapped option does not exist')
      if (to === 'multi_select') return ok({ kind: 'multi_select', optionIds: mapped as Id[] })
      if (mapped.length > 1) return bad('several options selected: choose how to pick one')
      return ok({ kind: to, optionId: mapped[0] } as Cell)
    }
    case 'status>checkbox': {
      if (!cur || cur.kind !== 'status') return ok(null)
      const cfg = statusConfig(def.config)
      const o = cfg.options.find((x) => x.id === cur.optionId)
      const g = cfg.groups.find((x) => x.id === o?.statusGroupId)
      return ok({ kind: 'checkbox', value: g?.semantic === 'complete' }, 'lossy', 'to-do and in-progress both become unchecked')
    }
    case 'checkbox>status': {
      const v = cur?.kind === 'checkbox' && cur.value
      const id = v ? m.statusTrue : m.statusFalse
      if (!id || !cc.options().some((o) => o.id === id)) return bad('choose a status for both checked and unchecked')
      return ok({ kind: 'status', optionId: id })
    }
    case 'text>people': {
      if (empty) return ok(null)
      const names = m.delimiter ? text.split(m.delimiter).map((s) => s.trim()).filter(Boolean) : [text.trim()]
      const ids: Id[] = []
      for (const n of names) {
        const id = cc.principalIdFor(n)
        if (!id) return bad(`no person is mapped for "${n}"`)
        ids.push(id)
      }
      return ok({ kind: 'people', principalIds: ids })
    }
    case 'text>place': return empty ? ok(null) : ok({ kind: 'place', value: { lat: null, lon: null, name: '', address: text.trim(), unresolved: true } })
    case 'place>text': return ok(cur?.kind === 'place' && cur.value ? { kind: 'text', runs: textToRuns(cur.value.name || cur.value.address) } : null, 'lossy', 'coordinates dropped')
    case 'text>relation': {
      if (empty) return ok(null)
      const labels = m.delimiter ? text.split(m.delimiter).map((s) => s.trim()).filter(Boolean) : [text.trim()]
      const ids: Id[] = []
      for (const l of labels) {
        const id = m.pages?.[l]
        if (!id) return bad(`no page is mapped for "${l}"`)
        ids.push(id)
      }
      return ok({ kind: 'text', runs: textToRuns(ids.join('\n')) })
    }
  }
  return bad(`${from} cannot be converted to ${to}`)
}

// ───── preview store + commands ─────

type Stored = { plan: ConvertPlan; hash: string; at: number }
const PREVIEWS = new WeakMap<object, Map<string, Stored>>()
const previewsOf = (c: object) => PREVIEWS.get(c) ?? PREVIEWS.set(c, new Map()).get(c)!

/** Read-only preview: no mutation id, no updatedAt change. */
export function previewConversion(coord: Coordinator, plan: ConvertPlan, zone: string): { previewId: string; previewHash: string; report: ConversionReport } {
  const rs = new Resolver(coord.state, { principalId: '', nowMs: Date.now(), zone, weekStart: 6 })
  const p = planConversion(coord.state, plan, { zone, principalName: (id) => coord.state.get('principal', id)?.displayName ?? id, pageTitle: (id) => rs.title(id) ?? id })
  const previewId = `pv-${p.hash}`
  previewsOf(coord).set(previewId, { plan, hash: p.hash, at: Date.now() })
  return { previewId, previewHash: p.hash, report: p.report }
}

function commitPlanned(cx: Ctx, plan: ConvertPlan, expectHash?: string) {
  const def = property(cx, plan.propertyId)
  cx.access.assertSource(cx.env.actorId, def.sourceId, 'edit_schema')
  const planned = planConversion(cx.d, plan, { zone: plan.mapping?.zone ?? 'UTC', principalName: (id) => cx.d.get('principal', id)?.displayName ?? id })
  if (expectHash && planned.hash !== expectHash) fail('SCHEMA_MISMATCH', 'the data changed since the preview; preview again', { expected: expectHash, actual: planned.hash })
  const rep = planned.report
  if (!rep.supported) fail('UNSUPPORTED_CONVERSION', rep.unsupportedReason ?? 'unsupported conversion')
  const policy = plan.invalidPolicy ?? 'rejectInvalid'
  if (rep.counts.invalid && policy === 'rejectInvalid') fail('INVALID_VALUE', `${rep.counts.invalid} value(s) cannot be converted; nothing was changed`, { invalid: rep.invalid.slice(0, 20) as unknown as Json, counts: rep.counts })
  const to = plan.destinationKind
  const m = cx.d.mut('property', def.id)
  const dest = to === 'select' || to === 'multi_select' || to === 'status' ? { ...(rep.newConfig as object), archivedOptions: (def.config as { archivedOptions?: Json })?.archivedOptions ?? [] } : rep.newConfig
  // created options get real ids
  let cfgJson = JSON.stringify(dest)
  const idMap = new Map<string, Id>()
  for (const mm of cfgJson.matchAll(/"id":"(new-[^"]+)"/g)) if (!idMap.has(mm[1])) idMap.set(mm[1], cx.ids())
  const remap = (s: string) => { for (const [a, b] of idMap) s = s.split(a).join(b); return s }
  cfgJson = remap(cfgJson)
  let cfg = JSON.parse(cfgJson) as Json
  if (to === 'status') {
    const sc = cfg as unknown as StatusConfig
    if (sc.groups.some((g) => g.id.startsWith('g-'))) {
      const gmap = new Map(sc.groups.map((g) => [g.id, cx.ids()]))
      let s = JSON.stringify(sc)
      for (const [a, b] of gmap) s = s.split(`"${a}"`).join(`"${b}"`)
      cfg = JSON.parse(s)
    }
    const s2 = cfg as unknown as StatusConfig
    if (!s2.options.length) fail('INVALID_VALUE', 'a status needs at least one option')
    if (!s2.defaultOptionId || !s2.options.some((o) => o.id === s2.defaultOptionId)) {
      const firstTodo = s2.options.find((o) => s2.groups.find((g) => g.id === (o as { statusGroupId?: Id }).statusGroupId)?.semantic === 'todo') ?? s2.options[0]
      s2.defaultOptionId = firstTodo.id
    }
  }
  m.kind = to
  let relDef: RelationDefinition | null = null
  if (to === 'relation') {
    const dc = (plan.destinationConfig ?? {}) as { targetSourceId?: Id; cardinality?: 'one' | 'many' }
    if (!dc.targetSourceId || !cx.d.get('source', dc.targetSourceId)) fail('INVALID_VALUE', 'a relation needs a target source')
    relDef = cx.d.add('relation', { ...cx.meta(), propertyId: def.id, sourceId: def.sourceId, targetSourceId: dc.targetSourceId!, mode: 'one_way', inversePropertyId: null, cardinality: dc.cardinality ?? 'many', inverseCardinality: 'many', displayedPropertyIds: [] })
    m.config = { definitionId: relDef.id, side: 'forward' }
  } else m.config = validateConfig(to, cfg, cx.ids)
  const edges: { pageId: Id; ids: Id[] }[] = []
  for (const [pageId, cell] of planned.apply) {
    const page = cx.d.mutPage(pageId)
    const ext = page.database!
    const arch = planned.archived.get(pageId)
    if (arch) (ext.archivedCells as Record<string, Json>)[`${def.id}@${cx.env.operationId}`] = arch as unknown as Json
    let out = cell
    if (to === 'status' && !out) out = null
    if (out && to === 'relation') { edges.push({ pageId, ids: runsToText((out as Extract<Cell, { kind: 'text' }>).runs).split('\n').filter(Boolean) }); out = null }
    if (out && to !== 'relation') {
      let c = out
      if (idMap.size) c = JSON.parse(remap(JSON.stringify(c))) as Cell
      const v = (to === 'formula' || to === 'rollup' || to === 'button') ? null : validateCell(m, c)
      if (v && !same(v, defaultCell(m) ?? null)) ext.cells[def.id] = { value: v, stamp: cx.stamp() }
      else delete ext.cells[def.id] // a value equal to the new type's default is implicit
    } else if (to === 'formula' || to === 'rollup' || to === 'button' || !out) delete ext.cells[def.id]
  }
  if (relDef) for (const e of edges) for (const t of e.ids) addEdge(cx, relDef, e.pageId, t, false)
  bumpSchema(cx, def.sourceId)
  return { converted: rep.counts as unknown as Json, edges: edges.reduce((n, e) => n + e.ids.length, 0) }
}

register('property.convert_commit', (cx, p: { plan: ConvertPlan; previewHash?: string }) => commitPlanned(cx, p.plan, p.previewHash))

/** Formula / Rollup -> static values from one consistent snapshot; inaccessible or errored results reject by default. */
register('property.materialize', (cx, p: { propertyId: Id; destinationKind?: Kind; zone?: string; policy?: InvalidPolicy; now?: string }) => {
  const def = property(cx, p.propertyId)
  if (def.kind !== 'formula' && def.kind !== 'rollup') fail('UNSUPPORTED_CONVERSION', 'only formulas and rollups can be materialized')
  cx.access.assertSource(cx.env.actorId, def.sourceId, 'edit_schema')
  const zone = p.zone ?? 'UTC'
  const rs = new Resolver(cx.state, { principalId: cx.env.actorId, nowMs: p.now ? Date.parse(p.now) : cx.now, zone, weekStart: 6 })
  const rows = cx.d.rowsOf(def.sourceId)
  const results: { page: PageLike; q: ReturnType<Resolver['value']> }[] = rows.map((r) => ({ page: r.page, q: rs.value({ page: cx.state.pages.get(r.page.id) ?? r.page, ext: (cx.state.pages.get(r.page.id) ?? r.page).database!, sourceId: r.sourceId }, def) }))
  const kinds = new Set(results.map((x) => x.q.c).filter((c) => c !== 'empty'))
  const bad = results.filter((x) => x.q.c === 'blocked')
  if (bad.length && (p.policy ?? 'rejectInvalid') === 'rejectInvalid') fail('INVALID_VALUE', `${bad.length} value(s) are errors, pending or restricted; nothing was changed`)
  let kind: Kind = p.destinationKind ?? (kinds.size === 1 ? ({ number: 'number', text: 'text', bool: 'checkbox', date: 'date', members: 'text', list: 'text', blocked: 'text', empty: 'text' }[[...kinds][0]] as Kind) : 'text')
  if (kinds.size > 1 && !p.destinationKind) kind = 'text'
  const m = cx.d.mut('property', def.id)
  const old = { kind: def.kind, config: def.config }
  m.kind = kind
  m.config = kind === 'select' || kind === 'multi_select' ? ({ options: [] } as Json) : validateConfig(kind, {}, cx.ids)
  const sample = m
  for (const { page, q } of results) {
    const pg = cx.d.mutPage(page.id)
    const ext = pg.database!
    ;(ext.archivedCells as Record<string, Json>)[`${def.id}@${cx.env.operationId}`] = old as unknown as Json
    let cell: Cell | null = null
    if (q.c === 'number') cell = kind === 'number' ? { kind: 'number', value: q.n } : kind === 'text' ? { kind: 'text', runs: textToRuns(String(q.n)) } : null
    else if (q.c === 'text') cell = kind === 'text' ? { kind: 'text', runs: textToRuns(q.text) } : null
    else if (q.c === 'bool') cell = kind === 'checkbox' ? { kind: 'checkbox', value: q.b } : kind === 'text' ? { kind: 'text', runs: textToRuns(String(q.b)) } : null
    else if (q.c === 'date') cell = kind === 'date' ? { kind: 'date', value: q.v } : kind === 'text' ? { kind: 'text', runs: textToRuns(JSON.stringify(q.v.start)) } : null
    else if (q.c === 'members' || q.c === 'list') cell = kind === 'text' ? { kind: 'text', runs: textToRuns(JSON.stringify(toQValue({ kind: 'empty' }))) } : null
    if (cell) ext.cells[def.id] = { value: validateCell(sample, cell), stamp: cx.stamp() }
    else delete ext.cells[def.id]
  }
  bumpSchema(cx, def.sourceId)
  return { kind }
})

/** Copy a system / computed property into a new static one (the original keeps its semantics). */
register('property.duplicate_as', (cx, p: { propertyId: Id; name: string; destinationKind: Kind; zone?: string }) => {
  const def = property(cx, p.propertyId)
  cx.access.assertSource(cx.env.actorId, def.sourceId, 'edit_schema')
  if (!['created_time', 'last_edited_time', 'created_by', 'last_edited_by', 'unique_id'].includes(def.kind)) fail('UNSUPPORTED_CONVERSION', 'only system properties are duplicated this way')
  const compat: Record<string, Kind[]> = { created_time: ['date', 'text'], last_edited_time: ['date', 'text'], created_by: ['people', 'text'], last_edited_by: ['people', 'text'], unique_id: ['text'] }
  if (!compat[def.kind].includes(p.destinationKind)) fail('UNSUPPORTED_CONVERSION', `${def.kind} cannot become ${p.destinationKind}`)
  const rs = new Resolver(cx.state, { principalId: cx.env.actorId, nowMs: cx.now, zone: p.zone ?? 'UTC', weekStart: 6 })
  const id = cx.ids()
  cx.d.add('property', { ...cx.meta(id), sourceId: def.sourceId, name: p.name, description: '', kind: p.destinationKind, sortKey: keyBetween(cx.d.props(def.sourceId).slice(-1)[0]?.sortKey ?? null, null), config: validateConfig(p.destinationKind, {}, cx.ids) })
  const nd = cx.d.get('property', id)!
  for (const r of cx.d.rowsOf(def.sourceId)) {
    const q = rs.value({ page: cx.state.pages.get(r.page.id) ?? r.page, ext: r.ext, sourceId: r.sourceId }, def)
    let cell: Cell | null = null
    if (q.c === 'date' && p.destinationKind === 'date') cell = { kind: 'date', value: q.v }
    else if (q.c === 'date') cell = { kind: 'text', runs: textToRuns(q.v.start) }
    else if (q.c === 'members' && p.destinationKind === 'people') cell = { kind: 'people', principalIds: q.ids }
    else if (q.c === 'members') cell = { kind: 'text', runs: textToRuns(q.ids.join(', ')) }
    else if (q.c === 'text') cell = { kind: 'text', runs: textToRuns(q.text) }
    if (cell) cx.d.mutPage(r.page.id).database!.cells[id] = { value: validateCell(nd, cell), stamp: cx.stamp() }
  }
  bumpSchema(cx, def.sourceId)
  return { propertyId: id }
})

