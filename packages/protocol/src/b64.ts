// base64url without padding (RFC 4648 §5): the encoding of the opaque payload `p` on the wire.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export const B64URL_RE = /^[A-Za-z0-9_-]*$/

export function b64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i]! << 16
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!
  }
  return out
}

/** Throws on any character outside the alphabet, on padding, and on a length that no byte string encodes to. */
export function b64urlDecode(s: string): Uint8Array {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) throw new Error('bad base64url')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let o = 0
  let buf = 0
  let bits = 0
  for (let i = 0; i < s.length; i++) {
    buf = (buf << 6) | LOOKUP[s.charCodeAt(i)]!
    bits += 6
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; buf &= (1 << bits) - 1 }
  }
  if (buf !== 0) throw new Error('bad base64url: non-zero trailing bits')
  return out
}
