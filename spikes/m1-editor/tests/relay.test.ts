import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { REMOTE, Relay } from '../src/relay'

const setup = () => {
  let t = 0
  const a = new Y.Doc(), b = new Y.Doc()
  const relay = new Relay(a, b, () => t)
  return { a, b, relay, advance: (ms: number) => (t += ms) }
}
const text = (d: Y.Doc) => d.getText('t').toString()

describe('Relay', () => {
  it('delivers after the delay and converges', () => {
    const { a, b, relay, advance } = setup()
    relay.delayMs = 500
    a.getText('t').insert(0, 'سلام')
    expect(relay.tick()).toBe(0)
    advance(500)
    expect(relay.tick()).toBe(1)
    expect(text(b)).toBe('سلام')
  })

  it('keeps updates while a side is offline and delivers them on reconnect', () => {
    const { a, b, relay } = setup()
    relay.offline.B = true
    a.getText('t').insert(0, 'x')
    relay.tick()
    expect(text(b)).toBe('')
    relay.offline.B = false
    relay.tick()
    expect(text(b)).toBe('x')
  })

  it('a duplicate delivery changes nothing', () => {
    const { a, b, relay } = setup()
    relay.duplicate = true
    a.getText('t').insert(0, 'once')
    relay.tick()
    expect(text(b)).toBe('once')
  })

  it('reordered and duplicated delivery still converges (random)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { a, b, relay } = setup()
      let s = seed
      const rng = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
      for (let i = 0; i < 40; i++) {
        const d = rng() < 0.5 ? a : b
        d.getText('t').insert(Math.floor(rng() * (d.getText('t').length + 1)), String.fromCharCode(0x0627 + Math.floor(rng() * 20)))
        relay.deliverRandom(rng)
      }
      relay.flush()
      expect(text(a)).toBe(text(b))
    }
  })

  it('holds remote updates while composing, up to the cap, and never loses them', () => {
    const { a, b, relay, advance } = setup()
    let composing = true
    relay.holdWhile.B = () => composing
    relay.holdMaxMs = 2000
    a.getText('t').insert(0, 'remote')
    relay.tick()
    expect(text(b)).toBe('') // held
    advance(1000)
    relay.tick()
    expect(text(b)).toBe('')
    composing = false // compositionend
    relay.tick()
    expect(text(b)).toBe('remote')
    // the cap: a composition that never ends cannot hold remote updates for ever
    composing = true
    a.getText('t').insert(6, '!')
    relay.tick()
    advance(2001)
    relay.tick()
    expect(text(b)).toBe('remote!')
  })

  it('does not echo remote updates back to the sender', () => {
    const { a, b, relay } = setup()
    a.getText('t').insert(0, 'x')
    relay.tick()
    expect(relay.pending()).toEqual({ A: 0, B: 0 })
    expect(text(b)).toBe('x')
    void REMOTE
  })
})
