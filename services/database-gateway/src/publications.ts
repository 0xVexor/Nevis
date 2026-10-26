// Private-publication mode (handoff §24-25): the desktop publishes an explicit, redacted form projection; the public submits answers that are
// validated here with the very same validator the desktop uses; the owner's app pulls them from the inbox, applies them with its own revision
// guards and acknowledges. A response is "received, pending import" until that acknowledgment: it is never called a database row early.
import { createHash, randomUUID } from 'node:crypto'
import type { Db } from './db.ts'
import { audit, tx } from './db.ts'
import type { Config } from './config.ts'
import { HttpError, RateLimiter, type Req } from './http.ts'
import { randomToken, requireOwner } from './auth.ts'
import { evaluateSubmission, validateFormConfig, visibleQuestions, type FormConfig, type Question } from '../../../spike/tiptap/src/database/forms.ts'
import type { Definition } from '../../../spike/tiptap/src/database/model/types.ts'
import { optionsOf } from '../../../spike/tiptap/src/database/props/config.ts'

/** Only what a respondent may see about a property. Never the raw Source JSON. */
export interface PublishedProperty {
  id: string
  kind: Definition['kind']
  name: string
  config: Record<string, unknown>
  /** labels for relation / people choices, limited to the ids a question's optionProjection lists */
  choices?: { id: string; label: string }[]
}
export interface PublishedForm {
  title: string
  form: FormConfig
  properties: PublishedProperty[]
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))
const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex')
const asDef = (p: PublishedProperty): Definition => ({ id: p.id, name: p.name, kind: p.kind, config: p.config, description: '', sourceId: 'published', sortKey: 'V', format: 1, revision: 1, deletedAt: null } as unknown as Definition)

function validatePublished(body: unknown): PublishedForm {
  const b = body as Partial<PublishedForm> | undefined
  if (!b || typeof b !== 'object' || typeof b.title !== 'string' || !b.form || !Array.isArray(b.form.questions) || !Array.isArray(b.properties)) throw new HttpError(400, 'invalid_publication', 'send { title, form, properties }')
  if (b.form.questions.length > 100) throw new HttpError(422, 'invalid_publication', 'a form has at most 100 questions')
  const props = new Map(b.properties.map((p) => [p.id, p]))
  for (const q of b.form.questions) if (!props.has(q.propertyId)) throw new HttpError(422, 'invalid_publication', 'a question refers to a property that was not published', { questionId: q.id })
  for (const p of b.properties) {
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.kind !== 'string') throw new HttpError(400, 'invalid_publication', 'a published property is malformed')
    try { if (['select', 'multi_select', 'status'].includes(p.kind)) optionsOf(asDef(p)) } catch (e) { throw new HttpError(422, 'invalid_publication', `property "${p.name}": ${(e as Error).message}`) }
  }
  for (const q of b.form.questions) if (props.get(q.propertyId)?.kind === 'files') throw new HttpError(422, 'unsupported_question', 'file uploads are not supported by this gateway; remove the file question', { questionId: q.id })
  const problems = validateFormConfig(b.form, (id) => (props.get(id) ? asDef(props.get(id)!) : undefined))
  if (problems.length) throw new HttpError(422, 'invalid_publication', problems[0].message, { problems })
  // only the properties that questions use are kept: the publication cannot leak the rest of the schema
  const used = new Set(b.form.questions.map((q) => q.propertyId))
  return { title: b.title.slice(0, 200), form: b.form, properties: b.properties.filter((p) => used.has(p.id)) }
}

function publicView(publicId: string, version: number, pub: PublishedForm) {
  const props = new Map(pub.properties.map((p) => [p.id, p]))
  return {
    publicId,
    version,
    title: pub.title,
    open: pub.form.open,
    anonymous: pub.form.anonymous,
    submitMessage: pub.form.submitMessage,
    questions: [...pub.form.questions].sort((a, b) => a.order - b.order).map((q: Question) => {
      const p = props.get(q.propertyId)!
      const cfg = p.config as { options?: { id: string; name: string; color?: string }[] }
      return {
        id: q.id, title: q.title || p.name, description: q.description, required: q.required, order: q.order, inputStyle: q.inputStyle, maxSelections: q.maxSelections, visibleWhen: q.visibleWhen ?? null,
        kind: p.kind,
        options: ['select', 'multi_select', 'status'].includes(p.kind) ? (cfg.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })) : undefined,
        choices: ['relation', 'people'].includes(p.kind) ? (p.choices ?? []).filter((c) => !q.optionProjection || q.optionProjection.includes(c.id)) : undefined,
      }
    }),
  }
}

export function publicationRoutes(db: Db, cfg: Config, limiter: RateLimiter, now: () => number = Date.now) {
  const current = (id: string) => db.prepare('SELECT * FROM publications WHERE id = ?').get(id) as { id: string; public_id: string; owner_id: string; version: number; status: string } | undefined
  const byPublic = (publicId: string) => db.prepare('SELECT * FROM publications WHERE public_id = ?').get(publicId) as { id: string; public_id: string; owner_id: string; version: number; status: string } | undefined
  const versionRow = (pid: string, v: number) => db.prepare('SELECT form_json, form_hash, created_at FROM publication_versions WHERE publication_id = ? AND version = ?').get(pid, v) as { form_json: string; form_hash: string; created_at: number } | undefined
  const owned = (req: Req) => {
    const owner = requireOwner(db, req)
    const p = current(req.params.id)
    if (!p || p.owner_id !== owner) throw new HttpError(404, 'not_found', 'publication not found')
    return { owner, p }
  }
  const linkOf = (publicId: string) => `${cfg.publicUrl}/v1/forms/${publicId}`

  return {
    create: (req: Req) => {
      const owner = requireOwner(db, req)
      const pub = validatePublished(req.body)
      const id = randomUUID()
      const publicId = randomToken(18)
      const t = now()
      tx(db, () => {
        db.prepare('INSERT INTO publications (id, public_id, owner_id, version, status, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, publicId, owner, 'active', t, t)
        db.prepare('INSERT INTO publication_versions (publication_id, version, form_json, form_hash, created_at) VALUES (?, 1, ?, ?, ?)').run(id, JSON.stringify(pub), hash(pub), t)
        audit(db, owner, 'publication.create', id)
      })
      return { status: 201, body: { id, publicId, version: 1, url: linkOf(publicId) } }
    },
    update: (req: Req) => {
      const { owner, p } = owned(req)
      if (p.status !== 'active') throw new HttpError(410, 'revoked', 'this publication was revoked')
      const b = req.body as { expectedVersion?: number } & Record<string, unknown>
      if (typeof b?.expectedVersion !== 'number') throw new HttpError(400, 'invalid_publication', 'expectedVersion is required')
      const pub = validatePublished(b)
      if (b.expectedVersion !== p.version) throw new HttpError(409, 'stale_version', 'the publication changed; reload it before updating', { currentVersion: p.version })
      const next = p.version + 1
      const t = now()
      tx(db, () => {
        db.prepare('INSERT INTO publication_versions (publication_id, version, form_json, form_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(p.id, next, JSON.stringify(pub), hash(pub), t)
        db.prepare('UPDATE publications SET version = ?, updated_at = ? WHERE id = ?').run(next, t, p.id)
        audit(db, owner, 'publication.update', p.id, { version: next })
      })
      return { body: { id: p.id, publicId: p.public_id, version: next, url: linkOf(p.public_id) } }
    },
    revoke: (req: Req) => {
      const { owner, p } = owned(req)
      tx(db, () => {
        db.prepare('UPDATE publications SET status = ?, revoked_at = ?, updated_at = ? WHERE id = ?').run('revoked', now(), now(), p.id)
        audit(db, owner, 'publication.revoke', p.id)
      })
      return { body: { id: p.id, status: 'revoked' } }
    },
    /** Owner view of one publication with counts; used by the desktop to show "N waiting for import". */
    status: (req: Req) => {
      const { p } = owned(req)
      const c = db.prepare('SELECT status, COUNT(*) AS n FROM submissions WHERE publication_id = ? GROUP BY status').all(p.id) as { status: string; n: number }[]
      return { body: { id: p.id, publicId: p.public_id, version: p.version, status: p.status, submissions: Object.fromEntries(c.map((r) => [r.status, r.n])) } }
    },
    form: (req: Req) => {
      const p = byPublic(req.params.publicId)
      if (!p) throw new HttpError(404, 'not_found', 'form not found')
      if (p.status !== 'active') throw new HttpError(410, 'revoked', 'this form is no longer available')
      const row = versionRow(p.id, p.version)!
      return { body: publicView(p.public_id, p.version, JSON.parse(row.form_json) as PublishedForm) }
    },
    submit: (req: Req) => {
      const rl = limiter.check(`${req.params.publicId}|${req.ip}`)
      if (!rl.ok) throw new HttpError(429, 'rate_limited', 'too many submissions; try again later', undefined, { 'retry-after': String(rl.retryAfterSec) })
      const p = byPublic(req.params.publicId)
      if (!p) throw new HttpError(404, 'not_found', 'form not found')
      if (p.status !== 'active') throw new HttpError(410, 'revoked', 'this form is no longer available')
      const b = req.body as { submissionId?: string; formVersion?: number; answers?: Record<string, unknown> } | undefined
      if (!b || typeof b.submissionId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(b.submissionId) || !b.answers || typeof b.answers !== 'object' || Array.isArray(b.answers)) throw new HttpError(400, 'invalid_submission', 'send { submissionId, formVersion, answers }')
      const version = b.formVersion ?? p.version
      if (!Number.isInteger(version) || version < 1 || version > p.version) throw new HttpError(400, 'invalid_version', 'unknown form version')
      if (version < p.version) {
        const replaced = versionRow(p.id, version + 1)!
        if (now() - replaced.created_at > cfg.staleVersionMs) throw new HttpError(409, 'refresh_required', 'this form changed; reload it and send your answers again', { currentVersion: p.version })
      }
      const row = versionRow(p.id, version)
      if (!row) throw new HttpError(409, 'refresh_required', 'this form version is no longer available', { currentVersion: p.version })
      const pub = JSON.parse(row.form_json) as PublishedForm
      if (!pub.form.open) throw new HttpError(403, 'closed', 'this form is not accepting answers')
      const contentHash = hash({ version, answers: b.answers })
      const have = db.prepare('SELECT receipt, content_hash, status FROM submissions WHERE publication_id = ? AND submission_id = ?').get(p.id, b.submissionId) as { receipt: string; content_hash: string; status: string } | undefined
      if (have) {
        if (have.content_hash !== contentHash) throw new HttpError(409, 'submission_conflict', 'this submission id was already used with different answers')
        return { status: 200, body: { receipt: have.receipt, status: have.status === 'pending' ? 'pending_import' : have.status, repeated: true } }
      }
      if (pub.form.limit) {
        const n = (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE publication_id = ?').get(p.id) as { n: number }).n
        if (n >= pub.form.limit) throw new HttpError(403, 'limit_reached', 'this form reached its response limit')
      }
      const props = new Map(pub.properties.map((x) => [x.id, x]))
      const asked = new Set(visibleQuestions(pub.form, b.answers as never).map((q) => q.id))
      const given = Object.fromEntries(Object.entries(b.answers).filter(([k]) => asked.has(k) || !pub.form.questions.some((q) => q.id === k)))
      const result = evaluateSubmission(pub.form, (id) => (props.get(id) ? asDef(props.get(id)!) : undefined), given as never)
      if (result.errors.length) throw new HttpError(422, 'invalid_answers', 'some answers are not valid', { errors: result.errors })
      // choices that were not offered are rejected here as well as in the validator: relations and people never accept foreign ids
      for (const q of pub.form.questions) {
        const prop = props.get(q.propertyId)
        const a = given[q.id]
        if (prop && (prop.kind === 'relation' || prop.kind === 'people') && a !== undefined) {
          const allowed = new Set((prop.choices ?? []).map((c) => c.id).filter((id) => !q.optionProjection || q.optionProjection.includes(id)))
          const ids = Array.isArray(a) ? a : [a]
          if (ids.some((x) => !allowed.has(String(x)))) throw new HttpError(422, 'invalid_answers', 'that choice is not offered by this form', { errors: [{ questionId: q.id, message: 'that choice is not offered by this form' }] })
        }
      }
      const receipt = randomToken(24)
      const seq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM submissions').get() as { m: number }).m ?? 0) + 1
      tx(db, () => {
        db.prepare('INSERT INTO submissions (id, publication_id, version, submission_id, content_hash, answers_json, receipt, ack_token, status, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), p.id, version, b.submissionId, contentHash, JSON.stringify(given), receipt, randomToken(24), 'pending', now(), seq)
      })
      return { status: 201, body: { receipt, status: 'pending_import', message: pub.form.submitMessage || null } }
    },
    receipt: (req: Req) => {
      const r = db.prepare('SELECT status, applied_at FROM submissions WHERE receipt = ?').get(req.params.receipt) as { status: string; applied_at: number | null } | undefined
      if (!r) throw new HttpError(404, 'not_found', 'receipt not found')
      return { body: { status: r.status === 'pending' ? 'pending_import' : r.status, appliedAt: r.applied_at } }
    },
    inbox: (req: Req) => {
      const owner = requireOwner(db, req)
      const cursor = Number(req.query.get('cursor') ?? 0) || 0
      const limit = Math.min(100, Math.max(1, Number(req.query.get('limit') ?? 50) || 50))
      const t = now()
      const rows = db.prepare(`SELECT s.id, s.publication_id, s.version, s.submission_id, s.answers_json, s.ack_token, s.created_at, s.seq FROM submissions s JOIN publications p ON p.id = s.publication_id
        WHERE p.owner_id = ? AND s.status = 'pending' AND s.seq > ? AND s.leased_until < ? ORDER BY s.seq LIMIT ?`).all(owner, cursor, t, limit) as { id: string; publication_id: string; version: number; submission_id: string; answers_json: string; ack_token: string; created_at: number; seq: number }[]
      const lease = db.prepare('UPDATE submissions SET leased_until = ? WHERE id = ?')
      for (const r of rows) lease.run(t + 60_000, r.id)
      return { body: { items: rows.map((r) => ({ id: r.id, publicationId: r.publication_id, formVersion: r.version, submissionId: r.submission_id, answers: JSON.parse(r.answers_json), ackToken: r.ack_token, createdAt: r.created_at, seq: r.seq })), nextCursor: rows.length ? rows[rows.length - 1].seq : cursor } }
    },
    ack: (req: Req) => {
      const owner = requireOwner(db, req)
      const b = req.body as { ackToken?: string; result?: { ok: boolean; operationId?: string; pageId?: string; reason?: string } } | undefined
      if (!b?.ackToken || !b.result || typeof b.result.ok !== 'boolean') throw new HttpError(400, 'invalid_ack', 'send { ackToken, result }')
      const s = db.prepare(`SELECT s.id, s.status, s.ack_token, s.result_json FROM submissions s JOIN publications p ON p.id = s.publication_id WHERE s.id = ? AND p.owner_id = ?`).get(req.params.id, owner) as { id: string; status: string; ack_token: string; result_json: string | null } | undefined
      if (!s) throw new HttpError(404, 'not_found', 'submission not found')
      if (s.ack_token !== b.ackToken) throw new HttpError(403, 'bad_ack_token', 'the acknowledgment token does not match')
      const next = b.result.ok ? 'applied' : 'rejected'
      if (s.status !== 'pending') {
        if (s.status === next && s.result_json === JSON.stringify(b.result)) return { body: { id: s.id, status: s.status, repeated: true } }
        throw new HttpError(409, 'already_acknowledged', 'this submission was already acknowledged differently')
      }
      tx(db, () => {
        db.prepare('UPDATE submissions SET status = ?, result_json = ?, applied_at = ? WHERE id = ?').run(next, JSON.stringify(b.result), now(), s.id)
        audit(db, owner, 'submission.ack', s.id, { status: next })
      })
      return { body: { id: s.id, status: next } }
    },
  }
}
