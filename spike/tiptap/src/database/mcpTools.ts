// Read access to databases for AI clients (MCP): which databases exist, their properties, and their rows as plain values.
// Every database belongs to a host page; the connection's document scope decides, so a hidden page hides its databases.
import type { DatabaseService } from './service.ts'
import type { Definition, Id } from './model/types.ts'
import type { QValue } from './query/values.ts'
import type { DatabaseRowSpec, DatabaseToolHost } from '../documents/databaseHost.ts'

const fail = (code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'STALE_CURSOR' | 'ACCESS_DENIED' | 'LIMIT_EXCEEDED', field?: string): never => { throw { code, ...(field ? { field } : {}) } }

const MAX_ROWS = 100
const text = (value: string, max = 1024) => value.length > max ? value.slice(0, max) : value

/** One QValue as JSON a model can read: option and page names come from the resolver, dates keep their native shape. */
export function plainValue(value: QValue | undefined, optionNames?: Map<string, string>): unknown {
  if (!value) return null
  switch (value.c) {
    case 'empty': return null
    case 'text': return text(value.text, 4096)
    case 'number': return value.n
    case 'bool': return value.b
    case 'date': return value.v
    case 'members': return optionNames ? value.ids.map(id => optionNames.get(id) ?? id) : value.ids
    case 'list': return value.items.map(item => plainValue(item, optionNames))
    default: return null
  }
}

/** Kinds an AI client may create: plain values only, no formulas, relations or connected accounts. */
const WRITABLE_KINDS = new Set(['text', 'number', 'checkbox', 'select', 'multi_select', 'url', 'email', 'phone', 'date'])
const ID = /^[A-Za-z0-9_-]{1,128}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

/** One plain JSON value to the typed cell a property of that kind stores. Unknown option names are refused, never invented. */
function cellFor(def: Definition, value: unknown): unknown {
  if (value === null) return def.kind === 'select' ? { kind: 'select', optionId: null } : def.kind === 'number' ? { kind: 'number', value: null } : def.kind === 'date' ? { kind: 'date', value: null } : fail('INVALID_ARGUMENT', `values.${def.kind}`)
  const optionId = (name: unknown) => {
    const found = ((def.config as { options?: { id: string; name: string }[] } | null)?.options ?? []).find(option => typeof name === 'string' && option.name.toLowerCase() === name.toLowerCase())
    return found ? found.id : fail('INVALID_ARGUMENT', `values.${def.kind}`)
  }
  switch (def.kind) {
    case 'text': return typeof value === 'string' && value.length <= 10000 ? { kind: 'text', runs: [{ text: value }] } : fail('INVALID_ARGUMENT', `values.${def.kind}`)
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? { kind: 'number', value } : fail('INVALID_ARGUMENT', `values.${def.kind}`)
    case 'checkbox': return typeof value === 'boolean' ? { kind: 'checkbox', value } : fail('INVALID_ARGUMENT', `values.${def.kind}`)
    case 'select': return { kind: 'select', optionId: optionId(value) }
    case 'multi_select': return Array.isArray(value) && value.length <= 50 ? { kind: 'multi_select', optionIds: value.map(optionId) } : fail('INVALID_ARGUMENT', `values.${def.kind}`)
    case 'url': case 'email': case 'phone': return typeof value === 'string' && value.length <= 2048 ? { kind: def.kind, value } : fail('INVALID_ARGUMENT', `values.${def.kind}`)
    case 'date':
      if (typeof value !== 'string') return fail('INVALID_ARGUMENT', `values.${def.kind}`)
      if (DATE.test(value)) return { kind: 'date', value: { kind: 'date', start: value, end: null } }
      return DATETIME.test(value) ? { kind: 'date', value: { kind: 'datetime', start: value, end: null, timeZone: null } } : fail('INVALID_ARGUMENT', `values.${def.kind}`)
    default: return fail('INVALID_ARGUMENT', `values.${def.kind}`)
  }
}

export function createDatabaseTools(open: () => Promise<DatabaseService>): DatabaseToolHost {
  const hostOf = (svc: DatabaseService, sourceId: Id) => {
    const source = svc.state.get('source', sourceId)
    const container = source && svc.state.get('container', source.ownerContainerId)
    return source && container ? { source, container } : null
  }
  const options = (def: Definition) => {
    const list = (def.config as { options?: { id: string; name: string }[] } | null)?.options
    return Array.isArray(list) ? list.slice(0, 200).map(option => ({ optionId: option.id, name: text(String(option.name), 512) })) : undefined
  }
  const property = (def: Definition) => ({ propertyId: def.id, name: text(def.name, 512), kind: def.kind, ...(options(def) ? { options: options(def) } : {}) })
  const allowed = (svc: DatabaseService, sourceId: Id, canRead: (id: string) => boolean) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceId)) fail('INVALID_ARGUMENT')
    const found = hostOf(svc, sourceId)
    if (!found) return fail('NOT_FOUND')
    if (!canRead(found.container.hostPageId)) return fail('NOT_FOUND') // same answer as a missing one: never confirm hidden databases
    return found
  }
  return {
    async list(canRead) {
      const svc = await open()
      const databases = svc.state.live('source').flatMap(source => {
        const found = hostOf(svc, source.id)
        if (!found || !canRead(found.container.hostPageId)) return []
        return [{ sourceId: source.id, name: text(source.name), documentId: found.container.hostPageId, presentation: found.container.presentation, rowCount: svc.query(source.id, { limit: 1 }).total }]
      })
      return { databases: databases.slice(0, 100) }
    },
    async describe(sourceId, canRead) {
      const svc = await open()
      const { source, container } = allowed(svc, sourceId, canRead)
      return { sourceId: source.id, name: text(source.name), documentId: container.hostPageId, properties: svc.state.props(source.id).slice(0, 200).map(property) }
    },
    async rows(input, canRead) {
      const svc = await open()
      const { source } = allowed(svc, input.sourceId, canRead)
      const limit = input.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) fail('INVALID_ARGUMENT')
      const defs = svc.state.props(source.id).slice(0, 200)
      let result
      try { result = svc.query(source.id, { limit, projection: defs.filter(def => def.kind !== 'title').map(def => def.id), ...(input.cursor ? { cursor: input.cursor } : {}) }) } catch { return fail('STALE_CURSOR') }
      const names = new Map(defs.map(def => [def.id, new Map((options(def) ?? []).map(option => [option.optionId, option.name]))]))
      const rows = result.rows.filter(row => !row.context).map(row => ({
        pageId: row.pageId,
        title: text(svc.state.row(row.pageId)?.page.title ?? ''),
        values: Object.fromEntries(defs.filter(def => def.kind !== 'title').map(def => [def.id, plainValue(row.values[def.id], names.get(def.id))])),
      }))
      return { sourceId: source.id, properties: defs.map(property), rows, total: result.total, nextCursor: result.nextCursor, truncated: result.nextCursor !== null }
    },
    async createDatabase(input, access) {
      const svc = await open()
      const { operationId, parentId, title } = input
      const properties = input.properties ?? [], rows = input.rows ?? []
      if (!ID.test(operationId) || operationId.length > 100) fail('INVALID_ARGUMENT', 'operationId')
      if (typeof title !== 'string' || !title.trim()) fail('INVALID_ARGUMENT', 'title')
      if (properties.length > 30) fail('LIMIT_EXCEEDED', 'properties')
      if (rows.length > 100) fail('LIMIT_EXCEEDED', 'rows')
      if (new Set(properties.map(p => p.name.trim().toLowerCase())).size !== properties.length || properties.some(p => !p.name.trim() || !WRITABLE_KINDS.has(p.kind))) fail('INVALID_ARGUMENT', 'properties')
      if (!access.canCreate(parentId)) fail('ACCESS_DENIED')
      try {
        // Each step has its own derived operation id, so repeating the whole call finishes or replays it instead of duplicating.
        const created = await svc.one<{ sourceId: Id; hostPageId: Id }>('database.create', { parentPageId: parentId, title: title.trim(), presentation: 'full' }, { operationId: `${operationId}:db` })
        for (const [index, spec] of properties.entries()) {
          await svc.one('property.create', { sourceId: created.sourceId, name: spec.name.trim(), kind: spec.kind, ...(spec.options ? { config: { options: spec.options.map(name => ({ name })) } } : {}) }, { operationId: `${operationId}:p${index}` })
        }
        const rowIds = rows.length ? await insertRows(svc, created.sourceId, rows, `${operationId}:rows`) : []
        const defs = svc.state.props(created.sourceId).slice(0, 200)
        // pageId, not documentId: the new page is in scope by construction (made under an allowed parent) and may not be in the scope snapshot yet
        return { sourceId: created.sourceId, pageId: created.hostPageId, properties: defs.map(property), rowIds }
      } catch (error) { return rethrow(error) }
    },
    async addRows(input, access) {
      const svc = await open()
      if (!ID.test(input.sourceId)) fail('INVALID_ARGUMENT', 'sourceId')
      if (!ID.test(input.operationId) || input.operationId.length > 100) fail('INVALID_ARGUMENT', 'operationId')
      if (input.rows.length > 100) fail('LIMIT_EXCEEDED', 'rows')
      const found = hostOf(svc, input.sourceId)
      if (!found || !access.canRead(found.container.hostPageId)) return fail('NOT_FOUND')
      if (!access.canWrite(found.container.hostPageId)) return fail('ACCESS_DENIED')
      try { return { sourceId: input.sourceId, rowIds: await insertRows(svc, input.sourceId, input.rows, input.operationId) } } catch (error) { return rethrow(error) }
    },
  }

  /** Rows keyed by property name or id; one commit, so a bad value rejects the whole batch. */
  async function insertRows(svc: DatabaseService, sourceId: Id, rows: DatabaseRowSpec[], operationId: string): Promise<string[]> {
    const defs = svc.state.props(sourceId)
    const find = (key: string) => defs.find(def => def.id === key) ?? defs.find(def => def.name.toLowerCase() === key.toLowerCase())
    const commands = rows.map(row => {
      const explicitValues: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row.values ?? {})) {
        const def = find(key)
        if (!def || def.kind === 'title' || !WRITABLE_KINDS.has(def.kind)) fail('INVALID_ARGUMENT', 'values')
        explicitValues[def!.id] = cellFor(def!, value)
      }
      return { type: 'row.create', payload: { sourceId, title: String(row.title ?? '').slice(0, 1024), explicitValues } as never }
    })
    if (!commands.length) return []
    const commit = await svc.exec(commands, { operationId })
    const results = (commands.length === 1 ? [commit.result] : commit.result) as { pageId: string }[]
    return results.map(result => result.pageId)
  }
}

/** Database errors keep their text out of tool results; only the bounded code leaves. */
function rethrow(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && ['NOT_FOUND', 'INVALID_ARGUMENT', 'ACCESS_DENIED', 'LIMIT_EXCEEDED'].includes((error as { code: string }).code)) throw error
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  throw { code: code === 'QUOTA' ? 'LIMIT_EXCEEDED' : code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_ARGUMENT', field: `database:${code || 'error'}` }
}
