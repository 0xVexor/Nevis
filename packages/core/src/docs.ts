// A document body is a Y.Doc rebuilt from its saved state plus the updates since. Small local tail, compacted often.
import * as Y from 'yjs'
import type { Tx } from './store'

export const COMPACT_AFTER = 50

export async function loadDoc(tx: Tx, doc: string): Promise<Y.Doc> {
  const y = new Y.Doc()
  const st = await tx.getDocState(doc)
  if (st?.state) Y.applyUpdate(y, st.state)
  for (const u of await tx.listDocUpdates(doc)) Y.applyUpdate(y, u.upd)
  return y
}

/** Folds the update tail into the saved state once it is long (ADR-0003 §11). */
export async function compactDoc(tx: Tx, doc: string): Promise<void> {
  const tail = await tx.listDocUpdates(doc)
  if (tail.length < COMPACT_AFTER) return
  const st = await tx.getDocState(doc)
  const merged = Y.mergeUpdates([...(st?.state ? [st.state] : []), ...tail.map(u => u.upd)])
  await tx.putDocState(doc, merged, st?.maxSv ?? 0)
  await tx.deleteDocUpdates(doc, tail[tail.length - 1]!.k)
}
