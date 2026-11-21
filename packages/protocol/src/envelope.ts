// The envelope: the only thing the server reads (ADR-0005). Everything else is the opaque payload `p`.
import { b64urlDecode, B64URL_RE } from './b64'
import { parseHlc } from './hlc'
import { isUuid } from './ids'
import { JsonError, parseStrict, type Json } from './json'

export interface Envelope {
  v: 1
  op: string
  ws: string
  doc: string
  dev: string
  t: string
  sv: number
  kid: number
  /** nonce; only when kid > 0 */
  n?: string
  /** opaque payload, base64url without padding */
  p: string
  /** only on snapshot ops */
  cov?: number
  /** a PURGE op: the permanent deletion of the document (M13) */
  pg?: 1
}

export class EnvelopeError extends Error {
  readonly code = 'bad_envelope'
  constructor(message: string) { super(message) }
}

const KEYS = new Set(['v', 'op', 'ws', 'doc', 'dev', 't', 'sv', 'kid', 'n', 'p', 'cov', 'pg'])
export const MAX_P_CHARS = 1_500_000

/** Fixed key order, no spaces: the bytes that go to the outbox and on the wire. */
export function encodeEnvelope(e: Envelope): string {
  const o: Record<string, unknown> = { v: e.v, op: e.op, ws: e.ws, doc: e.doc, dev: e.dev, t: e.t, sv: e.sv, kid: e.kid }
  if (e.n !== undefined) o.n = e.n
  o.p = e.p
  if (e.cov !== undefined) o.cov = e.cov
  if (e.pg !== undefined) o.pg = e.pg
  return JSON.stringify(o)
}

const int = (v: Json | undefined, min: number, name: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new EnvelopeError(`${name} must be an integer >= ${min}`)
  return v
}
const uuid = (v: Json | undefined, name: string): string => { if (!isUuid(v)) throw new EnvelopeError(`${name} must be a UUID`); return v }

/** Validates an already-parsed object. */
export function validateEnvelope(o: Json): Envelope {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new EnvelopeError('envelope must be an object')
  for (const k of Object.keys(o)) if (!KEYS.has(k)) throw new EnvelopeError(`unknown field "${k}"`)
  if (o.v !== 1) throw new EnvelopeError('v must be 1')
  const kid = int(o.kid, 0, 'kid')
  const env: Envelope = { v: 1, op: uuid(o.op, 'op'), ws: uuid(o.ws, 'ws'), doc: uuid(o.doc, 'doc'), dev: uuid(o.dev, 'dev'), t: '', sv: int(o.sv, 1, 'sv'), kid, p: '' }
  if (typeof o.t !== 'string' || !parseHlc(o.t)) throw new EnvelopeError('t must be an HLC')
  env.t = o.t
  if (typeof o.p !== 'string' || !B64URL_RE.test(o.p) || o.p.length > MAX_P_CHARS) throw new EnvelopeError('p must be base64url without padding')
  try { b64urlDecode(o.p) } catch { throw new EnvelopeError('p is not valid base64url') }
  env.p = o.p
  if (o.n !== undefined) {
    if (kid === 0) throw new EnvelopeError('n is only allowed when kid > 0')
    if (typeof o.n !== 'string' || !B64URL_RE.test(o.n)) throw new EnvelopeError('n must be base64url')
    env.n = o.n
  }
  if (o.cov !== undefined) env.cov = int(o.cov, 0, 'cov')
  if (o.pg !== undefined) {
    if (o.pg !== 1) throw new EnvelopeError('pg must be 1')
    if (env.cov !== undefined) throw new EnvelopeError('a purge op has no cov')
    env.pg = 1
  }
  return env
}

/** Strict parse + validate. Every failure is an `EnvelopeError` (`bad_envelope`). */
export function parseEnvelope(text: string): Envelope {
  let json: Json
  try { json = parseStrict(text) } catch (e) { throw new EnvelopeError(e instanceof JsonError ? e.message : String(e)) }
  return validateEnvelope(json)
}
