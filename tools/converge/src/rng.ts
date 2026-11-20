export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export type Rng = () => number
export const int = (rng: Rng, n: number) => Math.floor(rng() * n)
export const pick = <T,>(rng: Rng, a: readonly T[]): T => a[int(rng, a.length)]!
/** A seeded replacement for crypto.getRandomValues, so a seed makes the same ids. */
export const seededBytes = (rng: Rng) => (n: number) => Uint8Array.from({ length: n }, () => int(rng, 256))
