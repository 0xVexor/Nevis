// Deterministic fixture (handoff §28): fixed clock, Asia/Tehran, principal U1, devices D1/D2, Projects + Tasks sources.
import type { Cell, CommandEnvelope, Commit, Id, Json, PageLike } from './model/types.ts'
import { seqIds } from './model/ids.ts'
import { Coordinator } from './commands/index.ts'
import { Access } from './access.ts'
import { DbState, MemoryPages } from './state.ts'
import { MemoryStorage } from './storage/memory.ts'
import type { DbStorage, PageHost } from './storage/types.ts'

export const FIXTURE_CLOCK = '2026-10-25T08:00:00Z'
export const FIXTURE_ZONE = 'Asia/Tehran'
export const VAULT = 'vault-1'

export class MemoryPageHost implements PageHost {
  pages: MemoryPages
  constructor(pages: MemoryPages) {
    this.pages = pages
  }
  get = (id: Id) => this.pages.get(id)
  all = () => this.pages.all()
  adopt(upserts: PageLike[], removed: Id[]) {
    for (const p of upserts) this.pages.put(p)
    for (const id of removed) this.pages.delete(id)
  }
}

export function createHarness(opts: { now?: () => number; device?: Id; storage?: (pages: MemoryPages) => DbStorage } = {}) {
  const pages = new MemoryPages()
  const storage = (opts.storage ? opts.storage(pages) : new MemoryStorage(pages)) as MemoryStorage
  const state = new DbState(VAULT, pages)
  let clock = Date.parse(FIXTURE_CLOCK)
  const now = opts.now ?? (() => clock)
  const ids = seqIds('i')
  const coord = new Coordinator({ state, storage, pageHost: new MemoryPageHost(pages), deviceId: opts.device ?? 'D1', now, ids })
  let n = 0
  async function run(commands: { type: string; payload: Json }[], over: Partial<CommandEnvelope> = {}): Promise<Commit> {
    return coord.execute({ operationId: over.operationId ?? `op${++n}`, vaultId: VAULT, actorId: 'U1', deviceId: opts.device ?? 'D1', expected: [], origin: 'user', commands, ...over })
  }
  const one = async (type: string, payload: unknown, over: Partial<CommandEnvelope> = {}) => (await run([{ type, payload: payload as Json }], over)).result as Record<string, Json>
  return { pages, storage, state, coord, ids, run, one, access: () => new Access(state), setClock: (ms: number) => void (clock = ms), tick: (ms: number) => void (clock += ms) }
}
export type Harness = ReturnType<typeof createHarness>

/** Projects (P1, P2) and Tasks (T1..T4) exactly as in the table of §28. */
export async function seedFixture(h: Harness) {
  const db = await h.one('database.create', { title: 'Tasks', presentation: 'full' }, { operationId: 'seed-db' })
  const sourceId = db.sourceId as Id
  const P = await h.one('database.create', { title: 'Projects', presentation: 'full' }, { operationId: 'seed-projects' })
  const projSrc = P.sourceId as Id
  const mk = async (sid: Id, name: string, kind: string, config?: unknown) => (await h.one('property.create', { sourceId: sid, name, kind, config }, {})).propertyId as Id
  const status = await mk(sourceId, 'Status', 'status', { options: [{ name: 'todo', group: 'todo' }, { name: 'doing', group: 'active' }, { name: 'done', group: 'complete' }] })
  const cost = await mk(sourceId, 'Cost', 'number')
  const due = await mk(sourceId, 'Due', 'date')
  const tags = await mk(sourceId, 'Tags', 'multi_select', { options: [{ name: 'red', color: 'red' }, { name: 'blue', color: 'blue' }, { name: 'green', color: 'green' }] })
  const done = await mk(sourceId, 'Done', 'checkbox')
  const notes = await mk(sourceId, 'Notes', 'text')
  const rel = await h.one('property.create', { sourceId, name: 'Project', kind: 'relation', config: { targetSourceId: projSrc, mode: 'paired', cardinality: 'one', inverseCardinality: 'many', inverseName: 'Tasks' } }, {})
  const project = rel.propertyId as Id
  const projectRelation = rel.definitionId as Id
  const tasksOnProject = rel.inversePropertyId as Id
  const st = h.state.prop(status)!.config as unknown as { options: { id: Id; name: string }[] }
  const so = (n: string) => st.options.find((o) => o.name === n)!.id
  const tg = h.state.prop(tags)!.config as unknown as { options: { id: Id; name: string }[] }
  const to = (n: string) => tg.options.find((o) => o.name === n)!.id
  const P1 = (await h.one('row.create', { sourceId: projSrc, title: 'P1', id: 'P1' })).pageId as Id
  const P2 = (await h.one('row.create', { sourceId: projSrc, title: 'P2', id: 'P2' })).pageId as Id
  const text = (s: string): Cell => ({ kind: 'text', runs: s ? [{ text: s }] : [] })
  const rows: Record<string, { title: string; v: Record<Id, Cell> }> = {
    T1: { title: 'T1', v: { [status]: { kind: 'status', optionId: so('todo') }, [cost]: { kind: 'number', value: 0 }, [due]: { kind: 'date', value: { kind: 'date', start: '2026-10-25', end: null } }, [tags]: { kind: 'multi_select', optionIds: [to('red'), to('blue')] }, [done]: { kind: 'checkbox', value: false } } },
    T2: { title: 'T2', v: { [status]: { kind: 'status', optionId: so('doing') }, [cost]: { kind: 'number', value: 10 }, [due]: { kind: 'date', value: { kind: 'date', start: '2026-10-26', end: '2026-10-28' } }, [tags]: { kind: 'multi_select', optionIds: [to('blue')] }, [done]: { kind: 'checkbox', value: true }, [notes]: text('   ') } },
    T3: { title: 'T3', v: { [status]: { kind: 'status', optionId: so('done') }, [done]: { kind: 'checkbox', value: false }, [notes]: text('alpha') } },
    T4: { title: 'T4', v: { [status]: { kind: 'status', optionId: so('todo') }, [cost]: { kind: 'number', value: -5 }, [due]: { kind: 'date', value: { kind: 'date', start: '2026-10-24', end: null } }, [tags]: { kind: 'multi_select', optionIds: [to('green')] }, [done]: { kind: 'checkbox', value: true }, [notes]: text('beta') } },
  }
  for (const [id, r] of Object.entries(rows)) await h.one('row.create', { sourceId, title: r.title, id, explicitValues: r.v })
  await h.run([{ type: 'relation.add', payload: { definitionId: projectRelation, fromPageId: 'T1', toPageId: P1 } }, { type: 'relation.add', payload: { definitionId: projectRelation, fromPageId: 'T2', toPageId: P1 } }, { type: 'relation.add', payload: { definitionId: projectRelation, fromPageId: 'T3', toPageId: P2 } }])
  return { containerId: db.containerId as Id, sourceId, projSrc, status, cost, due, tags, done, notes, project, projectRelation, tasksOnProject, viewId: db.viewId as Id, so, to, P1, P2, projTitle: P.titlePropertyId as Id, titleId: db.titlePropertyId as Id }
}
export type Fixture = Awaited<ReturnType<typeof seedFixture>>
