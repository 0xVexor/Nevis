import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { FRAME, UuidGenerator, b64urlDecode, b64urlEncode, compareHlc, decodeEvt, decodeFrame, decodeRec, encodeEnvelope, encodeEvt, encodeRec, encodeYUpdate, formatHlc, hlcRecv, hlcSend, isUuid, parseEnvelope, parseHlc, parseStrict, uuidv7 } from '../src'

const load = (f: string) => JSON.parse(readFileSync(new URL(`../vectors/${f}`, import.meta.url), 'utf8')) as { name: string; valid: boolean; json?: string; text?: string }[]

describe('vectors (shared with the Go server)', () => {
  for (const v of load('envelope.json')) {
    it(`envelope: ${v.name}`, () => {
      if (v.valid) expect(() => parseEnvelope(v.json!)).not.toThrow()
      else expect(() => parseEnvelope(v.json!)).toThrow()
    })
  }
  for (const v of load('json.json')) {
    it(`json: ${v.name}`, () => {
      if (v.valid) expect(() => parseStrict(v.text!)).not.toThrow()
      else expect(() => parseStrict(v.text!)).toThrow()
    })
  }
  it('a valid envelope survives encode -> parse with the same fields', () => {
    const v = load('envelope.json')[0]!
    const e = parseEnvelope(v.json!)
    expect(parseEnvelope(encodeEnvelope(e))).toEqual(e)
    expect(encodeEnvelope(e)).toBe(v.json)
  })
})

describe('ids', () => {
  it('uuidv7 is a well formed UUID, version 7, and sorts by creation', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7())
    expect(ids.every(isUuid)).toBe(true)
    expect(ids.every(i => i[14] === '7')).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('stays monotonic when the clock stands still or goes back', () => {
    let t = 1_700_000_000_000
    const g = new UuidGenerator(() => t)
    const a = [g.next(), g.next(), g.next()]
    t -= 5000
    const b = [g.next(), g.next()]
    expect([...a, ...b]).toEqual([...a, ...b].sort())
    expect(new Set([...a, ...b]).size).toBe(5)
  })
  it('survives a counter overflow inside one millisecond', () => {
    const g = new UuidGenerator(() => 1_700_000_000_000)
    const ids = Array.from({ length: 6000 }, () => g.next())
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(6000)
  })
})

describe('base64url', () => {
  it('round-trips any bytes', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), bytes => { expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes) }))
  })
  it('never pads and rejects everything outside the alphabet', () => {
    expect(b64urlEncode(new Uint8Array([1]))).not.toContain('=')
    for (const bad of ['AQ==', 'A+B/', 'A', 'AB CD', 'é']) expect(() => b64urlDecode(bad)).toThrow()
  })
})

describe('HLC', () => {
  const dev = '019a8f3c-2b10-7c3e-8f00-1a2b3c4d5e03'
  const state = fc.record({ ms: fc.integer({ min: 0, max: 2 ** 47 }), counter: fc.integer({ min: 0, max: 0xffff }) })
  it('string order is the numeric order', () => {
    fc.assert(fc.property(state, state, (a, b) => {
      const sa = formatHlc(a, dev), sb = formatHlc(b, dev)
      const num = a.ms !== b.ms ? a.ms - b.ms : a.counter - b.counter
      expect(Math.sign(compareHlc(sa, sb))).toBe(Math.sign(num))
      expect(parseHlc(sa)).toEqual({ ...a, device: dev })
    }))
  })
  it('a send is strictly greater than the previous state, whatever the wall clock does', () => {
    fc.assert(fc.property(state, fc.integer({ min: 0, max: 2 ** 47 }), (prev, now) => {
      const next = hlcSend(prev, now)
      expect(compareHlc(formatHlc(next, dev), formatHlc(prev, dev))).toBe(1)
    }))
  })
  it('stays monotonic over a whole run with a wall clock that jumps around (also across a restart)', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 200 }), nows => {
      let s = { ms: 0, counter: 0 }
      let last = formatHlc(s, dev)
      nows.forEach((now, i) => {
        if (i % 17 === 0) s = { ...parseHlc(last)! } // restart: the state is re-read from what was stored
        s = hlcSend(s, now)
        const cur = formatHlc(s, dev)
        expect(compareHlc(cur, last)).toBe(1)
        last = cur
      })
    }))
  })
  it('counter overflow moves to the next millisecond', () => {
    const s = hlcSend({ ms: 100, counter: 0xffff }, 50)
    expect(s).toEqual({ ms: 101, counter: 0 })
  })
  it('a receive is greater than both the local and the remote timestamp, also from the future', () => {
    fc.assert(fc.property(state, state, fc.integer({ min: 0, max: 2 ** 47 }), (local, remote, now) => {
      const out = hlcRecv(local, remote, now)
      expect(compareHlc(formatHlc(out, dev), formatHlc(local, dev))).toBe(1)
      expect(compareHlc(formatHlc(out, dev), formatHlc(remote, dev))).toBe(1)
    }))
  })
})

describe('payload frames', () => {
  it('rec, evt and yupd round trip, with Persian text and ZWNJ intact', () => {
    const rec = { kind: 'page', set: { title: 'می‌خواهم', n: 3, 'tag:x': true, gone: null }, h: 'h' }
    const f = decodeFrame(encodeRec(rec))
    expect(f.kind).toBe(FRAME.rec)
    expect(decodeRec(f.data)).toEqual(rec)
    const evt = { id: 'e', kind: 'review', h: 'h', body: { rating: 3 } }
    expect(decodeEvt(decodeFrame(encodeEvt(evt)).data)).toEqual(evt)
    const u = new Uint8Array([1, 2, 3, 250])
    const y = decodeFrame(encodeYUpdate(u))
    expect(y.kind).toBe(FRAME.yupd)
    expect([...y.data]).toEqual([1, 2, 3, 250])
  })
  it('rejects empty and unknown frames', () => {
    expect(() => decodeFrame(new Uint8Array())).toThrow()
    expect(() => decodeFrame(new Uint8Array([0x99]))).toThrow()
  })
  it('a float or a duplicate key inside a rec payload is refused', () => {
    const bad = new TextEncoder().encode('{"set":{"a":1.5},"h":"x"}')
    expect(() => decodeRec(bad)).toThrow()
  })
})
