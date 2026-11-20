// UUIDv7 as a lower-case string (ADR-0002): 48-bit unix ms, version 7, variant 10, the rest random.
export function uuidv7(now: number = Date.now(), rand: (n: number) => Uint8Array = randomBytes): string {
  const b = rand(10)
  const ts = BigInt(now)
  const h = (n: number, w: number) => n.toString(16).padStart(w, '0')
  const t = ts.toString(16).padStart(12, '0')
  const r0 = b[0]!, r1 = b[1]!, r2 = b[2]!
  const ver = 0x7000 | (((r0 & 0x0f) << 8) | r1)
  const variant = 0x8000 | (((r2 & 0x3f) << 8) | b[3]!)
  const tail = [...b.subarray(4, 10)].map(x => h(x, 2)).join('')
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-${h(ver, 4)}-${h(variant, 4)}-${tail}`
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const isBlockId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
