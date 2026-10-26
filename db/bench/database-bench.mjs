// Database performance benchmark (handoff §27): node db/bench/database-bench.mjs [1000 10000 100000]
// Measures batched row creation and the query shapes a table view uses, on the in-memory adapter (no disk, no UI).
import { performance } from 'node:perf_hooks'
const { createHarness, FIXTURE_CLOCK, FIXTURE_ZONE } = await import('../../spike/tiptap/src/database/fixtures.ts')
const { runQuery, makeQuery } = await import('../../spike/tiptap/src/database/query/engine.ts')

const sizes = process.argv.slice(2).map(Number).filter(Boolean)
if (!sizes.length) sizes.push(1000, 10000, 100000)
const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10
const out = []

for (const N of sizes) {
  const h = createHarness()
  const db = await h.one('database.create', { title: 'Bench' })
  const src = db.sourceId
  const mk = async (name, kind, config) => (await h.one('property.create', { sourceId: src, name, kind, config })).propertyId
  const status = await mk('Status', 'status', { options: [{ name: 'todo', group: 'todo' }, { name: 'doing', group: 'active' }, { name: 'done', group: 'complete' }] })
  const cost = await mk('Cost', 'number')
  const due = await mk('Due', 'date')
  const st = h.state.prop(status).config.options.map((o) => o.id)
  const t0 = performance.now()
  const BATCH = 500
  for (let i = 0; i < N; i += BATCH) {
    const cmds = []
    for (let j = i; j < Math.min(N, i + BATCH); j++) {
      cmds.push({ type: 'row.create', payload: { sourceId: src, title: 'Row ' + j, explicitValues: { [status]: { kind: 'status', optionId: st[j % 3] }, [cost]: { kind: 'number', value: (j * 37) % 1000 }, [due]: { kind: 'date', value: { kind: 'date', start: `2026-${String(1 + (j % 12)).padStart(2, '0')}-${String(1 + (j % 28)).padStart(2, '0')}`, end: null } } } } })
    }
    await h.run(cmds)
  }
  const create = ms(t0)
  const q = (over) => { const t = performance.now(); const r = runQuery(h.state, makeQuery(h.state, src, 'U1', FIXTURE_CLOCK, FIXTURE_ZONE, over)); return { ms: ms(t), total: r.total, rows: r.pageIds.length } }
  const pred = (propertyId, op, operand) => ({ kind: 'predicate', propertyId, op, operand })
  const res = {
    N, createTotalMs: create, createPerRowMs: Math.round((create / N) * 1000) / 1000,
    firstPage: q({ limit: 50 }),
    filter: q({ filter: pred(cost, 'gte', 500), limit: 50 }),
    sort: q({ sorts: [{ propertyId: cost, direction: 'desc' }], limit: 50 }),
    group: q({ group: { propertyId: status }, limit: 50 }),
    search: q({ search: 'Row 9999', limit: 50 }),
  }
  out.push(res)
  console.log(JSON.stringify(res))
}
