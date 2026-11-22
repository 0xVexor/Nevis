// Golden fixtures (ADR-0003 §8): V1 updates written under an EARLIER schema must still project to the same page under the CURRENT
// one, compared with every default-valued attribute dropped (so a later schema may ADD attributes and node types). The files are
// stored bytes, captured once by scripts/capture-golden.ts, never regenerated; each has its SHA-256 and a test checks it.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { SV } from '@nevis/protocol'
import { dropDefaults, project, type PMJson } from '../src'

const root = join(import.meta.dirname, '..', 'fixtures')
/** `update`: one V1 update; `updates`: a list applied in order (how the app stores a page: the compacted state, then the tail) */
interface Golden { name: string; sv: number; update?: string; updates?: string[]; sha256: string; projection: PMJson }
const updatesOf = (g: Golden): Buffer[] => (g.updates ?? [g.update!]).map(u => Buffer.from(u, 'base64'))
const all: Golden[] = readdirSync(root).filter(d => /^sv\d+$/.test(d)).sort().flatMap(d => readdirSync(join(root, d)).sort().map(f => JSON.parse(readFileSync(join(root, d, f), 'utf8')) as Golden))

describe('golden fixtures', () => {
  it('exist for sv1 (captured before the first schema change) and are not more than the current SV', () => {
    expect(all.filter(g => g.sv === 1).length).toBeGreaterThanOrEqual(12)
    expect(all.filter(g => g.sv === 2).length).toBeGreaterThanOrEqual(12) // the blocks of M8a
    expect(all.filter(g => g.sv === 3).length).toBeGreaterThanOrEqual(1) // the attachments of M9
    expect(all.filter(g => g.sv === 4).length).toBeGreaterThanOrEqual(1) // resized tables
    for (const n of ['real-m5-store', 'real-m5-merged']) expect(all.some(g => g.sv === 1 && g.name === n), `the realistic sv1 fixture ${n}`).toBe(true)
    for (const g of all) expect(g.sv).toBeLessThanOrEqual(SV)
  })
  it.each(all.map(g => [`sv${g.sv}/${g.name}`, g] as const))('%s: bytes unchanged (SHA-256), and the page projects the same under the current schema', (_n, g) => {
    expect(createHash('sha256').update(Buffer.concat(updatesOf(g))).digest('hex'), 'the stored update was rewritten').toBe(g.sha256)
    const doc = new Y.Doc()
    for (const u of updatesOf(g)) Y.applyUpdate(doc, new Uint8Array(u))
    expect(dropDefaults(project(doc))).toEqual(dropDefaults(g.projection))
  })
  it('the rule is not vacuous: a changed text or a non-default attribute IS a difference', () => {
    const g = all.find(x => x.name === 'directions')!
    const doc = new Y.Doc()
    for (const u of updatesOf(g)) Y.applyUpdate(doc, new Uint8Array(u))
    const changed = JSON.parse(JSON.stringify(g.projection)) as PMJson
    changed.content![1]!.attrs!.dir = 'ltr' // the second paragraph is rtl in this fixture
    expect(dropDefaults(project(doc))).not.toEqual(dropDefaults(changed))
    expect(dropDefaults({ type: 'paragraph', attrs: { dir: 'auto', blockId: '' } })).toEqual({ type: 'paragraph' }) // defaults vanish
  })
})
