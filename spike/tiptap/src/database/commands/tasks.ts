// Sub-items, dependencies, task mode and sprints (handoff §19).
import type { Cell, DateValue, Definition, Id, Json } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { addDays, dateInterval, diffDays, isCivil, weekdayOf, toIso } from '../dates.ts'
import { statusConfig } from '../props/config.ts'
import { register } from './coordinator.ts'
import { createProperty } from './schema.ts'
import { createRow } from './rows.ts'
import { property, source } from './util.ts'
import type { Draft } from './draft.ts'

export type DependencyMode = 'none' | 'shift_on_overlap' | 'shift_preserving_gap'
export type TaskSettings = {
  subItems?: boolean
  taskMode?: { statusPropertyId: Id; assigneePropertyId: Id | null; datePropertyId: Id }
  dependency?: { relationPropertyId: Id; datePropertyId: Id; mode: DependencyMode; avoidWeekends: boolean; weekendDays: number[] }
  sprint?: { sprintSourceId: Id; relationPropertyId: Id; durationWeeks: number; startDay: number; unfinished: 'next' | 'backlog' | 'stay' }
}

export const settingsOf = (d: Draft, sourceId: Id): Record<string, Json> => (d.get('source', sourceId)?.settings ?? {}) as Record<string, Json>

register('source.configure_tasks', (cx, p: { sourceId: Id; subItems?: boolean; taskMode?: TaskSettings['taskMode'] | null; dependency?: TaskSettings['dependency'] | null }) => {
  const s = source(cx, p.sourceId)
  cx.access.assertSource(cx.env.actorId, s.id, 'edit_schema')
  const m = cx.d.mut('source', s.id)
  const st = { ...(m.settings as Record<string, Json>) }
  if (p.subItems !== undefined) st.subItems = p.subItems // turning it off keeps stored parent links; children are shown flat
  if (p.taskMode !== undefined) {
    if (p.taskMode === null) delete st.taskMode
    else {
      const status = property(cx, p.taskMode.statusPropertyId)
      const date = property(cx, p.taskMode.datePropertyId)
      if (status.kind !== 'status' || status.sourceId !== s.id) fail('SCHEMA_MISMATCH', 'task mode needs a Status property')
      if (date.kind !== 'date' || date.sourceId !== s.id) fail('SCHEMA_MISMATCH', 'task mode needs a Date property')
      if (p.taskMode.assigneePropertyId) {
        const a = property(cx, p.taskMode.assigneePropertyId)
        if (a.kind !== 'people' || a.sourceId !== s.id) fail('SCHEMA_MISMATCH', 'the assignee must be a People property')
      }
      st.taskMode = p.taskMode as unknown as Json
    }
  }
  if (p.dependency !== undefined) {
    if (p.dependency === null) { delete st.dependency; delete st.dependencyRelationId }
    else {
      const rp = property(cx, p.dependency.relationPropertyId)
      const rel = rp.kind === 'relation' ? cx.d.relationOf(rp.id) : undefined
      if (!rel || rel.sourceId !== s.id || rel.targetSourceId !== s.id) fail('SCHEMA_MISMATCH', 'dependencies need a self-relation')
      const dp = property(cx, p.dependency.datePropertyId)
      if (dp.kind !== 'date' || dp.sourceId !== s.id) fail('SCHEMA_MISMATCH', 'dependencies need a Date property')
      for (const e of cx.d.live('edge')) if (e.definitionId === rel!.id && e.fromPageId === e.toPageId) fail('CYCLE', 'existing self-links must be removed before this becomes a dependency')
      st.dependency = { ...p.dependency, weekendDays: p.dependency.weekendDays ?? [5] } as unknown as Json
      st.dependencyRelationId = rel!.id
    }
  }
  m.settings = st as Json
})

// ───── dependency date shifting ─────

export type Shift = { pageId: Id; before: DateValue; after: DateValue }

const finishOf = (v: DateValue) => (v.kind === 'date' ? (v.end ?? v.start) : (v.end ?? v.start))

function isWeekend(civil: string, days: number[]) {
  return days.includes(weekdayOf(civil))
}
function nextWorkday(civil: string, days: number[]) {
  let c = civil
  for (let i = 0; i < 7 && isWeekend(c, days); i++) c = addDays(c, 1)
  return c
}

function moveCivil(v: Extract<DateValue, { kind: 'date' }>, newStart: string): DateValue {
  const span = v.end ? diffDays(v.end, v.start) : 0
  return { kind: 'date', start: newStart, end: v.end ? addDays(newStart, span) : null }
}

/**
 * Propose the date changes caused by moving one item (§19). Blockers constrain their blocked items; multiple blockers use the
 * latest requirement and never shift earlier than another blocker allows. Pure: callers apply the result in one batch.
 */
export function planDependencyShift(d: Pick<Draft, 'get' | 'edgesOut' | 'edgesIn' | 'row'>, sourceId: Id, moved: Id, newValue: DateValue, zone: string): Shift[] {
  const src = d.get('source', sourceId)!
  const dep = (src.settings as { dependency?: NonNullable<TaskSettings['dependency']>; dependencyRelationId?: Id }).dependency
  const relId = (src.settings as { dependencyRelationId?: Id }).dependencyRelationId
  if (!dep || !relId || dep.mode === 'none') return []
  const dateId = dep.datePropertyId
  const current = new Map<Id, DateValue>()
  const valueOf = (id: Id): DateValue | null => current.get(id) ?? (d.row(id)?.ext.cells[dateId]?.value as Extract<Cell, { kind: 'date' }> | undefined)?.value ?? null
  const original = new Map<Id, DateValue | null>()
  const before = (id: Id) => (original.has(id) ? original.get(id)! : (original.set(id, valueOf(id)), original.get(id)!))
  before(moved)
  // gap between a blocker's finish and a blocked item's start, measured before the move (civil days or exact ms)
  const gapOf = (blocker: Id, blocked: Id): number => {
    const a = before(blocker)
    const b = before(blocked)
    if (!a || !b) return 0
    if (a.kind === 'date' && b.kind === 'date') return diffDays(b.start, finishOf(a) as string) - 1
    return dateInterval(b, zone).s - dateInterval(a, zone).e
  }
  const gaps = new Map<string, number>()
  const gapKey = (a: Id, b: Id) => `${a}>${b}`
  // pre-compute gaps with the ORIGINAL values before any change is visible
  const queue: Id[] = [moved]
  const seen = new Set<Id>([moved])
  const topo: Id[] = []
  while (queue.length) {
    const n = queue.shift()!
    topo.push(n)
    for (const e of d.edgesOut(relId, n)) {
      gaps.set(gapKey(n, e.toPageId), gapOf(n, e.toPageId))
      if (!seen.has(e.toPageId)) (seen.add(e.toPageId), queue.push(e.toPageId))
    }
  }
  current.set(moved, newValue)
  const shifts: Shift[] = []
  const visited = new Set<Id>([moved])
  // process in dependency order: an item is handled after all its (reachable) blockers
  const indeg = new Map<Id, number>()
  for (const n of topo) for (const e of d.edgesOut(relId, n)) indeg.set(e.toPageId, (indeg.get(e.toPageId) ?? 0) + 1)
  const ready = [moved]
  const done = new Set<Id>()
  while (ready.length) {
    const blocker = ready.shift()!
    done.add(blocker)
    for (const e of d.edgesOut(relId, blocker)) {
      const child = e.toPageId
      indeg.set(child, (indeg.get(child) ?? 1) - 1)
      if ((indeg.get(child) ?? 0) > 0) continue
      const cur = before(child)
      if (cur) {
        // required start from every blocker that is part of the changed subgraph (others keep their original finish)
        let need: number | string | null = null
        for (const be of d.edgesIn(relId, child)) {
          const bv = valueOf(be.fromPageId)
          if (!bv) continue
          if (cur.kind === 'date' && bv.kind === 'date') {
            const gap = dep.mode === 'shift_preserving_gap' && gaps.has(gapKey(be.fromPageId, child)) ? gaps.get(gapKey(be.fromPageId, child))! : 0
            const want = addDays(finishOf(bv) as string, 1 + Math.max(0, gap))
            need = need === null || want > (need as string) ? want : need
          } else {
            const gap = dep.mode === 'shift_preserving_gap' && gaps.has(gapKey(be.fromPageId, child)) ? gaps.get(gapKey(be.fromPageId, child))! : 0
            const want = dateInterval(bv, zone).e + Math.max(0, gap)
            need = need === null || want > (need as number) ? want : need
          }
        }
        if (need !== null) {
          let next: DateValue = cur
          if (cur.kind === 'date') {
            let ns = need as string
            const curStart = cur.start
            // shift_on_overlap only ever moves later; preserving-gap may also pull earlier when the blocker moved earlier
            if (dep.mode === 'shift_on_overlap' && ns <= curStart) ns = curStart
            if (dep.avoidWeekends) ns = nextWorkday(ns, dep.weekendDays)
            next = moveCivil(cur, ns)
          } else {
            const startMs = dateInterval(cur, zone).s
            let ns = need as number
            if (dep.mode === 'shift_on_overlap' && ns <= startMs) ns = startMs
            const dur = cur.end ? dateInterval(cur, zone).e - startMs : 0
            next = { kind: 'datetime', start: toIso(ns), end: cur.end ? toIso(ns + dur) : null, timeZone: cur.timeZone }
          }
          current.set(child, next)
          if (JSON.stringify(next) !== JSON.stringify(cur)) shifts.push({ pageId: child, before: cur, after: next })
        }
      }
      if (!visited.has(child)) (visited.add(child), ready.push(child))
    }
  }
  return shifts
}

register('date.shift', (cx, p: { pageId: Id; datePropertyId: Id; value: DateValue; approve?: boolean; zone?: string }) => {
  const row = cx.d.row(p.pageId)
  if (!row) fail('NOT_FOUND', 'row not found')
  cx.access.assertRow(cx.env.actorId, row!, 'edit_rows')
  const def = property(cx, p.datePropertyId)
  if (def.kind !== 'date') fail('INVALID_VALUE', 'date.shift needs a Date property (a computed date cannot shift dependencies)')
  const shifts = planDependencyShift(cx.d, row!.sourceId, p.pageId, p.value, p.zone ?? 'UTC')
  const dep = (settingsOf(cx.d, row!.sourceId).dependency as { datePropertyId?: Id } | undefined)
  const applies = dep?.datePropertyId === def.id
  if (applies && shifts.length > 20 && !p.approve) fail('INVALID_VALUE', `this move shifts ${shifts.length} items; preview and approve it first`, { count: shifts.length })
  const set = (pageId: Id, v: DateValue) => {
    const pg = cx.d.mutPage(pageId)
    cx.access.assertEditProperty(cx.env.actorId, def, { page: pg, ext: pg.database!, sourceId: pg.database!.sourceId })
    pg.database!.cells[def.id] = { value: { kind: 'date', value: v }, stamp: cx.stamp() }
  }
  set(p.pageId, p.value)
  if (applies) for (const s of shifts) set(s.pageId, s.after)
  return { shifted: applies ? shifts.length : 0 }
})

// ───── sprints ─────

const LIFECYCLE = ['current', 'next', 'last', 'past'] as const

register('sprint.enable', (cx, p: { tasksSourceId: Id; durationWeeks?: number; startDay?: number; unfinished?: 'next' | 'backlog' | 'stay' }) => {
  const tasks = source(cx, p.tasksSourceId)
  cx.access.assertSource(cx.env.actorId, tasks.id, 'edit_schema')
  if ((tasks.settings as { sprint?: unknown }).sprint) fail('INVALID_VALUE', 'sprints are already enabled for this source')
  const weeks = p.durationWeeks ?? 2
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 8) fail('INVALID_VALUE', 'a sprint lasts 1-8 weeks')
  const startDay = p.startDay ?? 6
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 7) fail('INVALID_VALUE', 'startDay is an ISO weekday 1-7')
  const container = cx.d.get('container', tasks.ownerContainerId)!
  const sid = cx.ids()
  const tid = cx.ids()
  cx.d.add('source', { ...cx.meta(sid), ownerContainerId: container.id, name: `${tasks.name} sprints`, schemaRevision: 1, titlePropertyId: tid, defaultTemplateId: null, layout: {}, settings: { sprintOf: tasks.id } })
  cx.d.add('property', { ...cx.meta(tid), sourceId: sid, name: 'Name', description: '', kind: 'title', sortKey: 'V', config: {} })
  const mc = cx.d.mut('container', container.id)
  mc.sourceLinks.push({ sourceId: sid, sortKey: 'z' + mc.sourceLinks.length })
  const dates = createProperty(cx, { sourceId: sid, name: 'Dates', kind: 'date' })
  const life = createProperty(cx, { sourceId: sid, name: 'Lifecycle', kind: 'select', config: { options: LIFECYCLE.map((n) => ({ name: n })) } })
  const seq = createProperty(cx, { sourceId: sid, name: 'Sequence', kind: 'number' })
  const created = cx.d.add('relation', { ...cx.meta(), propertyId: '', sourceId: tasks.id, targetSourceId: sid, mode: 'paired', inversePropertyId: null, cardinality: 'one', inverseCardinality: 'many', displayedPropertyIds: [] })
  const fwd = createProperty(cx, { sourceId: tasks.id, name: 'Sprint', kind: 'text' })
  const inv = createProperty(cx, { sourceId: sid, name: 'Tasks', kind: 'text' })
  const mf = cx.d.mut('property', fwd.id)
  mf.kind = 'relation'
  mf.config = { definitionId: created.id, side: 'forward' }
  const mi = cx.d.mut('property', inv.id)
  mi.kind = 'relation'
  mi.config = { definitionId: created.id, side: 'inverse' }
  const cr = cx.d.mut('relation', created.id)
  cr.propertyId = fwd.id
  cr.inversePropertyId = inv.id
  const mt = cx.d.mut('source', tasks.id)
  mt.settings = { ...(mt.settings as Record<string, Json>), sprint: { sprintSourceId: sid, relationPropertyId: fwd.id, durationWeeks: weeks, startDay, unfinished: p.unfinished ?? 'next', datesPropertyId: dates.id, lifecyclePropertyId: life.id, sequencePropertyId: seq.id } as Json }
  return { sprintSourceId: sid, relationPropertyId: fwd.id }
})

register('sprint.rotate', (cx, p: { tasksSourceId: Id; today: string }) => {
  const tasks = source(cx, p.tasksSourceId)
  const cfg = (tasks.settings as { sprint?: Record<string, Json> }).sprint
  if (!cfg) fail('INVALID_VALUE', 'sprints are not enabled')
  if (!isCivil(p.today)) fail('INVALID_VALUE', 'today must be a civil date')
  const sid = cfg!.sprintSourceId as Id
  const datesId = cfg!.datesPropertyId as Id
  const lifeId = cfg!.lifecyclePropertyId as Id
  const seqId = cfg!.sequencePropertyId as Id
  const weeks = cfg!.durationWeeks as number
  const days = weeks * 7
  const lifeDef = property(cx, lifeId)
  const lifeOpt = (name: string) => (lifeDef.config as unknown as { options: { id: Id; name: string }[] }).options.find((o) => o.name === name)!.id
  const range = (r: { page: { id: Id }; ext: { cells: Record<Id, { value: Cell }> } }) => {
    const v = (r.ext.cells[datesId]?.value as Extract<Cell, { kind: 'date' }> | undefined)?.value
    return v && v.kind === 'date' ? { start: v.start, end: v.end ?? v.start } : null
  }
  let sprints = cx.d.rowsOf(sid).map((r) => ({ r, rg: range(r), seq: (r.ext.cells[seqId]?.value as { value: number } | undefined)?.value ?? 0 })).filter((x) => x.rg).sort((a, b) => a.rg!.start.localeCompare(b.rg!.start))
  const makeSprint = (start: string, n: number) => {
    const end = addDays(start, days - 1)
    createRow(cx, {
      sourceId: sid, title: `Sprint ${n}`,
      explicitValues: { [datesId]: { kind: 'date', value: { kind: 'date', start, end } }, [seqId]: { kind: 'number', value: n } },
    })
  }
  // create the sprints needed so that one covers today and one follows it (each sequence number exactly once)
  const latest = () => sprints[sprints.length - 1]
  if (!sprints.length) {
    const wd = weekdayOf(p.today)
    const back = (wd - (cfg!.startDay as number) + 7) % 7
    makeSprint(addDays(p.today, -back), 1)
    sprints = cx.d.rowsOf(sid).map((r) => ({ r, rg: range(r), seq: (r.ext.cells[seqId]?.value as { value: number } | undefined)?.value ?? 0 })).sort((a, b) => a.rg!.start.localeCompare(b.rg!.start))
  }
  for (let guard = 0; guard < 500; guard++) {
    const last = latest()
    if (last.rg!.end >= p.today && sprints.some((x) => x.rg!.start > p.today)) break
    const start = addDays(last.rg!.end, 1)
    makeSprint(start, last.seq + 1)
    sprints = cx.d.rowsOf(sid).map((r) => ({ r, rg: range(r), seq: (r.ext.cells[seqId]?.value as { value: number } | undefined)?.value ?? 0 })).sort((a, b) => a.rg!.start.localeCompare(b.rg!.start))
  }
  // lifecycle is derived from dates, so rotating twice is a no-op
  const current = sprints.find((x) => x.rg!.start <= p.today && p.today <= x.rg!.end)
  const nextS = sprints.find((x) => x.rg!.start > p.today)
  const lastS = [...sprints].reverse().find((x) => x.rg!.end < p.today)
  const wasCurrent = sprints.filter((x) => (x.r.ext.cells[lifeId]?.value as { optionId: Id } | undefined)?.optionId === lifeOpt('current')).map((x) => x.r.page.id)
  let moved = 0
  for (const x of sprints) {
    const name = x === current ? 'current' : x === nextS ? 'next' : x === lastS ? 'last' : 'past'
    const want = lifeOpt(name)
    const pg = cx.d.mutPage(x.r.page.id)
    const have = (pg.database!.cells[lifeId]?.value as { optionId: Id } | undefined)?.optionId
    if (have !== want) pg.database!.cells[lifeId] = { value: { kind: 'select', optionId: want }, stamp: cx.stamp() }
  }
  // sprints that just ended hand their unfinished tasks over according to the setting
  const policy = cfg!.unfinished as string
  const relProp = property(cx, cfg!.relationPropertyId as Id)
  const rel = cx.d.relationOf(relProp.id)!
  const doneIds = statusDoneOptionIds(cx.d, tasks.id)
  for (const pid of wasCurrent) {
    const s = sprints.find((x) => x.r.page.id === pid)
    if (!s || s === current || policy === 'stay') continue
    for (const e of cx.d.edgesIn(rel.id, pid)) {
      const task = cx.d.row(e.fromPageId)
      if (!task) continue
      const status = task.ext.cells[statusIdOf(cx.d, tasks.id)]?.value as { optionId?: Id } | undefined
      const finished = status?.optionId ? doneIds.has(status.optionId) : false
      if (finished) continue
      cx.d.mut('edge', e.id).deletedAt = cx.now
      moved++
      if (policy === 'next' && current) {
        const target = current.r.page.id
        cx.d.add('edge', { ...cx.meta(), definitionId: rel.id, fromPageId: task.page.id, toPageId: target, sortKey: 'V', stamp: cx.stamp() })
      }
    }
  }
  return { current: current?.r.page.id ?? null, next: nextS?.r.page.id ?? null, last: lastS?.r.page.id ?? null, movedTasks: moved }
})

function statusIdOf(d: Draft, sourceId: Id): Id {
  const st = d.props(sourceId).find((p) => p.kind === 'status')
  return st?.id ?? ''
}
function statusDoneOptionIds(d: Draft, sourceId: Id): Set<Id> {
  const st = d.props(sourceId).find((p: Definition) => p.kind === 'status')
  if (!st) return new Set()
  const cfg = statusConfig(st.config)
  const complete = new Set(cfg.groups.filter((g) => g.semantic === 'complete').map((g) => g.id))
  return new Set(cfg.options.filter((o) => complete.has(o.statusGroupId)).map((o) => o.id))
}

register('sprint.disable', (cx, p: { tasksSourceId: Id; mode: 'keep' | 'remove' }) => {
  const tasks = source(cx, p.tasksSourceId)
  cx.access.assertSource(cx.env.actorId, tasks.id, 'edit_schema')
  const m = cx.d.mut('source', tasks.id)
  const st = { ...(m.settings as Record<string, Json>) }
  const cfg = st.sprint as Record<string, Json> | undefined
  if (!cfg) return
  delete st.sprint
  m.settings = st as Json
  if (p.mode === 'remove') {
    // destructive removal is explicit; the default keeps the sprint data as ordinary databases
    cx.d.mut('source', cfg.sprintSourceId as Id).deletedAt = cx.now
    const rp = cx.d.get('property', cfg.relationPropertyId as Id)
    if (rp) cx.d.mut('property', rp.id).deletedAt = cx.now
  }
})

