// A readable projection of a store, for the harness and for tests: all registers, all event ids, and every document body.
import { loadDoc } from './docs'
import type { Store } from './store'

export interface Projection {
  fields: Record<string, Record<string, unknown>>
  events: string[]
  docs: Record<string, string>
}

export async function projectStore(store: Store): Promise<Projection> {
  return store.run(async tx => {
    const fields: Projection['fields'] = {}
    const events: string[] = []
    for (const ent of (await tx.entities()).sort()) {
      const f = await tx.entityFields(ent)
      fields[ent] = Object.fromEntries(Object.keys(f).sort().map(k => [k, JSON.parse(f[k]!.val)]))
    }
    for (const e of await tx.allEvents()) events.push(e.id)
    const docs: Projection['docs'] = {}
    for (const d of (await tx.docs()).sort()) docs[d] = (await loadDoc(tx, d)).getXmlFragment('body').toString()
    return { fields, events: events.sort(), docs }
  })
}
