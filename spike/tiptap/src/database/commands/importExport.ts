// CSV import and bundle restore as commands (handoff §27). Both are all-or-nothing: the whole input is validated before the batch
// is built, and a retried import session never duplicates rows.
import type { Id, Json, RecordKind } from '../model/types.ts'
import { RECORD_KINDS } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { keyBetween } from '../model/ids.ts'
import { validateBundle, remapIds, type Bundle } from '../backup2.ts'
import { collectNewOptions, planImport, type ImportOptions, type ImportWorld } from '../csv.ts'
import { register, type Ctx } from './coordinator.ts'
import { addEdge } from './relations.ts'
import { createRow } from './rows.ts'
import { source } from './util.ts'
import type { Draft } from './draft.ts'
import type { Cell } from '../model/types.ts'

const draftWorld = (d: Draft): ImportWorld => ({
  props: (s) => d.props(s), row: (id) => d.row(id), relationOf: (id) => d.relationOf(id),
  titlesIn: (s) => d.rowsOf(s).map((r) => ({ id: r.page.id, title: r.page.title })),
})

register('csv.import', (cx: Ctx, p: { data: string[][]; options: ImportOptions }) => {
  const o = p.options
  const evId = `import:${o.sessionId}`
  const done = cx.d.get('event', evId)
  if (done) return { ...(done.data as Record<string, Json>), repeated: true } // same session: nothing is created twice
  const src = source(cx, o.sourceId)
  cx.access.assertSource(cx.env.actorId, src.id, 'create')
  if (o.createOptions) {
    const fresh = collectNewOptions(draftWorld(cx.d), p.data, o)
    for (const [pid, labels] of Object.entries(fresh)) {
      cx.access.assertSource(cx.env.actorId, src.id, 'edit_schema')
      const m = cx.d.mut('property', pid)
      const cfg = m.config as unknown as { options: { id: Id; name: string; color: string; sortKey: string; statusGroupId?: Id }[]; groups?: { id: Id; semantic: string }[] }
      let key = cfg.options.length ? cfg.options[cfg.options.length - 1].sortKey : null
      for (const l of labels) {
        key = keyBetween(key, null)
        cfg.options.push({ id: cx.ids(), name: l, color: 'default', sortKey: key, ...(m.kind === 'status' ? { statusGroupId: cfg.groups!.find((g) => g.semantic === 'todo')!.id } : {}) })
      }
    }
  }
  const plan = planImport(draftWorld(cx.d), p.data, o)
  if (plan.problems.length && !o.skipInvalid) fail('INVALID_VALUE', `${plan.problems.length} problem(s) in the file; nothing was imported`, { problems: plan.problems as unknown as Json })
  const created: Id[] = []
  const updated: Id[] = []
  for (const row of plan.rows) {
    const values: Record<Id, Cell> = {}
    for (const [pid, c] of Object.entries(row.cells)) if (c) values[pid] = c
    let pageId: Id
    const existing = row.pageId && o.upsertBy === 'page_id' ? cx.d.row(row.pageId) : undefined
    if (existing) {
      if (existing.sourceId !== src.id) fail('SCHEMA_MISMATCH', 'the id belongs to another source', { pageId: row.pageId })
      cx.access.assertRow(cx.env.actorId, existing, 'edit_rows')
      const pg = cx.d.mutPage(existing.page.id)
      if (row.title) pg.title = row.title
      for (const [pid, c] of Object.entries(row.cells)) {
        if (c === null) delete pg.database!.cells[pid]
        else pg.database!.cells[pid] = { value: c, stamp: cx.stamp() }
      }
      pageId = pg.id
      updated.push(pageId)
    } else {
      if (row.pageId && cx.d.page(row.pageId)) fail('INVALID_VALUE', 'id collision with different content', { pageId: row.pageId })
      pageId = createRow(cx, { id: row.pageId, sourceId: src.id, title: row.title, explicitValues: values }).pageId
      created.push(pageId)
    }
    for (const [pid, targets] of Object.entries(row.relations)) {
      const def = cx.d.prop(pid)!
      const rel = cx.d.relationOf(pid)
      if (!rel || !def) continue
      for (const t of targets) addEdge(cx, rel, pageId, t, false)
    }
  }
  const result = { created: created.length, updated: updated.length, pageIds: created, problems: plan.problems.length }
  cx.d.add('event', { ...cx.meta(evId), type: 'audit', pageId: null, principalId: cx.env.actorId, data: { kind: 'import', sessionId: o.sessionId, ...result } as unknown as Json })
  return result as unknown as Json
})

// ───── restore ─────

/** Records that are never replaced by a restore when current grants are retained (security state is not rolled back). */
const SECURITY_KINDS: RecordKind[] = ['principal', 'grant']

register('backup.restore', (cx, p: { bundle: Bundle; expectedManifestHash: string; mode: 'replace' | 'merge'; retainCurrentGrants?: boolean; pageIds?: Id[] }) => {
  const problems = validateBundle(p.bundle, { pageIds: p.pageIds ? new Set(p.pageIds) : undefined }).filter((x) => x.severity === 'error')
  if (problems.length) fail('INVALID_VALUE', `the backup is not valid (${problems[0].detail}); nothing was changed`, { problems: problems.slice(0, 20) as unknown as Json })
  if (p.bundle.manifestHash !== p.expectedManifestHash) fail('INVALID_VALUE', 'the backup changed after it was previewed')
  const retain = p.retainCurrentGrants !== false
  let records = p.bundle.records
  if (p.mode === 'replace') {
    for (const kind of RECORD_KINDS) {
      if (retain && SECURITY_KINDS.includes(kind)) continue
      for (const r of cx.d.all(kind)) cx.d.purge(kind, r.id)
    }
  } else {
    // merge: ids that already exist are remapped consistently everywhere they are referenced
    const taken = new Set<Id>()
    for (const kind of RECORD_KINDS) for (const r of cx.d.all(kind)) taken.add(r.id)
    const map = new Map<Id, Id>()
    for (const kind of RECORD_KINDS) for (const r of (records[kind] ?? []) as unknown as { id: Id }[]) if (taken.has(r.id)) map.set(r.id, cx.ids())
    if (map.size) records = remapIds(records, map)
  }
  let n = 0
  for (const kind of RECORD_KINDS) {
    if (p.mode === 'replace' && retain && SECURITY_KINDS.includes(kind)) {
      // keep current security state; add only principals / grants that do not exist yet so references from restored data resolve
      for (const r of (records[kind] ?? []) as unknown as { id: Id }[]) if (!cx.d.get(kind, r.id)) { cx.d.add(kind, structuredClone(r) as never); n++ }
      continue
    }
    for (const r of (records[kind] ?? []) as unknown as { id: Id }[]) { cx.d.add(kind, structuredClone(r) as never); n++ }
  }
  return { restored: n }
})
