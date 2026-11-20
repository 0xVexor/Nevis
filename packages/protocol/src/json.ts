// The strict JSON parser for everything that comes from the network or an import (ADR-0008 "قواعد JSON"):
// UTF-8 without BOM; a duplicate key is an error; numbers are integers within ±(2^53−1), never floats, never -0;
// a lone surrogate (as a character or as an escape) is an error; nesting is bounded. JSON.parse cannot do these.
export class JsonError extends Error {
  readonly at: number
  constructor(message: string, at: number) {
    super(`${message} at ${at}`)
    this.at = at
  }
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
const MAX_DEPTH = 64
const MAX_SAFE = Number.MAX_SAFE_INTEGER

export function parseStrict(text: string): Json {
  if (text.charCodeAt(0) === 0xfeff) throw new JsonError('BOM', 0)
  let i = 0
  const fail = (m: string): never => { throw new JsonError(m, i) }
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++ }

  const str = (): string => {
    if (text[i] !== '"') fail('expected string')
    i++
    let out = ''
    for (;;) {
      if (i >= text.length) fail('unterminated string')
      const c = text.charCodeAt(i)
      if (c === 0x22) { i++; return out }
      if (c < 0x20) fail('control character in string')
      if (c === 0x5c) {
        const e = text[i + 1]
        i += 2
        if (e === 'u') {
          const h = text.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('bad \\u escape')
          out += String.fromCharCode(parseInt(h, 16))
          i += 4
        } else {
          const m: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
          if (!e || !(e in m)) fail('bad escape')
          out += m[e!]
        }
      } else { out += text[i]; i++ }
    }
  }

  const checkSurrogates = (s: string, at: number) => {
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k)
      if (c >= 0xd800 && c <= 0xdbff) { const d = s.charCodeAt(k + 1); if (d >= 0xdc00 && d <= 0xdfff) k++; else throw new JsonError('lone surrogate', at) }
      else if (c >= 0xdc00 && c <= 0xdfff) throw new JsonError('lone surrogate', at)
    }
  }

  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) fail('too deep')
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const o: { [k: string]: Json } = Object.create(null)
      ws()
      if (text[i] === '}') { i++; return o }
      for (;;) {
        ws()
        const at = i
        const k = str()
        checkSurrogates(k, at)
        if (k in o) throw new JsonError(`duplicate key "${k}"`, at)
        ws()
        if (text[i] !== ':') fail('expected :')
        i++
        o[k] = value(depth + 1)
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return o }
        fail('expected , or }')
      }
    }
    if (c === '[') {
      i++
      const a: Json[] = []
      ws()
      if (text[i] === ']') { i++; return a }
      for (;;) {
        a.push(value(depth + 1))
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return a }
        fail('expected , or ]')
      }
    }
    if (c === '"') { const at = i; const s = str(); checkSurrogates(s, at); return s }
    if (text.startsWith('true', i)) { i += 4; return true }
    if (text.startsWith('false', i)) { i += 5; return false }
    if (text.startsWith('null', i)) { i += 4; return null }
    const m = /^-?(0|[1-9][0-9]*)/.exec(text.slice(i, i + 24))
    if (!m) return fail('unexpected token')
    const after = text[i + m[0].length]
    if (after === '.' || after === 'e' || after === 'E') fail('floats are not allowed')
    const n = Number(m[0])
    if (Object.is(n, -0)) fail('-0 is not allowed')
    if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_SAFE) fail('integer out of range')
    i += m[0].length
    return n
  }

  const v = value(0)
  ws()
  if (i !== text.length) fail('trailing data')
  return v
}

/** Strict parse of UTF-8 bytes (invalid UTF-8 and a BOM are errors). */
export function parseStrictBytes(bytes: Uint8Array): Json {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new JsonError('BOM', 0)
  return parseStrict(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
}
