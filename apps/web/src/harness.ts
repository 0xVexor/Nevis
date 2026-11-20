// A plain-browser runner for the Store conformance suite (no test framework): collects `it` blocks, runs them in order.
import type { Harness } from '@nevis/core'

export interface Result { name: string; ok: boolean; error?: string }
const queue: { name: string; fn: () => Promise<void> }[] = []
let prefix: string[] = []

const same = (a: unknown, b: unknown) => {
  const norm = (v: unknown): unknown => (v instanceof Uint8Array ? Array.from(v) : Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort().map(([k, x]) => [k, norm(x)])) : v)
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}
const show = (v: unknown) => { try { return JSON.stringify(v) } catch { return String(v) } }

const harness: Harness = {
  describe(name, fn) { prefix.push(name); fn(); prefix.pop() },
  it(name, fn) { queue.push({ name: [...prefix, name].join(' > '), fn }) },
  expect(actual) {
    const fail = (m: string) => { throw new Error(m) }
    return {
      toBe: v => { if (!Object.is(actual, v)) fail(`expected ${show(actual)} to be ${show(v)}`) },
      toEqual: v => { if (!same(actual, v)) fail(`expected ${show(actual)} to equal ${show(v)}`) },
      toBeUndefined: () => { if (actual !== undefined) fail(`expected ${show(actual)} to be undefined`) },
      not: { toBe: v => { if (Object.is(actual, v)) fail(`expected not ${show(v)}`) } },
      rejects: { toThrow: async m => {
        try { await (actual as Promise<unknown>) } catch (e) { if (m && !String((e as Error).message).includes(m)) fail(`wrong error: ${(e as Error).message}`); return }
        fail('expected a rejection')
      } },
    }
  },
}


export { harness }

/** Runs everything registered through `harness` so far. */
export async function runAll(): Promise<Result[]> {
  const results: Result[] = []
  for (const t of queue) {
    try { await t.fn(); results.push({ name: t.name, ok: true }) } catch (e) { results.push({ name: t.name, ok: false, error: e instanceof Error ? e.message : String(e) }) }
  }
  return results
}
