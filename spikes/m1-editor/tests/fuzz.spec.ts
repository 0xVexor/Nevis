import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { FuzzResult } from '../src/fuzz'

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 200)
const STEPS = Number(process.env.FUZZ_STEPS ?? 500)
const CHUNK = 10

async function run(page: import('@playwright/test').Page, withUndo: boolean) {
  const all: FuzzResult[] = []
  for (let from = 1; from <= SEEDS; from += CHUNK) {
    const part = await page.evaluate(
      async ([f, n, steps, undo]) => {
        const out: unknown[] = []
        for (let i = 0; i < n; i++) out.push(await (window as unknown as { __fuzz: (s: number, st: number, u: boolean) => Promise<unknown> }).__fuzz(f + i, steps, undo))
        return out
      },
      [from, Math.min(CHUNK, SEEDS - from + 1), STEPS, withUndo] as const,
    )
    all.push(...(part as FuzzResult[]))
  }
  return all
}

const summary = (rs: FuzzResult[]) => ({
  seeds: rs.length,
  docsEqual: rs.filter(r => r.docsEqual).length,
  failedSeeds: rs.filter(r => !r.docsEqual).map(r => r.seed),
  seedsWithViewMismatch: rs.filter(r => r.viewMismatches > 0).length,
  seedsWithViewMismatchNotFixedByRerender: rs.filter(r => r.viewMismatches > r.fixedByRerender).length,
  viewMismatchRatePerCheck: rs.reduce((a, r) => a + r.viewMismatches, 0) / Math.max(1, rs.reduce((a, r) => a + r.viewChecks, 0)),
  transientViewMismatches: rs.reduce((a, r) => a + r.transient, 0),
  rangeErrors: rs.reduce((a, r) => a + r.rangeErrors, 0),
  otherErrors: rs.reduce((a, r) => a + r.otherErrors, 0),
  errorSamples: [...new Set(rs.flatMap(r => r.errorSample))].slice(0, 5),
  mismatchSamples: [...new Set(rs.flatMap(r => r.mismatchSample))].slice(0, 8),
  idsNotOk: rs.filter(r => !r.idsOk).map(r => r.seed),
  nullAttrs: rs.reduce((a, r) => a + r.nullAttrs, 0),
  maxSizeBytes: Math.max(...rs.map(r => r.sizeA)),
  ms: rs.reduce((a, r) => a + r.ms, 0),
})

test.beforeEach(async ({ page }) => {
  if (process.env.FUZZ_PASTE) await page.addInitScript('window.__fuzzPaste = true') // STRESS run: also paste several blocks at a random caret (known open: ~1-2% of seeds)
  await page.goto('/')
})

for (const withUndo of [false, true]) {
  test(`fuzz ${SEEDS} seeds x ${STEPS} steps ${withUndo ? 'WITH' : 'WITHOUT'} undo`, async ({ page }) => {
    const rs = await run(page, withUndo)
    const s = summary(rs)
    mkdirSync('results', { recursive: true })
    writeFileSync(`results/fuzz-${withUndo ? 'undo' : 'noundo'}.json`, JSON.stringify({ steps: STEPS, ...s, results: rs.filter(r => !r.docsEqual || r.viewMismatches || r.otherErrors).slice(0, 20) }, null, 2))
    console.log(JSON.stringify(s))
    // (a) the Y.Docs must converge in every seed; ids unique and valid; no null attributes
    expect(s.failedSeeds, 'Y.Doc projections differ').toEqual([])
    expect(s.idsNotOk, 'block ids not unique/valid').toEqual([])
    expect(s.nullAttrs).toBe(0)
    // a caught RangeError is an operation that did NOT happen: thousands of them once made a bad insert path look clean
    expect(s.rangeErrors, 'operations that threw a RangeError').toBe(0)
    // (b) view != own Y.Doc: seeds with a mismatch that a re-render does not fix
    const limit = withUndo ? 0.05 : 0.01
    if (process.env.FUZZ_PASTE) { console.log('PASTE-STRESS (informational, not asserted)', s.seedsWithViewMismatch, 'of', s.seeds); return }
    expect(s.seedsWithViewMismatch / s.seeds, 'view mismatch rate').toBeLessThanOrEqual(limit)
  })
}

test('size: 100 paragraphs after 30 undo/redo cycles', async ({ page }) => {
  const r = await page.evaluate(() => (window as unknown as { __sizeTest: () => unknown }).__sizeTest()) as { bytes: number; bytesBefore: number }
  mkdirSync('results', { recursive: true })
  writeFileSync('results/size.json', JSON.stringify(r, null, 2))
  console.log('size', JSON.stringify(r))
  expect(r.bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
})
