// Per-kind property configuration (handoff §5 "config must be validated by kind"). `config` is Json on the record; these helpers
// give it a typed shape, fill defaults and reject anything malformed.
import type { Definition, Id, Json, Kind } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { keysBetween } from '../model/ids.ts'
import { isValidZone } from '../dates.ts'

export type OptionColor = 'default' | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red'
export const OPTION_COLORS: OptionColor[] = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']

export type SelectOption = { id: Id; name: string; color: OptionColor; sortKey: string }
export type StatusSemantic = 'todo' | 'active' | 'complete'
export type StatusGroup = { id: Id; semantic: StatusSemantic; label: string; sortKey: string }
export type StatusOption = SelectOption & { statusGroupId: Id }

export type NumberFormatKind = 'plain' | 'grouped' | 'percent' | 'currency'
export type NumberConfig = {
  format: NumberFormatKind
  currencyCode?: string
  precision: number
  progress?: { mode: 'bar' | 'ring'; target: number; color: OptionColor }
}
export type SelectConfig = { options: SelectOption[] }
export type StatusConfig = { options: StatusOption[]; groups: StatusGroup[]; defaultOptionId: Id }
export type DateConfig = {
  displayCalendar: 'gregorian' | 'jalali'
  dateFormat: 'short' | 'long' | 'iso' | 'relative'
  timeFormat: '24h' | '12h' | 'none'
  defaultZone: string | null
  reminders?: { offsetMinutes: number }[]
}
export type PeopleConfig = { multiple: boolean }
export type FilesConfig = { allowedTypes: string[]; maxBytes: number }
export type RelationFieldConfig = { definitionId: Id; side: 'forward' | 'inverse' }
export type RollupAggregation =
  | 'count_all' | 'count_values' | 'count_unique' | 'count_empty' | 'count_not_empty' | 'percent_empty' | 'percent_not_empty'
  | 'checked' | 'unchecked' | 'percent_checked' | 'percent_unchecked' | 'sum' | 'average' | 'median' | 'min' | 'max' | 'range'
  | 'earliest_date' | 'latest_date' | 'date_range' | 'show_original' | 'show_unique'
export const ROLLUP_AGGREGATIONS: RollupAggregation[] = [
  'count_all', 'count_values', 'count_unique', 'count_empty', 'count_not_empty', 'percent_empty', 'percent_not_empty', 'checked',
  'unchecked', 'percent_checked', 'percent_unchecked', 'sum', 'average', 'median', 'min', 'max', 'range', 'earliest_date', 'latest_date',
  'date_range', 'show_original', 'show_unique',
]
export type RollupConfig = { relationPropertyId: Id; targetPropertyId: Id; aggregation: RollupAggregation; numberFormat?: NumberConfig }
export type FormulaConfig = {
  languageVersion: 1
  source: string
  ast: Json
  resolvedRefs: Record<string, Id>
  resultType: string
}
export type IdConfig = { allocationMode: 'sequential' | 'partitioned'; prefix: string; allocatorId?: Id }
export type PlaceConfig = { providerId?: string; defaultZoom: number }
export type ButtonConfig = { label: string; icon?: string; actions: Json[]; confirm?: boolean; workflowId?: Id }
export type VerificationConfig = { expiryPolicy: 'never' | '7d' | '30d' | '90d' | '180d' }
export type ConnectedConfig = { providerId: string; connectionId: Id; exposedFields: string[] }

export const NUMBER_PRECISION_MAX = 12

export const defaultNumberConfig = (): NumberConfig => ({ format: 'plain', precision: 0 })

export function newOption(id: Id, name: string, color: OptionColor, sortKey: string): SelectOption {
  return { id, name, color, sortKey }
}

export function defaultStatusConfig(ids: () => Id): StatusConfig {
  const [k1, k2, k3] = keysBetween(null, null, 3)
  const groups: StatusGroup[] = [
    { id: ids(), semantic: 'todo', label: 'To-do', sortKey: k1 },
    { id: ids(), semantic: 'active', label: 'In progress', sortKey: k2 },
    { id: ids(), semantic: 'complete', label: 'Complete', sortKey: k3 },
  ]
  const options: StatusOption[] = [
    { id: ids(), name: 'Not started', color: 'default', sortKey: k1, statusGroupId: groups[0].id },
    { id: ids(), name: 'In progress', color: 'blue', sortKey: k2, statusGroupId: groups[1].id },
    { id: ids(), name: 'Done', color: 'green', sortKey: k3, statusGroupId: groups[2].id },
  ]
  return { options, groups, defaultOptionId: options[0].id }
}

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v)

function validOption(o: unknown, where: string): SelectOption {
  if (!isObj(o) || typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || typeof o.sortKey !== 'string')
    return fail('SCHEMA_MISMATCH', `${where}: malformed option`)
  const color = (OPTION_COLORS as string[]).includes(o.color as string) ? (o.color as OptionColor) : 'default'
  return { id: o.id, name: o.name, color, sortKey: o.sortKey }
}

export function selectConfig(cfg: Json): SelectConfig {
  const opts = isObj(cfg) && Array.isArray(cfg.options) ? cfg.options : []
  const options = opts.map((o) => validOption(o, 'select'))
  assertUniqueOptions(options)
  return { options: options.sort(byKey) }
}

const byKey = (a: { sortKey: string }, b: { sortKey: string }) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)

export function assertUniqueOptions(options: { id: Id; name: string }[]) {
  const ids = new Set<Id>()
  const names = new Set<string>()
  for (const o of options) {
    if (ids.has(o.id)) fail('SCHEMA_MISMATCH', `duplicate option id ${o.id}`)
    ids.add(o.id)
    const n = o.name.normalize('NFC').trim().toLowerCase()
    if (names.has(n)) fail('INVALID_VALUE', `duplicate option name: ${o.name}`)
    names.add(n)
  }
}

export function statusConfig(cfg: Json): StatusConfig {
  if (!isObj(cfg)) return fail('SCHEMA_MISMATCH', 'status config missing')
  const groupsRaw = Array.isArray(cfg.groups) ? cfg.groups : []
  const groups: StatusGroup[] = groupsRaw.map((g) => {
    if (!isObj(g) || typeof g.id !== 'string' || !['todo', 'active', 'complete'].includes(g.semantic as string) || typeof g.sortKey !== 'string')
      return fail('SCHEMA_MISMATCH', 'status: malformed group')
    return { id: g.id, semantic: g.semantic as StatusSemantic, label: typeof g.label === 'string' ? g.label : String(g.semantic), sortKey: g.sortKey }
  })
  const semantics = new Set(groups.map((g) => g.semantic))
  if (groups.length !== 3 || semantics.size !== 3) fail('SCHEMA_MISMATCH', 'status needs exactly the three semantic groups todo/active/complete')
  const optsRaw = Array.isArray(cfg.options) ? cfg.options : []
  const options: StatusOption[] = optsRaw.map((o) => {
    const base = validOption(o, 'status')
    const gid = (o as Record<string, Json>).statusGroupId
    if (typeof gid !== 'string' || !groups.some((g) => g.id === gid)) return fail('SCHEMA_MISMATCH', `status option ${base.name} has no valid group`)
    return { ...base, statusGroupId: gid }
  })
  if (!options.length) fail('SCHEMA_MISMATCH', 'status needs at least one option')
  assertUniqueOptions(options)
  const def = cfg.defaultOptionId
  if (typeof def !== 'string' || !options.some((o) => o.id === def)) fail('SCHEMA_MISMATCH', 'status default option missing')
  return { options: options.sort(byKey), groups: groups.sort(byKey), defaultOptionId: def as Id }
}

export function numberConfig(cfg: Json): NumberConfig {
  const c = isObj(cfg) ? cfg : {}
  const format = (['plain', 'grouped', 'percent', 'currency'] as string[]).includes(c.format as string) ? (c.format as NumberFormatKind) : 'plain'
  const precision = typeof c.precision === 'number' ? c.precision : 0
  if (!Number.isInteger(precision) || precision < 0 || precision > NUMBER_PRECISION_MAX) fail('INVALID_VALUE', `number precision must be 0..${NUMBER_PRECISION_MAX}`)
  const out: NumberConfig = { format, precision }
  if (format === 'currency') {
    const code = typeof c.currencyCode === 'string' ? c.currencyCode.toUpperCase() : ''
    if (!/^[A-Z]{3}$/.test(code)) fail('INVALID_VALUE', 'currency needs a 3-letter currency code')
    out.currencyCode = code
  }
  if (isObj(c.progress)) {
    const p = c.progress
    const target = typeof p.target === 'number' && p.target > 0 && Number.isFinite(p.target) ? p.target : 100
    out.progress = { mode: p.mode === 'ring' ? 'ring' : 'bar', target, color: (OPTION_COLORS as string[]).includes(p.color as string) ? (p.color as OptionColor) : 'green' }
  }
  return out
}

export function dateConfig(cfg: Json): DateConfig {
  const c = isObj(cfg) ? cfg : {}
  const zone = typeof c.defaultZone === 'string' ? c.defaultZone : null
  if (zone !== null && !isValidZone(zone)) fail('INVALID_VALUE', `unknown time zone ${zone}`)
  return {
    displayCalendar: c.displayCalendar === 'jalali' ? 'jalali' : 'gregorian',
    dateFormat: (['short', 'long', 'iso', 'relative'] as string[]).includes(c.dateFormat as string) ? (c.dateFormat as DateConfig['dateFormat']) : 'short',
    timeFormat: (['24h', '12h', 'none'] as string[]).includes(c.timeFormat as string) ? (c.timeFormat as DateConfig['timeFormat']) : '24h',
    defaultZone: zone,
    reminders: Array.isArray(c.reminders)
      ? c.reminders.filter(isObj).map((r) => ({ offsetMinutes: typeof r.offsetMinutes === 'number' ? Math.trunc(r.offsetMinutes) : 0 }))
      : [],
  }
}

export const peopleConfig = (cfg: Json): PeopleConfig => ({ multiple: !isObj(cfg) || cfg.multiple !== false })

export function filesConfig(cfg: Json): FilesConfig {
  const c = isObj(cfg) ? cfg : {}
  return {
    allowedTypes: Array.isArray(c.allowedTypes) ? c.allowedTypes.filter((x): x is string => typeof x === 'string') : [],
    maxBytes: typeof c.maxBytes === 'number' && c.maxBytes > 0 ? c.maxBytes : 100 * 1024 * 1024,
  }
}

export function relationFieldConfig(cfg: Json): RelationFieldConfig {
  if (!isObj(cfg) || typeof cfg.definitionId !== 'string') return fail('SCHEMA_MISMATCH', 'relation property needs a relation definition')
  return { definitionId: cfg.definitionId, side: cfg.side === 'inverse' ? 'inverse' : 'forward' }
}

export function rollupConfig(cfg: Json): RollupConfig {
  if (!isObj(cfg)) return fail('SCHEMA_MISMATCH', 'rollup config missing')
  if (typeof cfg.relationPropertyId !== 'string' || typeof cfg.targetPropertyId !== 'string') return fail('SCHEMA_MISMATCH', 'rollup needs a relation and a target property')
  if (!(ROLLUP_AGGREGATIONS as string[]).includes(cfg.aggregation as string)) return fail('INVALID_VALUE', `unknown aggregation ${String(cfg.aggregation)}`)
  return {
    relationPropertyId: cfg.relationPropertyId,
    targetPropertyId: cfg.targetPropertyId,
    aggregation: cfg.aggregation as RollupAggregation,
    ...(isObj(cfg.numberFormat) ? { numberFormat: numberConfig(cfg.numberFormat) } : {}),
  }
}

export function formulaConfig(cfg: Json): FormulaConfig {
  if (!isObj(cfg) || cfg.languageVersion !== 1 || typeof cfg.source !== 'string') return fail('SCHEMA_MISMATCH', 'formula config malformed')
  return {
    languageVersion: 1,
    source: cfg.source,
    ast: (cfg.ast ?? null) as Json,
    resolvedRefs: isObj(cfg.resolvedRefs) ? (cfg.resolvedRefs as Record<string, Id>) : {},
    resultType: typeof cfg.resultType === 'string' ? cfg.resultType : 'any',
  }
}

export function idConfig(cfg: Json): IdConfig {
  const c = isObj(cfg) ? cfg : {}
  const prefix = typeof c.prefix === 'string' ? c.prefix : ''
  if (prefix.length > 12 || /[\s\u0000-\u001f]/.test(prefix)) fail('INVALID_VALUE', 'ID prefix must be at most 12 visible characters')
  return {
    allocationMode: c.allocationMode === 'sequential' ? 'sequential' : 'partitioned',
    prefix,
    ...(typeof c.allocatorId === 'string' ? { allocatorId: c.allocatorId } : {}),
  }
}

export const placeConfig = (cfg: Json): PlaceConfig => {
  const c = isObj(cfg) ? cfg : {}
  return { ...(typeof c.providerId === 'string' ? { providerId: c.providerId } : {}), defaultZoom: typeof c.defaultZoom === 'number' ? c.defaultZoom : 12 }
}

export function buttonConfig(cfg: Json): ButtonConfig {
  const c = isObj(cfg) ? cfg : {}
  if (typeof c.label !== 'string' || !c.label) return fail('INVALID_VALUE', 'button needs a label')
  return {
    label: c.label,
    ...(typeof c.icon === 'string' ? { icon: c.icon } : {}),
    actions: Array.isArray(c.actions) ? c.actions : [],
    confirm: c.confirm === true,
    ...(typeof c.workflowId === 'string' ? { workflowId: c.workflowId } : {}),
  }
}

export const verificationConfig = (cfg: Json): VerificationConfig => {
  const c = isObj(cfg) ? cfg : {}
  return { expiryPolicy: (['never', '7d', '30d', '90d', '180d'] as string[]).includes(c.expiryPolicy as string) ? (c.expiryPolicy as VerificationConfig['expiryPolicy']) : 'never' }
}

export function connectedConfig(cfg: Json): ConnectedConfig {
  const c = isObj(cfg) ? cfg : {}
  if (typeof c.providerId !== 'string' || typeof c.connectionId !== 'string') return fail('SCHEMA_MISMATCH', 'connected property needs provider and connection')
  return { providerId: c.providerId, connectionId: c.connectionId, exposedFields: Array.isArray(c.exposedFields) ? c.exposedFields.filter((x): x is string => typeof x === 'string') : [] }
}

/** Validate a config for the given kind and return the normalized JSON stored on the record. */
export function validateConfig(kind: Kind, cfg: Json, ids: () => Id): Json {
  switch (kind) {
    case 'select':
    case 'multi_select': return selectConfig(cfg ?? { options: [] }) as unknown as Json
    case 'status': return statusConfig(isObj(cfg) && cfg.options ? cfg : (defaultStatusConfig(ids) as unknown as Json)) as unknown as Json
    case 'number': return numberConfig(cfg ?? {}) as unknown as Json
    case 'date':
    case 'created_time':
    case 'last_edited_time': return dateConfig(cfg ?? {}) as unknown as Json
    case 'people': return peopleConfig(cfg ?? {}) as unknown as Json
    case 'files': return filesConfig(cfg ?? {}) as unknown as Json
    case 'relation': return relationFieldConfig(cfg) as unknown as Json
    case 'rollup': return rollupConfig(cfg) as unknown as Json
    case 'formula': return formulaConfig(cfg) as unknown as Json
    case 'unique_id': return idConfig(cfg ?? {}) as unknown as Json
    case 'place': return placeConfig(cfg ?? {}) as unknown as Json
    case 'button': return buttonConfig(cfg) as unknown as Json
    case 'verification': return verificationConfig(cfg ?? {}) as unknown as Json
    case 'connected': return connectedConfig(cfg) as unknown as Json
    default: return (isObj(cfg) ? cfg : {}) as Json
  }
}

export const cfgOf = {
  select: (d: Definition) => selectConfig(d.config),
  status: (d: Definition) => statusConfig(d.config),
  number: (d: Definition) => numberConfig(d.config),
  date: (d: Definition) => dateConfig(d.config),
  people: (d: Definition) => peopleConfig(d.config),
  files: (d: Definition) => filesConfig(d.config),
  relation: (d: Definition) => relationFieldConfig(d.config),
  rollup: (d: Definition) => rollupConfig(d.config),
  formula: (d: Definition) => formulaConfig(d.config),
  id: (d: Definition) => idConfig(d.config),
  place: (d: Definition) => placeConfig(d.config),
  button: (d: Definition) => buttonConfig(d.config),
  verification: (d: Definition) => verificationConfig(d.config),
  connected: (d: Definition) => connectedConfig(d.config),
}

/** Options of a select-like definition (select, multi_select, status) in display order. */
export function optionsOf(d: Definition): SelectOption[] {
  if (d.kind === 'status') return statusConfig(d.config).options
  if (d.kind === 'select' || d.kind === 'multi_select') return selectConfig(d.config).options
  return []
}
