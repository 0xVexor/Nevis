// Passwords, device tokens, recovery keys, the registration proof of work and a small rate limiter.
// Nothing here needs an e-mail address or a phone number: an account is a username, a password and a recovery key.

import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT = { N: 1 << 15, r: 8, p: 1 }
const KEYLEN = 32

const scryptAsync = (pw, salt, opts) =>
  new Promise((resolve, reject) => scrypt(pw, salt, KEYLEN, { ...opts, maxmem: 128 * opts.N * opts.r * 2 }, (e, k) => (e ? reject(e) : resolve(k))))

export const sha256hex = (v) => createHash('sha256').update(v).digest('hex')

/** `scrypt$N$r$p$salt$hash`, so the cost can be raised later without locking anyone out. */
export async function hashPassword(pw) {
  const salt = randomBytes(16)
  const key = await scryptAsync(pw.normalize('NFKC'), salt, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(pw, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$')
  if (kind !== 'scrypt') return false
  const key = await scryptAsync(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p })
  const want = Buffer.from(hash, 'base64')
  return key.length === want.length && timingSafeEqual(key, want)
}

/** Burned for an unknown user name, so that "no such user" takes as long as "wrong password". */
export const DUMMY_HASH = await hashPassword('noviq-dummy-password')

export const newToken = () => `nvq_${randomBytes(32).toString('base64url')}`
export const newId = () => crypto.randomUUID()

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

/** 20 characters of a 32 letter alphabet = 100 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX. */
export function newRecoveryKey() {
  const chars = Array.from({ length: 20 }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)])
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-')
}

export const normalizeRecoveryKey = (k) => String(k ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
export const recoveryHash = (k) => sha256hex(`recovery:${normalizeRecoveryKey(k)}`)

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

// ───── proof of work (registration and recovery): costs a bot time, costs a person a second ─────

const hmac = (secret, body) => createHmac('sha256', secret).update(body).digest('base64url')

export function makeChallenge(secret, now = Date.now()) {
  const body = `${now.toString(36)}.${randomBytes(12).toString('hex')}`
  return `${body}.${hmac(secret, body)}`
}

export function leadingZeroBits(buf) {
  let n = 0
  for (const byte of buf) {
    if (byte === 0) {
      n += 8
      continue
    }
    return n + Math.clz32(byte) - 24
  }
  return n
}

/** Returns `{ ok: true, nonce }`, or `{ ok: false, error }`. The caller records the nonce so it cannot be used twice. */
export function checkPow(secret, challenge, counter, bits, now = Date.now()) {
  if (bits <= 0) return { ok: true, nonce: '' }
  const parts = String(challenge ?? '').split('.')
  if (parts.length !== 3) return { ok: false, error: 'bad_challenge' }
  const [ts, nonce, sig] = parts
  const want = hmac(secret, `${ts}.${nonce}`)
  if (!safeEqualHex(sig, want)) return { ok: false, error: 'bad_challenge' }
  const age = now - Number.parseInt(ts, 36)
  if (!(age >= 0 && age < 10 * 60 * 1000)) return { ok: false, error: 'challenge_expired' }
  const digest = createHash('sha256').update(`${challenge}:${counter}`).digest()
  if (leadingZeroBits(digest) < bits) return { ok: false, error: 'bad_pow' }
  return { ok: true, nonce }
}

/** The work a client does; used by the tests and by anyone scripting a registration. */
export function solvePow(challenge, bits) {
  for (let counter = 0; ; counter++) {
    if (leadingZeroBits(createHash('sha256').update(`${challenge}:${counter}`).digest()) >= bits) return counter
  }
}

// ───── fixed window rate limiter ─────

export class Limiter {
  constructor(now = () => Date.now()) {
    this.now = now
    this.map = new Map()
  }
  /** Counts one hit. `ok` is false once `max` is exceeded within `windowMs`. */
  hit(key, max, windowMs) {
    const t = this.now()
    let e = this.map.get(key)
    if (!e || e.reset <= t) {
      e = { n: 0, reset: t + windowMs }
      this.map.set(key, e)
    }
    e.n++
    return { ok: e.n <= max, retry: Math.max(1, Math.ceil((e.reset - t) / 1000)) }
  }
  /** True while the key has used up its allowance (without counting a new hit). */
  blocked(key, max) {
    const e = this.map.get(key)
    return !!e && e.reset > this.now() && e.n >= max ? Math.max(1, Math.ceil((e.reset - this.now()) / 1000)) : 0
  }
  clear(key) {
    this.map.delete(key)
  }
  sweep() {
    const t = this.now()
    for (const [k, e] of this.map) if (e.reset <= t) this.map.delete(k)
  }
}
