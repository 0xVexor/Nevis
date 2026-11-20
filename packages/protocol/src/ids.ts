// UUIDv7 (RFC 9562 §5.7) as a lower-case 36-character string. The generator is MONOTONIC inside one process (RFC 9562 §6.2,
// method 1): ids made in the same millisecond, or after the clock stepped back, still sort in creation order, because a
// 12-bit counter in `rand_a` is incremented instead.
export type Rand = (n: number) => Uint8Array

const defaultRand: Rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n))
const hex = (n: number, w: number) => n.toString(16).padStart(w, '0')

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

export class UuidGenerator {
  private lastMs = -1
  private counter = 0
  private readonly rand: Rand
  private readonly now: () => number
  constructor(now: () => number = Date.now, rand: Rand = defaultRand) {
    this.now = now
    this.rand = rand
  }

  next(): string {
    let ms = this.now()
    const r = this.rand(10)
    if (ms > this.lastMs) {
      this.lastMs = ms
      this.counter = ((r[0]! & 0x07) << 8) | r[1]! // start below 0x800 so the counter has room to count up
    } else {
      ms = this.lastMs
      this.counter++
      if (this.counter > 0xfff) { ms = ++this.lastMs; this.counter = r[1]! }
      this.lastMs = ms
    }
    const t = ms.toString(16).padStart(12, '0')
    const variant = 0x8000 | (((r[2]! & 0x3f) << 8) | r[3]!)
    const tail = [...r.subarray(4, 10)].map(x => hex(x, 2)).join('')
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-${hex(0x7000 | this.counter, 4)}-${hex(variant, 4)}-${tail}`
  }
}

const shared = new UuidGenerator()
/** A new UUIDv7 from the process-wide monotonic generator. */
export const uuidv7 = (): string => shared.next()
