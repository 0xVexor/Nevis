// The lossless bundle (ADR-0009): a ZIP with the user's data in open formats. Export reads the local store; import writes into a FRESH
// workspace through the ordinary client, so what is imported syncs like anything else. The bundle holds the user's data, not collaboration
// state: no Yjs states and no HLCs (a page is its ProseMirror JSON; the import builds a new Y.Doc from it).
import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate'
import * as Y from 'yjs'
import { hexNamesIn, loadDoc, sha256Hex, type BlobStore, type Client, type EventRow, type Store } from '@nevis/core'
import { project, writeBody, type PMJson } from '@nevis/schema'

export const BUNDLE_FORMAT = 'nevis-bundle'
export const BUNDLE_VERSION = 1

export interface Manifest {
  format: string
  formatVersion: number
  sv: number
  app: string
  workspace: { id: string; name: string }
  exportedAt: string
  counts: { entities: number; pages: number; attachments: number }
  /** attachments the pages refer to that could not be read (not synced to this device and the server was not reachable) */
  missingAttachments: string[]
  files: Record<string, string>
}

export interface ExportSource {
  store: Store
  /** the bytes of an attachment (from this device, else the server); undefined = not available */
  blob: (hash: string) => Promise<{ data: Blob; mime: string } | undefined>
  workspace: { id: string; name: string }
  sv: number
  app?: string
  now?: () => Date
}

const README = `Nevis bundle / بستهٔ نِویس
==========================
manifest.json        what is in this bundle, with a SHA-256 of every file / فهرست فایل‌ها با هش
entities.ndjson      one line per page, database, row, tag...: its fields as they are now / هر موجودیت و فیلدهایش
pages/<id>.json      the body of a page as ProseMirror JSON / بدنهٔ صفحه
events/<kind>.ndjson immutable events: reviews, versions / رویدادها (مرور، نسخه)
attachments/<hash>   the raw bytes of an attachment (named by SHA-256) / بایت خام پیوست
attachments.ndjson   {hash,size,mime,name} per attachment
`

/** JSON with sorted keys: the same data always gives the same bytes (the round trip compares files). */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map(k => [k, sort((x as Record<string, unknown>)[k])])) : x)
  return JSON.stringify(sort(v))
}
const lines = (rows: unknown[]) => rows.map(canonical).join('\n') + (rows.length ? '\n' : '')

export async function exportBundle(src: ExportSource): Promise<Uint8Array> {
  const { store } = src
  const { fields, events, docs } = await store.run(async tx => ({ fields: await tx.allFields(), events: await tx.allEvents(), docs: await tx.docs() }))
  const byEnt = new Map<string, { kind: string; fields: Record<string, unknown> }>()
  for (const f of fields) {
    const e = byEnt.get(f.ent) ?? { kind: '', fields: {} }
    const v = JSON.parse(f.val) as unknown
    if (f.f === '$kind') e.kind = String(v); else e.fields[f.f] = v
    byEnt.set(f.ent, e)
  }
  const ids = [...byEnt.keys()].sort()
  const files: Record<string, Uint8Array> = {}
  files['entities.ndjson'] = strToU8(lines(ids.map(id => ({ id, kind: byEnt.get(id)!.kind, createdAt: byEnt.get(id)!.fields.createdAt ?? 0, fields: byEnt.get(id)!.fields }))))
  const refs = new Set<string>()
  const enc = new TextEncoder()
  for (const f of fields) hexNamesIn(enc.encode(f.val), refs)
  let pages = 0
  for (const id of [...docs].sort()) {
    const doc = await store.run(tx => loadDoc(tx, id))
    const json = canonical(project(doc))
    hexNamesIn(enc.encode(json), refs)
    files[`pages/${id}.json`] = strToU8(json); pages++
  }
  const byKind = new Map<string, EventRow[]>()
  for (const e of events) { const l = byKind.get(e.kind) ?? []; l.push(e); byKind.set(e.kind, l) }
  for (const [kind, list] of byKind) {
    list.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : 1))
    for (const e of list) hexNamesIn(enc.encode(e.body), refs)
    files[`events/${kind}.ndjson`] = strToU8(lines(list.map(e => ({ id: e.id, ent: e.ent, kind: e.kind, body: JSON.parse(e.body) as unknown }))))
  }
  const missing: string[] = []
  const attachments: { hash: string; size: number; mime: string; name: string }[] = []
  const raw: Zippable = {}
  for (const h of [...refs].sort()) {
    const b = await src.blob(h)
    if (!b) { missing.push(h); continue }
    const bytes = new Uint8Array(await b.data.arrayBuffer())
    if ((await sha256Hex(bytes)) !== h) { missing.push(h); continue } // never put bytes under a name they do not match
    raw[`attachments/${h}`] = [bytes, { level: 0 }]
    attachments.push({ hash: h, size: bytes.length, mime: b.mime, name: '' })
  }
  files['attachments.ndjson'] = strToU8(lines(attachments))
  const hashes: Record<string, string> = {}
  for (const [name, data] of Object.entries(files)) hashes[name] = await sha256Hex(data)
  const manifest: Manifest = {
    format: BUNDLE_FORMAT, formatVersion: BUNDLE_VERSION, sv: src.sv, app: src.app ?? '0.1.0', workspace: src.workspace,
    exportedAt: (src.now?.() ?? new Date()).toISOString(), counts: { entities: ids.length, pages, attachments: attachments.length }, missingAttachments: missing, files: hashes,
  }
  const zip: Zippable = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 1)), 'README.txt': strToU8(README), ...raw }
  for (const [n, d] of Object.entries(files)) zip[n] = d
  return zipSync(zip, { level: 6 })
}

export class BundleError extends Error {}

export interface ImportResult { entities: number; pages: number; events: number; attachments: number }

/** Writes a bundle into a workspace. The workspace must have none of the bundle's entities (an import never merges). */
export async function importBundle(zip: Uint8Array, target: { client: Client; store: Store; blobs?: BlobStore }): Promise<ImportResult> {
  let files: Record<string, Uint8Array>
  try { files = unzipSync(zip) } catch { throw new BundleError('this file is not a ZIP') }
  const mf = files['manifest.json']
  if (!mf) throw new BundleError('no manifest.json: this is not a Nevis bundle')
  const manifest = JSON.parse(strFromU8(mf)) as Manifest
  if (manifest.format !== BUNDLE_FORMAT) throw new BundleError('not a Nevis bundle')
  if (manifest.formatVersion > BUNDLE_VERSION) throw new BundleError('this bundle is from a newer version of the app')
  for (const [name, sha] of Object.entries(manifest.files)) {
    const f = files[name]
    if (!f) throw new BundleError(`missing file ${name}`)
    if ((await sha256Hex(f)) !== sha) throw new BundleError(`${name} does not match its hash: the bundle is damaged`)
  }
  const parse = (name: string) => (files[name] ? strFromU8(files[name]!).split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : [])
  const entities = parse('entities.ndjson') as { id: string; kind: string; fields: Record<string, never> }[]
  const have = new Set(await target.store.run(tx => tx.entities()))
  const clash = entities.find(e => have.has(e.id))
  if (clash) throw new BundleError(`this workspace already has ${clash.id}: a bundle is imported into a new workspace`)
  // attachments first: a page that names one must find it
  let attachments = 0
  for (const a of parse('attachments.ndjson') as { hash: string; mime: string }[]) {
    const bytes = files[`attachments/${a.hash}`]
    if (!bytes || !target.blobs) continue
    if ((await sha256Hex(bytes)) !== a.hash) throw new BundleError(`attachment ${a.hash} is damaged`)
    await target.blobs.put(a.hash, new Blob([bytes.slice().buffer as ArrayBuffer]), a.mime)
    attachments++
  }
  for (let i = 0; i < entities.length; i += 100) {
    await target.client.setFieldsMany(entities.slice(i, i + 100).map(e => ({ ent: e.id, set: e.fields as Record<string, never>, ...(e.kind ? { kind: e.kind } : {}) })))
  }
  let pages = 0
  for (const name of Object.keys(files).filter(n => n.startsWith('pages/')).sort()) {
    const id = name.slice('pages/'.length, -'.json'.length)
    const ydoc = new Y.Doc()
    writeBody(ydoc, JSON.parse(strFromU8(files[name]!)) as PMJson)
    await target.client.writeYUpdate(id, Y.encodeStateAsUpdate(ydoc)); pages++
  }
  let events = 0
  for (const name of Object.keys(files).filter(n => n.startsWith('events/')).sort()) {
    for (const e of parse(name) as { id: string; ent: string; kind: string; body: never }[]) { await target.client.addEvent(e.ent, e.kind, e.body, e.id); events++ }
  }
  return { entities: entities.length, pages, events, attachments }
}

/** The files of a bundle without the fields that legitimately differ between two exports (for the round-trip comparison). */
export function comparable(zip: Uint8Array): Record<string, string> {
  const files = unzipSync(zip)
  const out: Record<string, string> = {}
  for (const [n, d] of Object.entries(files)) {
    if (n === 'manifest.json') { const m = JSON.parse(strFromU8(d)) as Manifest; out[n] = canonical({ ...m, exportedAt: '', workspace: '', app: '' }); continue }
    out[n] = n.startsWith('attachments/') ? `bytes:${d.length}` : strFromU8(d)
  }
  return out
}

export { mdFileName, toMarkdown, type MdContext } from './markdown'
export { convertLegacyDoc, legacyToBundle, type LegacyPage, type LegacyReport } from './legacy'
