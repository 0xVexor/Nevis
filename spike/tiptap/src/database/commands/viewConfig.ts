// View configuration validators (handoff §17). Configurations are discriminated by View.type; property references must exist in
// the view's source and have a compatible kind. Switching layouts keeps compatible shared configuration (the rest is archived).
import type { Id, Json, ViewType } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import type { Draft } from './draft.ts'

type Obj = Record<string, Json>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

const ENUMS: Record<string, string[]> = {
  density: ['compact', 'normal', 'relaxed'],
  openMode: ['side_peek', 'center_peek', 'full_page'],
  groupMode: ['option', 'status_group', 'exact', 'prefix', 'day', 'week', 'month', 'year', 'relative', 'bucket'],
  cardSize: ['small', 'medium', 'large'],
  aspect: ['16:9', '4:3', '1:1', '3:4'],
  fit: ['cover', 'contain'],
  previewSource: ['cover', 'content', 'property', 'none'],
  calendarMode: ['month', 'week'],
  scale: ['hour', 'day', 'week', 'month', 'quarter', 'year'],
  chartType: ['bar_vertical', 'bar_horizontal', 'line', 'donut', 'number'],
  dependencyMode: ['none', 'shift_on_overlap', 'shift_preserving_gap'],
}

/** Which property kinds a config key may point at. */
const KIND_RULES: Record<string, string[]> = {
  groupPropertyId: ['select', 'multi_select', 'status', 'people', 'checkbox', 'relation', 'text', 'number', 'date', 'formula', 'rollup', 'created_by', 'url', 'email', 'phone'],
  subgroupPropertyId: ['select', 'multi_select', 'status', 'people', 'checkbox', 'relation', 'formula'],
  datePropertyId: ['date', 'formula', 'created_time', 'last_edited_time', 'rollup'],
  startPropertyId: ['date', 'formula', 'created_time'],
  endPropertyId: ['date', 'formula', 'created_time'],
  placePropertyId: ['place'],
  dependencyPropertyId: ['relation'],
  coverPropertyId: ['files'],
}

export function validateViewConfiguration(d: Draft, type: ViewType, sourceId: Id | null, cfg: Json): void {
  if (!isObj(cfg)) fail('INVALID_VALUE', 'view configuration must be an object')
  const c = cfg as Obj
  const props = sourceId ? new Map(d.props(sourceId).map((p) => [p.id, p])) : new Map()
  const need = (id: unknown, what: string, kinds?: string[]) => {
    if (typeof id !== 'string' || (sourceId && !props.has(id))) fail('SCHEMA_MISMATCH', `${what} refers to a property that is not in this source`, { propertyId: id as string })
    if (kinds && sourceId && !kinds.includes(props.get(id as string)!.kind)) fail('SCHEMA_MISMATCH', `${what} cannot use a ${props.get(id as string)!.kind} property`, { propertyId: id as string })
  }
  for (const [key, allowed] of Object.entries(ENUMS)) if (key in c && c[key] !== null && !allowed.includes(c[key] as string)) fail('INVALID_VALUE', `${key} must be one of ${allowed.join(', ')}`)
  for (const [key, kinds] of Object.entries(KIND_RULES)) if (key in c && c[key] !== null) need(c[key], key, kinds)
  if ('visibleProperties' in c) {
    if (!Array.isArray(c.visibleProperties)) fail('INVALID_VALUE', 'visibleProperties must be a list')
    for (const id of c.visibleProperties as Json[]) need(id, 'visibleProperties')
  }
  if ('frozenThrough' in c && c.frozenThrough !== null) need(c.frozenThrough, 'frozenThrough')
  if ('widths' in c) {
    if (!isObj(c.widths)) fail('INVALID_VALUE', 'widths must be an object')
    for (const [id, w] of Object.entries(c.widths as Obj)) {
      need(id, 'widths')
      if (typeof w !== 'number' || w < 80 || w > 1200) fail('INVALID_VALUE', 'column width must be within 80..1200')
    }
  }
  if ('totals' in c && isObj(c.totals)) for (const id of Object.keys(c.totals as Obj)) need(id, 'totals')
  if (type === 'timeline' && ('startPropertyId' in c) !== ('endPropertyId' in c)) fail('INVALID_VALUE', 'timeline needs both a start and an end property, or one range property')
  if (type === 'chart' && 'categoryPropertyId' in c && c.categoryPropertyId !== null) {
    need(c.categoryPropertyId, 'categoryPropertyId')
    const k = props.get(c.categoryPropertyId as string)?.kind
    if (k && ['button', 'files', 'unique_id', 'rollup'].includes(k)) fail('INVALID_VALUE', `a chart axis cannot use a ${k} property`)
  }
  if (type === 'dashboard' && 'rows' in c && !Array.isArray(c.rows)) fail('INVALID_VALUE', 'dashboard rows must be a list')
}
