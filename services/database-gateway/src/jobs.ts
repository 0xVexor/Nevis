// Scheduled jobs (handoff §21, §25): UTC occurrence ids from an IANA schedule, a durable lease per occurrence so a second runner can take over
// after a crash but never double-runs a live one, bounded retry, and a pause (not a guess) when the published context went stale.
import { randomUUID } from 'node:crypto'
import type { Db } from './db.ts'
import { audit, tx } from './db.ts'
import type { Config } from './config.ts'
import { HttpError, type Req } from './http.ts'
import { requireOwner } from './auth.ts'
import { MAX_ATTEMPTS, Outbox, type WebhookRequest } from './outbox.ts'
import { civilOf, isValidZone, startOfDayMs, zonedParts, zonedToEpoch } from '../../../spike/tiptap/src/database/dates.ts'

export type Schedule = { kind: 'every'; minutes: number } | { kind: 'daily'; at: string }
export interface JobDefinition {
  schedule: Schedule
  action: WebhookRequest
  /** the job evaluates published values: pause when they are older than the freshness window */
  requiresFresh?: boolean
}

const LEASE_MS = 60_000

/** Occurrence timestamps (UTC ms) of a schedule inside (after, upTo]. Daily jobs follow the zone's wall clock across DST. */
export function occurrences(s: Schedule, zone: string, after: number, upTo: number): number[] {
  const out: number[] = []
  if (s.kind === 'every') {
    const step = s.minutes * 60_000
    for (let t = Math.floor(after / step) * step + step; t <= upTo && out.length < 1000; t += step) out.push(t)
    return out
  }
  const [h, m] = s.at.split(':').map(Number)
  let day = civilOf(after, zone)
  for (let i = 0; i < 400; i++) {
    const p = { ...zonedParts(startOfDayMs(day, zone), zone), h, mi: m, s: 0, ms: 0 }
    const t = zonedToEpoch(p, zone)
    if (t > upTo) break
    if (t > after) out.push(t)
    day = civilOf(startOfDayMs(day, zone) + 36 * 3600_000, zone)
  }
  return out
}

export const occurrenceId = (jobId: string, atMs: number) => `${jobId}:${new Date(atMs).toISOString().slice(0, 16)}Z`

function validateDefinition(d: unknown): JobDefinition {
  const j = d as Partial<JobDefinition> | undefined
  const s = j?.schedule
  if (!s || (s.kind !== 'every' && s.kind !== 'daily')) throw new HttpError(422, 'invalid_job', 'schedule.kind must be "every" or "daily"')
  if (s.kind === 'every' && !(Number.isInteger(s.minutes) && s.minutes >= 1 && s.minutes <= 7 * 24 * 60)) throw new HttpError(422, 'invalid_job', 'schedule.minutes must be 1..10080')
  if (s.kind === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) throw new HttpError(422, 'invalid_job', 'schedule.at must be HH:MM')
  if (!j?.action || j.action.type !== 'webhook' || typeof j.action.url !== 'string') throw new HttpError(422, 'invalid_job', 'action must be a webhook with a url')
  return { schedule: s, action: j.action, requiresFresh: !!j.requiresFresh }
}

export class JobRunner {
  db: Db
  cfg: Config
  outbox: Outbox
  holder: string
  now: () => number
  constructor(db: Db, cfg: Config, outbox: Outbox, holder: string = randomUUID(), now: () => number = Date.now) {
    this.db = db
    this.cfg = cfg
    this.outbox = outbox
    this.holder = holder
    this.now = now
  }

  /** Create the run rows that are due (at most one catch-up per job after downtime) and execute them under a lease. */
  async tick(): Promise<void> {
    const t = this.now()
    const jobs = this.db.prepare("SELECT id, owner_id, definition_json, time_zone, context_published_at, created_at FROM jobs WHERE status = 'active'").all() as { id: string; owner_id: string; definition_json: string; time_zone: string; context_published_at: number; created_at: number }[]
    for (const job of jobs) {
      const def = JSON.parse(job.definition_json) as JobDefinition
      const last = (this.db.prepare('SELECT MAX(occurrence_id) AS m FROM job_runs WHERE job_id = ?').get(job.id) as { m: string | null }).m
      const lastAt = last ? Date.parse(last.slice(job.id.length + 1)) : job.created_at
      const due = occurrences(def.schedule, job.time_zone, lastAt, t)
      const run = due.slice(-1) // one catch-up on the next start, not a flood
      for (const at of run) {
        const occ = occurrenceId(job.id, at)
        this.db.prepare('INSERT OR IGNORE INTO job_runs (job_id, occurrence_id, status) VALUES (?, ?, ?)').run(job.id, occ, 'queued')
      }
    }
    const queued = this.db.prepare("SELECT r.job_id, r.occurrence_id, r.attempts, j.definition_json, j.owner_id, j.context_published_at FROM job_runs r JOIN jobs j ON j.id = r.job_id WHERE r.status IN ('queued','retrying') AND (r.retry_at IS NULL OR r.retry_at <= ?) AND j.status = 'active' LIMIT 50").all(t) as { job_id: string; occurrence_id: string; attempts: number; definition_json: string; owner_id: string; context_published_at: number }[]
    for (const r of queued) await this.runOccurrence(r)
  }

  private lease(key: string): boolean {
    const t = this.now()
    return tx(this.db, () => {
      const cur = this.db.prepare("SELECT holder, expires_at FROM leases WHERE domain = 'job' AND key = ?").get(key) as { holder: string; expires_at: number } | undefined
      if (cur && cur.expires_at > t && cur.holder !== this.holder) return false
      this.db.prepare("INSERT INTO leases (domain, key, holder, expires_at) VALUES ('job', ?, ?, ?) ON CONFLICT (domain, key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at").run(key, this.holder, t + LEASE_MS)
      return true
    })
  }

  private async runOccurrence(r: { job_id: string; occurrence_id: string; attempts: number; definition_json: string; owner_id: string; context_published_at: number }) {
    if (!this.lease(r.occurrence_id)) return // another runner holds the lease
    const def = JSON.parse(r.definition_json) as JobDefinition
    const t = this.now()
    if (def.requiresFresh && t - r.context_published_at > this.cfg.freshnessMs) {
      this.db.prepare("UPDATE job_runs SET status = 'paused_stale', error = ?, finished_at = ? WHERE job_id = ? AND occurrence_id = ?").run('the published context is older than the freshness window; publish again from the app', t, r.job_id, r.occurrence_id)
      return
    }
    const attempt = r.attempts + 1
    this.db.prepare("UPDATE job_runs SET status = 'running', attempts = ?, started_at = COALESCE(started_at, ?) WHERE job_id = ? AND occurrence_id = ?").run(attempt, t, r.job_id, r.occurrence_id)
    // the occurrence id is the external idempotency key: a retry or a lease takeover cannot send twice to a receiver that deduplicates
    const key = r.occurrence_id
    const have = this.outbox.get(key, r.owner_id)
    if (!have) this.outbox.enqueue(r.owner_id, key, def.action)
    await this.outbox.dispatchDue(1)
    const out = this.outbox.get(key, r.owner_id)!
    const res = out.result ? (JSON.parse(out.result) as { reason?: string }) : {}
    const map: Record<string, string> = { succeeded: 'succeeded', failed: 'failed', needs_review: 'needs_review', retrying: 'retrying', queued: 'retrying', sending: 'running' }
    const status = map[out.status] ?? 'failed'
    this.db.prepare('UPDATE job_runs SET status = ?, retry_at = ?, error = ?, finished_at = ? WHERE job_id = ? AND occurrence_id = ?')
      .run(status, out.retryAt, status === 'succeeded' ? null : (res.reason ?? null), status === 'retrying' || status === 'running' ? null : this.now(), r.job_id, r.occurrence_id)
    if (status === 'failed' && attempt >= MAX_ATTEMPTS) audit(this.db, 'runner', 'job.failed', r.job_id, { occurrence: r.occurrence_id })
  }
}

export function jobRoutes(db: Db, now: () => number = Date.now) {
  const owned = (req: Req) => {
    const owner = requireOwner(db, req)
    const j = db.prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ?').get(req.params.id, owner) as { id: string; status: string; time_zone: string; definition_json: string; context_published_at: number } | undefined
    if (!j) throw new HttpError(404, 'not_found', 'job not found')
    return { owner, j }
  }
  return {
    create: (req: Req) => {
      const owner = requireOwner(db, req)
      const b = req.body as { definition?: unknown; timeZone?: string; contextPublishedAt?: number } | undefined
      if (!b?.timeZone || !isValidZone(b.timeZone)) throw new HttpError(422, 'invalid_job', 'timeZone must be an IANA zone such as Asia/Tehran')
      const def = validateDefinition(b.definition)
      const id = randomUUID()
      const t = now()
      tx(db, () => {
        db.prepare('INSERT INTO jobs (id, owner_id, definition_json, time_zone, status, context_published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, owner, JSON.stringify(def), b.timeZone, 'active', typeof b.contextPublishedAt === 'number' ? b.contextPublishedAt : t, t)
        audit(db, owner, 'job.create', id)
      })
      return { status: 201, body: { id, status: 'active' } }
    },
    runs: (req: Req) => {
      const { j } = owned(req)
      const rows = db.prepare('SELECT occurrence_id AS occurrenceId, status, attempts, retry_at AS retryAt, error, started_at AS startedAt, finished_at AS finishedAt FROM job_runs WHERE job_id = ? ORDER BY occurrence_id DESC LIMIT 100').all(j.id)
      return { body: { id: j.id, status: j.status, timeZone: j.time_zone, runs: rows } }
    },
    pause: (req: Req) => {
      const { owner, j } = owned(req)
      db.prepare("UPDATE jobs SET status = 'paused' WHERE id = ?").run(j.id)
      audit(db, owner, 'job.pause', j.id)
      // an effect that is already in flight keeps its visible state; only new occurrences stop
      return { body: { id: j.id, status: 'paused' } }
    },
    /** Re-publish the context a job evaluates (resets the freshness clock). */
    touch: (req: Req) => {
      const { j } = owned(req)
      db.prepare('UPDATE jobs SET context_published_at = ? WHERE id = ?').run(now(), j.id)
      return { body: { id: j.id } }
    },
  }
}
