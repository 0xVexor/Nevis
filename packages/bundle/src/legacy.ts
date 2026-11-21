// One-time import of the OLD app's data (ADR-0009 §2; docs/formats/legacy-import.md): the old page records (`repo.dump()`: an array of
// pages with TipTap JSON content) become a bundle, which is then imported like any other. Runs on one device, offline.
import * as Y from 'yjs'
import { Client, MemoryBlobStore, MemoryStore, createPage } from '@nevis/core'
import { SV, uuidv7 } from '@nevis/protocol'
import { normalize, writeBody, type PMJson } from '@nevis/schema'
import { exportBundle } from './index'

export interface LegacyPage {
  id: string
  parentId: string | null
  kind?: 'page' | 'folder' | 'board' | 'todo' | 'deck'
  title: string
  icon?: string
  tags?: string[]
  favorite?: boolean
  sort?: number
  content: unknown
  updatedAt?: number
  deletedAt?: number | null
  database?: object
}

export interface LegacyReport {
  pages: number
  folders: number
  skipped: { id: string; title: string; why: string }[]
  /** things the new schema cannot hold and that were dropped, with how many */
  lost: Record<string, number>
}

type N = { type?: string; attrs?: Record<string, unknown>; content?: N[]; text?: string; marks?: N[] }
const bump = (r: LegacyReport, k: string) => { r.lost[k] = (r.lost[k] ?? 0) + 1 }
const isStr = (v: unknown): v is string => typeof v === 'string'

/** The old TipTap document in the new schema: attributes renamed or dropped as ADR-0003 and the M8a header of blocks.ts say. */
export function convertLegacyDoc(doc: unknown, r: LegacyReport): PMJson {
  const walk = (n: N): N => {
    const out: N = { ...n }
    const a = { ...(n.attrs ?? {}) }
    switch (n.type) {
      case 'callout': if (isStr(a.emoji)) { a.icon = a.emoji; delete a.emoji } else delete a.emoji; break
      case 'layoutGroup': { const w = a.widths; const d = a.direction; delete a.widths; delete a.direction; if (d === 'rtl' || d === 'ltr') a.dir = d
        out.content = (n.content ?? []).map((c, i) => ({ ...c, attrs: { ...(c.attrs ?? {}), ...(Array.isArray(w) && typeof w[i] === 'number' ? { width: Math.round(w[i] as number) } : {}) } })); break }
      case 'drawing': delete a.preview; if (!isStr(a.scene)) { a.scene = ''; bump(r, 'drawing without a readable scene') } break
      case 'image': if (isStr(a.src) && a.src.startsWith('data:')) { a.src = ''; bump(r, 'image stored inside the page (data: URL)') } break
      case 'pageLink': if (a.id !== undefined) { a.dstId = a.id; delete a.id } if (a.label == null) a.label = ''; break
    }
    for (const k of Object.keys(a)) if (a[k] === null) delete a[k] // the new schema has no null attribute
    if (Object.keys(a).length) out.attrs = a; else delete out.attrs
    if (n.content && n.type !== 'layoutGroup') out.content = n.content.map(walk)
    else if (n.type === 'layoutGroup') out.content = (out.content ?? []).map(walk)
    return out
  }
  const base = doc && typeof doc === 'object' ? (doc as N) : { type: 'doc', content: [] }
  const withIds = (n: N): N => ({ ...n, ...(n.attrs || n.type === 'paragraph' ? { attrs: { ...(n.attrs ?? {}), ...(n.type && n.type !== 'text' && n.type !== 'doc' && !isStr(n.attrs?.blockId) ? { blockId: uuidv7() } : {}) } } : {}), ...(n.content ? { content: n.content.map(withIds) } : {}) })
  return normalize(withIds(walk(base)) as PMJson)
}

/** Old pages -> a bundle (ZIP bytes) and a report of what came across, what was skipped and what was lost. */
export async function legacyToBundle(pages: LegacyPage[], workspace = { id: uuidv7(), name: 'Imported' }): Promise<{ zip: Uint8Array; report: LegacyReport }> {
  const report: LegacyReport = { pages: 0, folders: 0, skipped: [], lost: {} }
  const store = new MemoryStore()
  const client = new Client({ store, ws: workspace.id, device: uuidv7(), sv: SV })
  const ids = new Map<string, string>()
  for (const p of pages) ids.set(p.id, p.id.match(/^[0-9a-f-]{36}$/i) ? p.id : uuidv7()) // an old id that is not a UUID gets a new one; links are remapped below
  for (const p of pages.filter(x => !x.database && !x.deletedAt)) {
    const id = ids.get(p.id)!
    if (p.kind === 'board' || p.kind === 'deck') { report.skipped.push({ id: p.id, title: p.title, why: `a ${p.kind} page has no equivalent yet` }); continue }
    const parent = p.parentId && ids.has(p.parentId) ? ids.get(p.parentId)! : ''
    await createPage(client, { parent, title: p.title || '' }, id)
    if (p.kind === 'folder') { report.folders++; continue }
    const json = convertLegacyDoc(p.content, report)
    const y = new Y.Doc(); writeBody(y, json)
    await client.writeYUpdate(id, Y.encodeStateAsUpdate(y))
    report.pages++
  }
  const zip = await exportBundle({ store, workspace, sv: SV, blob: async () => undefined, app: 'legacy-import' })
  return { zip, report }
}
void MemoryBlobStore
