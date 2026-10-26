// Buttons and automations (handoff §21). Internal data actions compile into one local batch; external effects go through a durable
// outbox after that batch committed. Run keys make double clicks, duplicate events and restarts idempotent; leases keep two
// devices from running the same schedule. Nothing here pretends exactly-once delivery to a webhook.
import type { Action, Cell, FormulaValue, Id, Json, WorkflowRecord } from '../model/types.ts'
import { DbError, fail } from '../model/errors.ts'
import { hash } from '../model/json.ts'
import { Coordinator, type ChangeEvent, type PageChange } from '../commands/coordinator.ts'
import { compileFormula } from '../formula/compile.ts'
import { evaluate } from '../formula/eval.ts'
import { dateV, pageV, personV, formatValue } from '../formula/values.ts'
import { DESCRIPTORS, findOptionByLabel, validateCell } from '../props/registry.ts'
import { optionsOf } from '../props/config.ts'
import { matchesFilter, runQuery, makeQuery } from '../query/engine.ts'
import { Resolver, schemaFor } from '../resolver.ts'
import { repeatOccurrences } from '../repeat.ts'
import { textToRuns } from '../text.ts'
import type { DbState, Row } from '../state.ts'
import type { LeaseStore } from './lease.ts'
import type { ExternalAdapter, OutboxEntry, SendResult } from './outbox.ts'
import { Access } from '../access.ts'

export const MAX_ACTIONS = 100
export const MAX_ROW_MUTATIONS = 1000
export const ALL_WINDOW_MS = 3000
export const BACKOFF_MS = [1000, 5000, 30_000, 300_000]
export const MAX_ATTEMPTS = 5

export interface RuntimeStore {
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}

export class MemoryRuntime implements RuntimeStore {
  m = new Map<string, Json>()
  async get(k: string) { return this.m.get(k) }
  async set(k: string, v: Json) { this.m.set(k, structuredClone(v)) }
  async delete(k: string) { this.m.delete(k) }
  async keys(prefix: string) { return [...this.m.keys()].filter((k) => k.startsWith(prefix)) }
}

export type RunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused' | 'cancelled'
export type ActionState = { index: number; type: string; state: 'pending' | 'done' | 'failed' | 'skipped' | 'queued'; error?: string }
export type RunData = {
  runKey: string
  workflowId: Id
  definitionRevision: number
  state: RunState
  attempt: number
  retryAt: number | null
  triggerPageId: Id | null
  origin: string
  actions: ActionState[]
  error?: string
  /** UI-side effects the run asks for (open a page); never executed by the engine */
  ui?: { type: 'open'; pageId?: Id; url?: string }[]
}

export type Preview = { confirmations: { title: string; message: string }[]; rowMutations: number; externalEffects: { type: string; connectionId: Id }[]; needsApproval: boolean }

type Value = FormulaValue
const typeOf = (v: Value): string => (v.kind === 'empty' ? 'any' : v.kind === 'list' ? 'list<any>' : v.kind)

export class WorkflowEngine {
  coord: Coordinator
  runtime: RuntimeStore
  lease: LeaseStore
  adapters: Map<string, ExternalAdapter>
  deviceId: Id
  now: () => number
  zone: string
  private pendingHandlers = new Set<Promise<unknown>>()
  private detach: (() => void) | null = null
  /** origins that may trigger automations (§21): user edits, buttons, imports. Automations, repeats and sync replays do not. */
  static TRIGGERING = new Set(['user', 'button', 'import'])

  constructor(o: { coord: Coordinator; runtime?: RuntimeStore; lease: LeaseStore; adapters?: ExternalAdapter[]; deviceId: Id; now?: () => number; zone?: string }) {
    this.coord = o.coord
    this.runtime = o.runtime ?? new MemoryRuntime()
    this.lease = o.lease
    this.adapters = new Map((o.adapters ?? []).map((a) => [a.type, a]))
    this.deviceId = o.deviceId
    this.now = o.now ?? Date.now
    this.zone = o.zone ?? 'UTC'
  }

  private get state(): DbState {
    return this.coord.state
  }

  attach() {
    this.detach = this.coord.subscribe((e) => {
      const p = this.onChange(e).catch((err) => console.error('workflow', err))
      this.pendingHandlers.add(p)
      void p.finally(() => this.pendingHandlers.delete(p))
    })
    return this
  }
  stop() {
    this.detach?.()
  }
  /** resolves when every trigger handler started so far has finished (tests, shutdown) */
  async idle() {
    while (this.pendingHandlers.size) await Promise.all([...this.pendingHandlers])
  }

  // ───── triggers ─────

  private rs(principalId: Id): Resolver {
    return new Resolver(this.state, { principalId, nowMs: this.now(), zone: this.zone, weekStart: 6 })
  }

  private triggerHits(wf: WorkflowRecord, ch: PageChange, row: Row, rs: Resolver): Set<number> {
    const hits = new Set<number>()
    wf.triggers.forEach((t, i) => {
      if (t.type === 'page_added') {
        if (ch.created || ch.membershipChanged) hits.add(i)
      } else if (t.type === 'property_changed') {
        if (!ch.cells[t.propertyId]) return
        if (t.predicate) {
          try { if (!matchesFilter(this.state, rs, t.predicate, row, this.now(), this.zone)) return } catch { return }
        }
        hits.add(i)
      }
    })
    return hits
  }

  async onChange(ev: ChangeEvent) {
    if (ev.external || !WorkflowEngine.TRIGGERING.has(ev.envelope.origin)) return
    const workflows = this.state.live('workflow').filter((w) => w.kind === 'automation' && w.enabled && !w.paused)
    if (!workflows.length) return
    for (const ch of ev.pages) {
      if (ch.trashed) continue
      const row = ch.sourceId ? this.state.row(ch.pageId) : undefined
      if (!row) continue
      for (const wf of workflows) {
        if (wf.sourceId !== row.sourceId || wf.triggers.some((t) => t.type === 'schedule')) continue
        const rs = this.rs(ev.envelope.actorId)
        const hits = this.triggerHits(wf, ch, row, rs)
        if (!hits.size) continue
        let fire = false
        if (wf.triggerMode === 'any') fire = true
        else {
          // ALL: edits must all happen inside a 3 second window; the pending window survives a restart
          const key = `pending:${wf.id}:${ch.pageId}`
          const cur = ((await this.runtime.get(key)) as { hits: Record<string, number> } | undefined) ?? { hits: {} }
          const t = this.now()
          for (const i of hits) cur.hits[i] = t
          for (const [i, at] of Object.entries(cur.hits)) if (t - at > ALL_WINDOW_MS) delete cur.hits[i]
          if (wf.triggers.every((_, i) => cur.hits[i] !== undefined)) { fire = true; await this.runtime.delete(key) }
          else await this.runtime.set(key, cur as unknown as Json)
        }
        if (!fire) continue
        // the page must be inside the trigger view *after* the mutation; pages that left the scope do not trigger
        if (wf.viewScopeId) {
          const v = this.state.get('view', wf.viewScopeId)
          if (v && !matchesFilter(this.state, rs, v.filter, row, this.now(), this.zone)) continue
        }
        await this.run(wf.id, { kind: 'automation', pageId: ch.pageId, eventId: `${ev.commit.operationId}:${ch.pageId}`, actorId: ev.envelope.actorId }).catch(() => undefined)
      }
    }
  }

  // ───── running ─────

  preview(workflowId: Id, pageId: Id | null): Preview {
    const wf = this.workflow(workflowId)
    let rowMutations = 0
    const confirmations: Preview['confirmations'] = []
    const ext: Preview['externalEffects'] = []
    for (const a of wf.actions) {
      if (a.type === 'confirm') confirmations.push({ title: a.title, message: a.message })
      else if (a.type === 'set_values') rowMutations += 1
      else if (a.type === 'create_page') rowMutations += 1
      else if (a.type === 'edit_matching') rowMutations += this.matching(a, wf, pageId).length
      else if (a.type === 'webhook' || a.type === 'email' || a.type === 'slack') ext.push({ type: a.type, connectionId: a.connectionId })
    }
    return { confirmations, rowMutations, externalEffects: ext, needsApproval: rowMutations > MAX_ROW_MUTATIONS }
  }

  private workflow(id: Id): WorkflowRecord {
    const wf = this.state.get('workflow', id)
    if (!wf || wf.deletedAt !== null) return fail('NOT_FOUND', 'workflow not found')
    return wf
  }

  private matching(a: Extract<Action, { type: 'edit_matching' }>, wf: WorkflowRecord, pageId: Id | null): Id[] {
    const q = a.query as { sourceId?: Id; filter?: never }
    const sid = q.sourceId ?? wf.sourceId
    const res = runQuery(this.state, makeQuery(this.state, sid, this.coord.state.live('principal').find((p) => p.isLocalOwner)?.id ?? '', new Date(this.now()).toISOString(), this.zone, { filter: q.filter ?? null, limit: 500 }))
    void pageId
    return res.matchIds
  }

  /** Run a button or automation. Idempotent per run key (workflow + definition revision + event / click). */
  async run(workflowId: Id, o: { kind: 'button' | 'automation' | 'schedule'; pageId?: Id | null; eventId: string; actorId: Id; confirmed?: boolean; approve?: boolean; dryRun?: boolean; scheduledAt?: number }): Promise<RunData> {
    const wf = this.workflow(workflowId)
    if (!wf.enabled || wf.paused) fail('INVALID_VALUE', 'this workflow is off or paused')
    const runKey = `${wf.id}|${wf.definitionRevision}|${o.eventId}`
    const runId = `run:${hash(runKey)}`
    const prior = this.state.get('event', runId)
    if (prior && !o.dryRun) return prior.data as unknown as RunData // double click / duplicate event / restart: the same run
    if (wf.actions.length > MAX_ACTIONS) fail('INVALID_VALUE', `a workflow has at most ${MAX_ACTIONS} actions`)
    const pre = this.preview(wf.id, o.pageId ?? null)
    if (pre.confirmations.length && o.kind === 'button' && !o.confirmed && !o.dryRun) fail('INVALID_VALUE', 'this button needs confirmation first', { confirmations: pre.confirmations as unknown as Json })
    if (pre.needsApproval && !o.approve) fail('INVALID_VALUE', `this run would change ${pre.rowMutations} rows; approve the bounded bulk scope first`)

    const data: RunData = {
      runKey, workflowId: wf.id, definitionRevision: wf.definitionRevision, state: 'running', attempt: 1, retryAt: null, triggerPageId: o.pageId ?? null,
      origin: o.kind, actions: wf.actions.map((a, index) => ({ index, type: a.type, state: 'pending' })), ui: [],
    }
    const trigRow = o.pageId ? this.state.row(o.pageId) : undefined
    if (o.kind === 'button') {
      if (!trigRow) fail('NOT_FOUND', 'the button row was not found')
      new Access(this.state).assertRow(o.actorId, trigRow!, 'edit_rows')
    }
    const vars: Record<string, Value> = { actor: personV(o.actorId), scheduledAt: dateV({ kind: 'datetime', start: new Date(o.scheduledAt ?? this.now()).toISOString(), end: null, timeZone: this.zone }) }
    if (o.pageId) vars.triggerPage = pageV(o.pageId, this.state.vaultId)
    const created = new Map<string, Id>()
    const segments: { commands: { type: string; payload: Json }[]; external?: { index: number; action: Action } }[] = [{ commands: [] }]
    const seg = () => segments[segments.length - 1]
    let mutations = 0
    const origin = o.kind === 'button' ? 'button' : 'automation'
    try {
      wf.actions.forEach((a, index) => {
        const st = data.actions[index]
        switch (a.type) {
          case 'confirm': st.state = 'skipped'; break
          case 'open': data.ui!.push({ type: 'open', pageId: a.pageId ?? (a.url ? undefined : o.pageId ?? undefined), url: a.url }); st.state = 'done'; break
          case 'define_variable': {
            vars[a.name] = this.evalExpr(a.expression, wf.sourceId, o.pageId ?? null, vars, o.actorId)
            st.state = 'done'
            break
          }
          case 'set_values': {
            const target = this.targetIds(a.target, o.pageId ?? null, created)
            for (const pid of target) {
              seg().commands.push({ type: 'row.patch', payload: { pageId: pid, cellChanges: this.cells(a.changes as Record<string, Json>, wf.sourceId, o.pageId ?? null, vars, o.actorId) as unknown as Json } })
              mutations++
            }
            st.state = 'done'
            break
          }
          case 'create_page': {
            const id = `wf-${hash(runKey + index)}`
            const values = this.cells(a.values as Record<string, Json>, a.sourceId, o.pageId ?? null, vars, o.actorId)
            const title = (a.values as { __title?: { expr?: string; text?: string } }).__title
            const t = title?.expr ? formatValue(this.evalExpr(title.expr, wf.sourceId, o.pageId ?? null, vars, o.actorId)) : (title?.text ?? '')
            seg().commands.push({ type: 'row.create', payload: { id, sourceId: a.sourceId, ...(a.templateId ? { templateId: a.templateId } : {}), explicitValues: values as unknown as Json, title: t } })
            const as = (a as { as?: string }).as
            if (as) created.set(as, id)
            mutations++
            st.state = 'done'
            break
          }
          case 'edit_matching': {
            const ids = this.matching(a, wf, o.pageId ?? null)
            for (const pid of ids) {
              seg().commands.push({ type: 'row.patch', payload: { pageId: pid, cellChanges: this.cells(a.changes as Record<string, Json>, (a.query as { sourceId?: Id }).sourceId ?? wf.sourceId, pid, vars, o.actorId) as unknown as Json } })
              mutations++
            }
            st.state = 'done'
            break
          }
          case 'notify':
          case 'webhook':
          case 'email':
          case 'slack': {
            segments.push({ commands: [], external: { index, action: a } })
            segments.push({ commands: [] })
            st.state = 'queued'
            break
          }
        }
        if (mutations > MAX_ROW_MUTATIONS && !o.approve) fail('INVALID_VALUE', `more than ${MAX_ROW_MUTATIONS} row changes need explicit approval`)
      })
    } catch (e) {
      data.state = 'failed'
      data.error = e instanceof DbError ? e.message : String(e)
      if (!o.dryRun) await this.saveRun(runId, data, o.actorId, !!prior)
      return data
    }
    if (o.dryRun) return { ...data, state: 'queued' }

    // internal batches, then the outbox; each batch has a stable operation id so a retry never repeats it
    let segIndex = 0
    try {
      for (const s of segments) {
        if (s.commands.length) {
          await this.coord.execute({ operationId: `wf:${hash(runKey)}:${segIndex}`, vaultId: this.state.vaultId, actorId: o.actorId, deviceId: this.deviceId, expected: [], origin, commands: s.commands })
          for (const [i, a] of wf.actions.entries()) if (data.actions[i].state === 'pending' && a.type !== 'confirm') data.actions[i].state = 'done'
        }
        if (s.external) {
          await this.enqueue(runKey, s.external.index, s.external.action, vars, o.actorId)
        }
        segIndex++
      }
      data.state = data.actions.some((a) => a.state === 'queued') ? 'queued' : 'succeeded'
      if (data.state === 'queued' && !data.actions.some((a) => a.state === 'queued')) data.state = 'succeeded'
    } catch (e) {
      data.state = 'failed'
      data.error = e instanceof DbError ? e.message : String(e)
      const idx = data.actions.findIndex((a) => a.state === 'pending')
      if (idx >= 0) data.actions[idx] = { ...data.actions[idx], state: 'failed', error: data.error }
    }
    await this.saveRun(runId, data, o.actorId, !!prior)
    return data
  }

  private async saveRun(id: Id, data: RunData, actorId: Id, exists: boolean) {
    await this.coord.execute({
      operationId: `wfrun:${id}:${data.state}:${data.attempt}`, vaultId: this.state.vaultId, actorId, deviceId: this.deviceId, expected: [], origin: 'automation',
      commands: [{ type: 'workflow.record_run', payload: { id, data: data as unknown as Json, create: !exists } }],
    })
  }

  // ───── expressions ─────

  private evalExpr(expr: string, sourceId: Id, pageId: Id | null, vars: Record<string, Value>, actorId: Id): Value {
    const types = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeOf(v)]))
    const c = compileFormula(expr, schemaFor(this.state, sourceId), types)
    if (!c.ok) fail('FORMULA_TYPE', c.diagnostics[0].message)
    const rs = this.rs(actorId)
    const row = pageId ? this.state.row(pageId) : undefined
    const env = row ? rs.formulaEnv(row) : { ...rs.formulaEnv({ page: { id: '', title: '' } as never, ext: undefined as never, sourceId }), currentPageId: '' }
    const r = evaluate(c.ast, env, { vars })
    if (r.state === 'ready') return r.value
    if (r.state === 'error') return fail('FORMULA_TYPE', r.diagnostics[0].message)
    return fail('ACCESS_DENIED', `the expression could not be evaluated (${r.state})`)
  }

  private targetIds(target: Json, triggerPageId: Id | null, created: Map<string, Id>): Id[] {
    if (target === 'trigger' || target === null) return triggerPageId ? [triggerPageId] : fail('INVALID_VALUE', 'this action needs a trigger page')
    if (typeof target === 'object' && !Array.isArray(target)) {
      const t = target as { created?: string; pageIds?: Id[] }
      if (t.created) { const id = created.get(t.created); if (!id) fail('INVALID_VALUE', `unknown created page "${t.created}" (handles are usable only after they are created)`); return [id!] }
      if (t.pageIds) return t.pageIds
    }
    return fail('INVALID_VALUE', 'unknown action target')
  }

  private cells(changes: Record<string, Json>, sourceId: Id, pageId: Id | null, vars: Record<string, Value>, actorId: Id): Record<Id, Cell | null> {
    const out: Record<Id, Cell | null> = {}
    for (const [pid, spec] of Object.entries(changes)) {
      if (pid === '__title') continue
      const def = this.state.prop(pid)
      if (!def) fail('NOT_FOUND', 'property not found', { propertyId: pid })
      const s = spec as { cell?: Cell | null; expr?: string }
      if (s.cell !== undefined) { out[pid] = s.cell; continue }
      if (s.expr) out[pid] = this.valueToCell(def!, this.evalExpr(s.expr, sourceId, pageId, vars, actorId))
    }
    return out
  }

  private valueToCell(def: { id: Id; kind: string; config: Json; name: string }, v: Value): Cell | null {
    const d = def as never
    const kind = DESCRIPTORS[def.kind as keyof typeof DESCRIPTORS].cellKind
    if (v.kind === 'empty') return null
    switch (kind) {
      case 'number': return v.kind === 'number' ? validateCell(d, { kind: 'number', value: v.value }) : fail('INVALID_VALUE', `${def.name} needs a number`)
      case 'text': return validateCell(d, { kind: 'text', runs: textToRuns(formatValue(v)) })
      case 'checkbox': return v.kind === 'boolean' ? { kind: 'checkbox', value: v.value } : fail('INVALID_VALUE', `${def.name} needs true or false`)
      case 'date': return v.kind === 'date' ? validateCell(d, { kind: 'date', value: v.value }) : fail('INVALID_VALUE', `${def.name} needs a date`)
      case 'select': case 'status': {
        const o = findOptionByLabel(optionsOf(d), formatValue(v))
        return o ? { kind: kind as 'select' | 'status', optionId: o.id } as Cell : fail('INVALID_VALUE', `no option "${formatValue(v)}" in ${def.name}`)
      }
      case 'url': case 'email': case 'phone': return validateCell(d, { kind, value: formatValue(v) } as Cell)
      case 'people': return v.kind === 'person' ? { kind: 'people', principalIds: [v.id] } : v.kind === 'list' ? { kind: 'people', principalIds: v.items.flatMap((i) => (i.kind === 'person' ? [i.id] : [])) } : fail('INVALID_VALUE', `${def.name} needs a person`)
      default: return fail('INVALID_VALUE', `${def.name} cannot be set from an expression`)
    }
  }

  // ───── outbox ─────

  private async enqueue(runKey: string, index: number, a: Action, vars: Record<string, Value>, actorId: Id) {
    const id = `out:${hash(runKey)}:${index}`
    if (this.state.get('event', id)) return
    const fmt = (s: string) => s.replace(/\{(\w+)\}/g, (_m, n) => (vars[n] ? formatValue(vars[n], (pid) => this.state.pages.get(pid)?.title) : `{${n}}`))
    const payload: Json =
      a.type === 'notify' ? { recipients: a.recipients, message: fmt(a.message) }
      : a.type === 'webhook' ? { request: a.request }
      : a.type === 'email' || a.type === 'slack' ? { message: JSON.parse(fmt(JSON.stringify(a.message))) }
      : null
    const entry: OutboxEntry = { id, runKey, actionIndex: index, type: a.type, connectionId: 'connectionId' in a ? a.connectionId : null, payload, state: 'queued', attempt: 0, retryAt: null, idempotencyKey: hash(runKey + ':' + index) }
    await this.coord.execute({
      operationId: `wfout:${id}`, vaultId: this.state.vaultId, actorId, deviceId: this.deviceId, expected: [], origin: 'automation',
      commands: [{ type: 'workflow.record_run', payload: { id, data: entry as unknown as Json, create: true } }],
    })
  }

  outbox(): OutboxEntry[] {
    return this.state.live('event').filter((e) => e.type === 'workflow_run' && e.id.startsWith('out:')).map((e) => e.data as unknown as OutboxEntry)
  }

  /** Deliver due outbox entries. Needs the execution lease; a second device does nothing. */
  async dispatchOutbox(limit = 50): Promise<{ sent: number; failed: number; paused: number; skipped: boolean }> {
    const token = await this.lease.acquire('outbox', this.deviceId, 30_000, this.now())
    if (!token) return { sent: 0, failed: 0, paused: 0, skipped: true }
    let sent = 0, failed = 0, paused = 0
    const actor = this.state.live('principal').find((p) => p.isLocalOwner)?.id ?? ''
    const due = this.outbox().filter((e) => (e.state === 'queued' || e.state === 'retry') && (e.retryAt ?? 0) <= this.now()).slice(0, limit)
    for (const e of due) {
      await this.lease.renew('outbox', this.deviceId, 30_000, this.now())
      const adapter = this.adapters.get(e.type)
      const upd = (patch: Partial<OutboxEntry>) => this.coord.execute({
        operationId: `wfout:${e.id}:${e.attempt}:${patch.state}`, vaultId: this.state.vaultId, actorId: actor, deviceId: this.deviceId, expected: [], origin: 'automation',
        commands: [{ type: 'workflow.record_run', payload: { id: e.id, data: { ...e, ...patch } as unknown as Json, create: false } }],
      })
      if (!adapter) { await upd({ state: 'paused', error: `no adapter for ${e.type}` }); paused++; continue }
      const attempt = e.attempt + 1
      const res: SendResult = await adapter.send({ entry: e, idempotencyKey: e.idempotencyKey }).catch((err): SendResult => ({ ok: false, retryable: true, code: 'UNCERTAIN', message: String(err) }))
      if (res.ok) { await upd({ state: 'succeeded', attempt, retryAt: null, error: undefined }); sent++; continue }
      if (res.code === 'MISSING_CREDENTIALS') { await upd({ state: 'paused', attempt, error: redact(res.message) }); paused++; continue }
      if (res.code === 'UNCERTAIN' && !adapter.supportsIdempotency) { await upd({ state: 'uncertain', attempt, error: redact(res.message) }); failed++; continue } // never blindly resend
      if (!res.retryable || attempt >= MAX_ATTEMPTS) { await upd({ state: 'failed', attempt, error: redact(res.message) }); failed++; continue }
      const wait = Math.max(res.retryAfterMs ?? 0, BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)])
      await upd({ state: 'retry', attempt, retryAt: this.now() + wait, error: redact(res.message) })
      failed++
    }
    await this.lease.release('outbox', this.deviceId)
    return { sent, failed, paused, skipped: false }
  }

  // ───── schedules ─────

  /** Run due scheduled automations. Only the lease holder executes; missed occurrences follow the repeat rules (preview above 30). */
  async runSchedules(nowMs = this.now(), approveMany = false): Promise<{ ran: number; pending: number; skipped: boolean }> {
    const token = await this.lease.acquire('schedules', this.deviceId, 60_000, nowMs)
    if (!token) return { ran: 0, pending: 0, skipped: true }
    let ran = 0, pending = 0
    const actor = this.state.live('principal').find((p) => p.isLocalOwner)?.id ?? ''
    for (const wf of this.state.live('workflow')) {
      if (wf.kind !== 'automation' || !wf.enabled || wf.paused) continue
      const trig = wf.triggers.find((t) => t.type === 'schedule')
      if (!trig || trig.type !== 'schedule') continue
      const r = trig.recurrence as unknown as import('../model/types.ts').RepeatSchedule
      const cursorKey = `cursor:${wf.id}:${wf.definitionRevision}`
      const after = ((await this.runtime.get(cursorKey)) as number | undefined) ?? Date.parse(`${r.startDate}T00:00:00Z`) - 86400000
      const occ = repeatOccurrences(r, wf.id, wf.definitionRevision, after, nowMs)
      if (occ.length > 30 && !approveMany) { pending += occ.length; continue }
      for (const o of occ) {
        await this.run(wf.id, { kind: 'schedule', eventId: o.key, actorId: actor, scheduledAt: o.scheduledMs, approve: approveMany }).catch(() => undefined)
        ran++
      }
      if (occ.length) await this.runtime.set(cursorKey, occ[occ.length - 1].scheduledMs)
    }
    await this.lease.release('schedules', this.deviceId)
    return { ran, pending, skipped: false }
  }
}

const redact = (s: string) => s.replace(/(bearer\s+)[\w.\-]+/gi, '$1***').replace(/(token|secret|key|password)=[^\s&]+/gi, '$1=***').slice(0, 300)
