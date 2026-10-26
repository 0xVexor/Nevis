// One property registry used by cells, page properties, query validation, clipboard, conversion, forms and formulas
// (handoff §7). The UI must not invent a separate type system.
import type { Cell, ConnectedValue, Definition, DateValue, Id, Json, Kind, Place, RichRun, VerificationValue } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { isCivil, normalizeDate, parseIsoInstant } from '../dates.ts'
import { asciiDigits, matchKey, parseStrictNumber, runsToText, textToRuns } from '../text.ts'
import { optionsOf, cfgOf, type SelectOption } from './config.ts'
import { parseReference } from '../providers/refs.ts'

export const MAX_TEXT_BYTES = 1024 * 1024

/** Where a property's value actually lives. */
export type Storage = 'title' | 'cell' | 'edges' | 'system' | 'derived' | 'allocated' | 'action' | 'external'
/** Operator family used by the query engine (handoff §10). */
export type ValueClass = 'text' | 'number' | 'select' | 'status' | 'members' | 'checkbox' | 'date' | 'derived' | 'verification' | 'none'

export interface Descriptor {
  kind: Kind
  storage: Storage
  /** user can type a value into a cell/page property */
  writable: boolean
  cellKind: Cell['kind'] | null
  valueClass: ValueClass
  /** may be used in filter/sort/group */
  queryable: boolean
}

const D = (kind: Kind, storage: Storage, writable: boolean, cellKind: Cell['kind'] | null, valueClass: ValueClass, queryable = true): Descriptor => ({
  kind, storage, writable, cellKind, valueClass, queryable,
})

export const DESCRIPTORS: Record<Kind, Descriptor> = {
  title: D('title', 'title', true, null, 'text'),
  text: D('text', 'cell', true, 'text', 'text'),
  number: D('number', 'cell', true, 'number', 'number'),
  select: D('select', 'cell', true, 'select', 'select'),
  multi_select: D('multi_select', 'cell', true, 'multi_select', 'members'),
  status: D('status', 'cell', true, 'status', 'status'),
  date: D('date', 'cell', true, 'date', 'date'),
  people: D('people', 'cell', true, 'people', 'members'),
  files: D('files', 'cell', true, 'files', 'members'),
  checkbox: D('checkbox', 'cell', true, 'checkbox', 'checkbox'),
  url: D('url', 'cell', true, 'url', 'text'),
  email: D('email', 'cell', true, 'email', 'text'),
  phone: D('phone', 'cell', true, 'phone', 'text'),
  relation: D('relation', 'edges', true, null, 'members'),
  rollup: D('rollup', 'derived', false, null, 'derived'),
  formula: D('formula', 'derived', false, null, 'derived'),
  created_time: D('created_time', 'system', false, null, 'date'),
  created_by: D('created_by', 'system', false, null, 'members'),
  last_edited_time: D('last_edited_time', 'system', false, null, 'date'),
  last_edited_by: D('last_edited_by', 'system', false, null, 'members'),
  button: D('button', 'action', false, null, 'none', false),
  unique_id: D('unique_id', 'allocated', false, null, 'text'),
  place: D('place', 'cell', true, 'place', 'text'),
  verification: D('verification', 'cell', true, 'verification', 'verification'),
  connected: D('connected', 'cell', true, 'connected', 'derived'),
}

export const descriptor = (k: Kind): Descriptor => DESCRIPTORS[k]
export const isWritable = (d: Definition) => DESCRIPTORS[d.kind].writable
export const isStoredCell = (k: Kind) => DESCRIPTORS[k].storage === 'cell'

/** Operators per value class (handoff §10 table). */
export const OPS: Record<ValueClass, string[]> = {
  text: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  select: ['equals', 'not_equals', 'is_empty', 'is_not_empty'],
  status: ['equals', 'not_equals', 'is_empty', 'is_not_empty', 'group_equals'],
  members: ['contains', 'not_contains', 'contains_any', 'contains_all', 'is_empty', 'is_not_empty'],
  checkbox: ['equals'],
  date: ['equals', 'before', 'after', 'on_or_before', 'on_or_after', 'between', 'relative', 'is_empty', 'is_not_empty'],
  derived: [],
  verification: ['equals', 'verifier', 'expired', 'is_empty', 'is_not_empty'],
  none: [],
}

// ───── defaults ─────

/** New-property default cell (handoff §7). Relations / computed / system kinds have no stored cell. */
export function defaultCell(def: Definition): Cell | undefined {
  switch (def.kind) {
    case 'text': return { kind: 'text', runs: [] }
    case 'number': return { kind: 'number', value: null }
    case 'select': return { kind: 'select', optionId: null }
    case 'multi_select': return { kind: 'multi_select', optionIds: [] }
    case 'status': return { kind: 'status', optionId: cfgOf.status(def).defaultOptionId }
    case 'date': return { kind: 'date', value: null }
    case 'people': return { kind: 'people', principalIds: [] }
    case 'files': return { kind: 'files', attachmentIds: [] }
    case 'checkbox': return { kind: 'checkbox', value: false }
    case 'url':
    case 'email':
    case 'phone': return { kind: def.kind, value: null }
    case 'place': return { kind: 'place', value: null }
    case 'verification': return { kind: 'verification', value: { state: 'unverified', verifierId: null, verifiedAt: null, expiresAt: null } }
    default: return undefined
  }
}

// ───── emptiness (filter semantics, handoff §10) ─────

/** Empty for filtering: null, missing writable value, zero-length text or list. 0 and false are NOT empty; whitespace text is NOT empty. */
export function isEmptyCell(cell: Cell | undefined): boolean {
  if (!cell) return true
  switch (cell.kind) {
    case 'text': return runsToText(cell.runs).length === 0
    case 'number': return cell.value === null
    case 'select': return cell.optionId === null
    case 'multi_select': return cell.optionIds.length === 0
    case 'status': return !cell.optionId
    case 'date': return cell.value === null
    case 'people': return cell.principalIds.length === 0
    case 'files': return cell.attachmentIds.length === 0
    case 'checkbox': return false
    case 'url':
    case 'email':
    case 'phone': return cell.value === null || cell.value.length === 0
    case 'place': return cell.value === null
    case 'verification': return cell.value.state === 'unverified'
    case 'connected': return cell.value === null
  }
}

// ───── validation ─────

const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']
export function isSafeUrl(s: string): boolean {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(s.trim())
  return !!m && SAFE_SCHEMES.includes(m[1].toLowerCase())
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]+$/
const PHONE_RE = /^\+?[\d\s().\-/]{3,}$/

function cleanRuns(runs: RichRun[]): RichRun[] {
  if (!Array.isArray(runs)) return fail('INVALID_VALUE', 'text runs must be an array')
  let bytes = 0
  const out: RichRun[] = []
  for (const r of runs) {
    if (!r || typeof r.text !== 'string') return fail('INVALID_VALUE', 'text run needs a string')
    bytes += r.text.length * 2
    if (r.href !== undefined && !isSafeUrl(r.href)) fail('INVALID_VALUE', `link scheme not allowed: ${r.href}`)
    if (r.text === '' && !r.mention) continue
    const run: RichRun = { text: r.text }
    if (r.bold) run.bold = true
    if (r.italic) run.italic = true
    if (r.underline) run.underline = true
    if (r.strike) run.strike = true
    if (r.code) run.code = true
    if (typeof r.color === 'string' && /^[a-z_]{1,24}$/.test(r.color)) run.color = r.color
    if (r.href !== undefined) run.href = r.href
    if (r.mention) {
      if (!['page', 'person'].includes(r.mention.kind) || typeof r.mention.id !== 'string') fail('INVALID_VALUE', 'bad mention')
      run.mention = { kind: r.mention.kind, id: r.mention.id }
    }
    out.push(run)
  }
  if (bytes > MAX_TEXT_BYTES) fail('QUOTA', 'text exceeds 1 MiB', { limit: MAX_TEXT_BYTES })
  return out
}

function validPlace(p: Place): Place {
  const lat = p.lat === undefined ? null : p.lat
  const lon = p.lon === undefined ? null : p.lon
  if ((lat === null) !== (lon === null)) fail('INVALID_VALUE', 'latitude and longitude must be set together')
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) fail('INVALID_VALUE', 'latitude must be within -90..90')
  if (lon !== null && (!Number.isFinite(lon) || lon < -180 || lon > 180)) fail('INVALID_VALUE', 'longitude must be within -180..180')
  const out: Place = { lat, lon, name: String(p.name ?? ''), address: String(p.address ?? '') }
  if (p.provider) out.provider = p.provider
  if (p.providerId) out.providerId = p.providerId
  if (lat === null && (out.name || out.address)) out.unresolved = true
  return out
}

const dedupe = <T,>(a: T[]) => [...new Set(a)]

/** Normalize and validate a cell against its definition. Throws INVALID_VALUE / SCHEMA_MISMATCH; never silently coerces. */
export function validateCell(def: Definition, cell: Cell): Cell {
  const want = DESCRIPTORS[def.kind].cellKind
  if (!want) return fail('INVALID_VALUE', `${def.kind} properties have no writable cell`, { propertyId: def.id })
  if (!cell || cell.kind !== want) return fail('INVALID_VALUE', `expected a ${want} value for ${def.name}`, { propertyId: def.id })
  switch (cell.kind) {
    case 'text': return { kind: 'text', runs: cleanRuns(cell.runs) }
    case 'number': {
      if (cell.value !== null && (typeof cell.value !== 'number' || !Number.isFinite(cell.value))) return fail('INVALID_VALUE', 'number must be finite', { propertyId: def.id })
      return { kind: 'number', value: cell.value }
    }
    case 'select': {
      if (cell.optionId !== null && !optionsOf(def).some((o) => o.id === cell.optionId)) return fail('INVALID_VALUE', 'unknown option', { propertyId: def.id, optionId: cell.optionId })
      return cell
    }
    case 'multi_select': {
      const ids = dedupe(cell.optionIds)
      const opts = new Set(optionsOf(def).map((o) => o.id))
      for (const id of ids) if (!opts.has(id)) return fail('INVALID_VALUE', 'unknown option', { propertyId: def.id, optionId: id })
      return { kind: 'multi_select', optionIds: ids }
    }
    case 'status': {
      if (!optionsOf(def).some((o) => o.id === cell.optionId)) return fail('INVALID_VALUE', 'unknown status option', { propertyId: def.id })
      return cell
    }
    case 'date': return { kind: 'date', value: cell.value === null ? null : normalizeDate(cell.value) }
    case 'people': {
      const ids = dedupe(cell.principalIds)
      if (!cfgOf.people(def).multiple && ids.length > 1) return fail('INVALID_VALUE', 'this property allows one person', { propertyId: def.id })
      return { kind: 'people', principalIds: ids }
    }
    case 'files': return { kind: 'files', attachmentIds: dedupe(cell.attachmentIds) }
    case 'checkbox': {
      if (typeof cell.value !== 'boolean') return fail('INVALID_VALUE', 'checkbox must be true or false', { propertyId: def.id })
      return cell
    }
    case 'url': {
      if (cell.value === null) return cell
      const v = cell.value.trim()
      if (!v) return { kind: 'url', value: null }
      if (!isSafeUrl(v)) return fail('INVALID_VALUE', `URL scheme not allowed: ${v}`, { propertyId: def.id })
      return { kind: 'url', value: v }
    }
    case 'email': {
      if (cell.value === null) return cell
      const v = cell.value.trim() // spelling is preserved, only surrounding space is dropped
      if (!v) return { kind: 'email', value: null }
      if (!EMAIL_RE.test(v)) return fail('INVALID_VALUE', `invalid email: ${v}`, { propertyId: def.id })
      return { kind: 'email', value: v }
    }
    case 'phone': {
      if (cell.value === null) return cell
      const v = cell.value.trim()
      if (!v) return { kind: 'phone', value: null }
      if (!PHONE_RE.test(asciiDigits(v))) return fail('INVALID_VALUE', `invalid phone number: ${v}`, { propertyId: def.id })
      return { kind: 'phone', value: v }
    }
    case 'place': return { kind: 'place', value: cell.value === null ? null : validPlace(cell.value) }
    case 'verification': return { kind: 'verification', value: validVerification(cell.value) }
    case 'connected': return { kind: 'connected', value: cell.value === null ? null : validConnected(def, cell.value) }
  }
}

function validConnected(def: Definition, v: ConnectedValue): ConnectedValue {
  const want = (def.config as { providerId?: string }).providerId
  const ref = parseReference(v.canonicalUrl, want)
  if (!ref || ref.externalId !== v.externalId || ref.provider !== v.provider) return fail('INVALID_VALUE', 'this link does not belong to the provider of this property', { propertyId: def.id })
  if (v.cache !== null && (typeof v.cache.fetchedAt !== 'number' || typeof v.cache.providerRevision !== 'string' || typeof v.cache.fields !== 'object')) return fail('INVALID_VALUE', 'malformed provider cache', { propertyId: def.id })
  return { provider: ref.provider, externalId: ref.externalId, canonicalUrl: ref.canonicalUrl, cache: v.cache, ...(v.status ? { status: v.status } : {}) }
}

function validVerification(v: VerificationValue): VerificationValue {
  if (!v || !['verified', 'unverified'].includes(v.state)) return fail('INVALID_VALUE', 'bad verification state')
  return { state: v.state, verifierId: v.verifierId ?? null, verifiedAt: v.verifiedAt ?? null, expiresAt: v.expiresAt ?? null }
}

// ───── text projection (clipboard, search, conversion reports) ─────

export interface TextCtx {
  /** display name for a person id (the directory); unknown ids fall back to the id */
  personName?: (id: Id) => string
  fileName?: (id: Id) => string
  zone?: string
}

export function optionName(def: Definition, id: Id | null): string {
  if (id === null) return ''
  return optionsOf(def).find((o) => o.id === id)?.name ?? ''
}

export function dateToText(v: DateValue): string {
  return v.end && v.end !== v.start ? `${v.start} → ${v.end}` : v.start
}

/** Plain deterministic text of a cell. Lists join with ", " for display only (handoff §9 rule 2). */
export function cellToText(def: Definition, cell: Cell | undefined, ctx: TextCtx = {}): string {
  if (!cell) return ''
  switch (cell.kind) {
    case 'text': return runsToText(cell.runs)
    case 'number': return cell.value === null ? '' : String(cell.value)
    case 'select': return optionName(def, cell.optionId)
    case 'multi_select': return cell.optionIds.map((i) => optionName(def, i)).filter(Boolean).join(', ')
    case 'status': return optionName(def, cell.optionId)
    case 'date': return cell.value ? dateToText(cell.value) : ''
    case 'people': return cell.principalIds.map((i) => ctx.personName?.(i) ?? i).join(', ')
    case 'files': return cell.attachmentIds.map((i) => ctx.fileName?.(i) ?? i).join(', ')
    case 'checkbox': return cell.value ? 'true' : 'false'
    case 'url':
    case 'email':
    case 'phone': return cell.value ?? ''
    case 'place': return cell.value ? [cell.value.name, cell.value.address].filter(Boolean).join(' — ') : ''
    case 'verification': return cell.value.state
    case 'connected': return connectedText(cell)
  }
}

/** What a connected cell shows: the fetched name / title / subject, else the link itself. */
export function connectedText(cell: Extract<Cell, { kind: 'connected' }>): string {
  const v = cell.value
  if (!v) return ''
  const f = v.cache?.fields ?? {}
  const name = [f.name, f.title, f.subject].find((x) => typeof x === 'string' && x)
  return typeof name === 'string' ? name : v.canonicalUrl
}

// ───── text parsing (explicit paste / import, never inferred) ─────

export interface ParseCtx extends TextCtx {
  decimalSeparator?: string
  /** explicit list delimiter chosen by the user for multi-value kinds; without it the whole text is one label */
  listDelimiter?: string | null
  /** principal lookup by display name -> ids (more than one = ambiguous) */
  principalsByName?: (name: string) => Id[]
  yesLabels?: string[]
  noLabels?: string[]
}

const YES = ['true', 'yes', '1', 'y', 'بله', 'آری', '✓']
const NO = ['false', 'no', '0', 'n', 'خیر', 'نه']

export function parseBoolean(text: string, ctx: ParseCtx = {}): boolean | null {
  const k = matchKey(text).trim()
  if ([...YES, ...(ctx.yesLabels ?? [])].map(matchKey).includes(k)) return true
  if ([...NO, ...(ctx.noLabels ?? [])].map(matchKey).includes(k)) return false
  return null
}

/** Label matching: NFC, trim, case-insensitive. Two options with the same label are ambiguous -> error, never first-match. */
export function findOptionByLabel(options: SelectOption[], label: string): SelectOption | null {
  const k = matchKey(label).trim()
  const hits = options.filter((o) => matchKey(o.name).trim() === k)
  if (hits.length > 1) return fail('INVALID_VALUE', `ambiguous option label: ${label}`)
  return hits[0] ?? null
}

export function parseCellText(def: Definition, text: string, ctx: ParseCtx = {}): Cell {
  const kind = DESCRIPTORS[def.kind].cellKind
  if (!kind) return fail('INVALID_VALUE', `${def.kind} cannot be pasted into`, { propertyId: def.id })
  const trimmed = text.trim()
  switch (kind) {
    case 'text': return { kind: 'text', runs: textToRuns(text) }
    case 'number': {
      if (!trimmed) return { kind: 'number', value: null }
      const n = parseStrictNumber(trimmed, ctx.decimalSeparator)
      if (n === null) return fail('INVALID_VALUE', `not a number: ${text}`, { propertyId: def.id })
      return { kind: 'number', value: n }
    }
    case 'select': {
      if (!trimmed) return { kind: 'select', optionId: null }
      const o = findOptionByLabel(optionsOf(def), trimmed)
      if (!o) return fail('INVALID_VALUE', `no such option: ${text}`, { propertyId: def.id })
      return { kind: 'select', optionId: o.id }
    }
    case 'status': {
      const o = findOptionByLabel(optionsOf(def), trimmed)
      if (!o) return fail('INVALID_VALUE', `no such status: ${text}`, { propertyId: def.id })
      return { kind: 'status', optionId: o.id }
    }
    case 'multi_select': {
      if (!trimmed) return { kind: 'multi_select', optionIds: [] }
      const parts = ctx.listDelimiter ? trimmed.split(ctx.listDelimiter).map((s) => s.trim()).filter(Boolean) : [trimmed]
      const opts = optionsOf(def)
      const ids: Id[] = []
      for (const p of parts) {
        const o = findOptionByLabel(opts, p)
        if (!o) return fail('INVALID_VALUE', `no such option: ${p}`, { propertyId: def.id })
        ids.push(o.id)
      }
      return { kind: 'multi_select', optionIds: dedupe(ids) }
    }
    case 'checkbox': {
      const b = parseBoolean(trimmed, ctx)
      if (b === null) return fail('INVALID_VALUE', `not a checkbox value: ${text}`, { propertyId: def.id })
      return { kind: 'checkbox', value: b }
    }
    case 'date': {
      if (!trimmed) return { kind: 'date', value: null }
      return { kind: 'date', value: parseIsoDateText(trimmed, ctx.zone ?? 'UTC') }
    }
    case 'people': {
      if (!trimmed) return { kind: 'people', principalIds: [] }
      const names = ctx.listDelimiter ? trimmed.split(ctx.listDelimiter).map((s) => s.trim()).filter(Boolean) : [trimmed]
      const ids: Id[] = []
      for (const n of names) {
        const hits = ctx.principalsByName?.(n) ?? []
        if (hits.length !== 1) return fail('INVALID_VALUE', hits.length ? `ambiguous person: ${n}` : `unknown person: ${n}`, { propertyId: def.id })
        ids.push(hits[0])
      }
      return validateCell(def, { kind: 'people', principalIds: ids })
    }
    case 'files': return fail('INVALID_VALUE', 'files cannot be created from text', { propertyId: def.id })
    case 'url':
    case 'email':
    case 'phone': return validateCell(def, { kind, value: trimmed || null } as Cell)
    case 'place': return { kind: 'place', value: trimmed ? validPlace({ lat: null, lon: null, name: '', address: trimmed }) : null }
    case 'verification': return fail('INVALID_VALUE', 'verification cannot be pasted into', { propertyId: def.id })
    case 'connected': {
      if (!trimmed) return { kind: 'connected', value: null }
      const ref = parseReference(trimmed, (def.config as { providerId?: string }).providerId)
      if (!ref) return fail('INVALID_VALUE', 'this link is not supported by the provider of this property', { propertyId: def.id })
      return validateCell(def, { kind: 'connected', value: { provider: ref.provider, externalId: ref.externalId, canonicalUrl: ref.canonicalUrl, cache: null } })
    }
  }
}

/** Strict ISO date or date range text: `2026-10-25`, `2026-10-25 → 2026-10-27`, `2026-10-25T09:00`. */
export function parseIsoDateText(text: string, zone: string): DateValue {
  const parts = text.split(/\s*(?:→|\.\.|\/)\s*/)
  if (parts.length > 2) return fail('INVALID_VALUE', `not a date: ${text}`)
  type One = { civil: string; ms?: undefined } | { ms: number; civil?: undefined }
  const one = (s: string): One => {
    if (isCivil(s)) return { civil: s }
    const ms = parseIsoInstant(s, zone)
    if (ms === null) return fail('INVALID_VALUE', `not an ISO date: ${s}`)
    return { ms }
  }
  const a = one(parts[0])
  const b = parts[1] ? one(parts[1]) : null
  if (a.civil !== undefined && (b === null || b.civil !== undefined)) return normalizeDate({ kind: 'date', start: a.civil, end: b ? b.civil! : null })
  if (a.ms !== undefined && (b === null || b.ms !== undefined))
    return normalizeDate({ kind: 'datetime', start: new Date(a.ms).toISOString(), end: b ? new Date(b.ms!).toISOString() : null, timeZone: zone === 'UTC' ? null : zone })
  return fail('INVALID_VALUE', `date range mixes a day and a time: ${text}`)
}

export function cellEquals(a: Cell | undefined, b: Cell | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export const jsonOf = (c: Cell): Json => c as unknown as Json
