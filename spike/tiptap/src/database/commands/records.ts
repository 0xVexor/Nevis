// Generic validated records: templates, workflows, comments, principals, grants, events (never row / property semantics).
import type { Id, Json, RecordKind } from '../model/types.ts'
import { RIGHT_ORDER } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { register, type Ctx } from './coordinator.ts'

const PUT_KINDS: RecordKind[] = ['template', 'workflow', 'comment', 'principal', 'grant', 'event']
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const obj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v)

function validate(cx: Ctx, kind: RecordKind, b: Record<string, Json>, existing: boolean) {
  const req = (cond: boolean, msg: string) => { if (!cond) fail('INVALID_VALUE', `${kind}: ${msg}`) }
  switch (kind) {
    case 'template':
      req(isStr(b.sourceId) && !!cx.d.get('source', b.sourceId as Id), 'sourceId must name an existing source')
      cx.access.assertSource(cx.env.actorId, b.sourceId as Id, 'edit_schema')
      req(typeof b.name === 'string', 'name required')
      req(obj(b.defaults), 'defaults must be an object')
      for (const pid of Object.keys(b.defaults as object)) req(!!cx.d.prop(pid), `unknown property ${pid}`)
      break
    case 'workflow':
      req(isStr(b.sourceId) && !!cx.d.get('source', b.sourceId as Id), 'sourceId must name an existing source')
      cx.access.assertSource(cx.env.actorId, b.sourceId as Id, 'edit_schema')
      req(['button', 'automation'].includes(b.kind as string), 'kind must be button or automation')
      req(Array.isArray(b.actions) && (b.actions as Json[]).length <= 100, 'at most 100 actions')
      break
    case 'comment':
      req(isStr(b.pageId) && !!cx.d.page(b.pageId as Id), 'pageId must exist')
      req(Array.isArray(b.body) && (b.body as Json[]).length > 0, 'a comment cannot be empty')
      if (isStr(b.propertyId)) {
        const def = cx.d.prop(b.propertyId as Id)
        req(!!def, 'unknown property')
        req(!['title', 'formula', 'rollup', 'button', 'unique_id'].includes(def!.kind), `comments are not allowed on ${def!.kind} properties`)
        const cell = cx.d.page(b.pageId as Id)?.database?.cells[b.propertyId as Id]?.value
        req(!!cell && !(cell.kind === 'text' && !cell.runs.length), 'an empty property cannot be commented')
      }
      break
    case 'principal':
      cx.access.assertSource(cx.env.actorId, [...cx.d.live('source')][0]?.id ?? '', 'manage')
      req(isStr(b.displayName), 'displayName required')
      break
    case 'grant':
      req(RIGHT_ORDER.includes(b.right as never), 'unknown right')
      req(isStr(b.principalId), 'principalId required')
      req(!!(b.sourceId || b.containerId || b.pageId), 'a grant needs a scope')
      cx.access.assertSource(cx.env.actorId, (b.sourceId as Id) ?? [...cx.d.live('source')][0]?.id ?? '', 'manage')
      if (b.propertyId) {
        const def = cx.d.prop(b.propertyId as Id)
        req(!!def && !['title', 'unique_id', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by'].includes(def.kind), 'this property cannot be restricted')
        const restricted = new Set(cx.d.live('grant').filter((g) => g.propertyId && g.id !== (b.id as string)).map((g) => g.propertyId))
        req(restricted.has(def!.id) || restricted.size < 20, 'at most 20 restricted properties per source')
      }
      break
    case 'event':
      req(isStr(b.type), 'type required')
      break
  }
  void existing
}

register('record.put', (cx, p: { kind: RecordKind; id?: Id; body: Record<string, Json> }) => {
  if (!PUT_KINDS.includes(p.kind)) fail('INVALID_COMMAND', `${p.kind} records are written by their own commands`)
  if (!obj(p.body)) fail('INVALID_VALUE', 'body must be an object')
  const id = p.id ?? cx.ids()
  const have = cx.d.get(p.kind, id)
  if (!have && p.id && cx.d.get(p.kind, p.id)) fail('INVALID_VALUE', 'id collision with different content')
  validate(cx, p.kind, p.body, !!have)
  if (have) {
    const m = cx.d.mut(p.kind, id) as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(p.body)) if (!['id', 'vaultId', 'revision', 'createdAt', 'createdBy', 'format'].includes(k)) m[k] = structuredClone(v)
  } else {
    const base = cx.meta(id) as unknown as Record<string, unknown>
    cx.d.add(p.kind, { ...structuredClone(p.body), ...base } as never)
  }
  return { id }
})

register('record.trash', (cx, p: { kind: RecordKind; id: Id }) => {
  if (!PUT_KINDS.includes(p.kind)) fail('INVALID_COMMAND', `${p.kind} records are deleted by their own commands`)
  const r = cx.d.get(p.kind, p.id)
  if (!r) fail('NOT_FOUND', 'record not found')
  cx.d.mut(p.kind, p.id).deletedAt = cx.now
})

/** Workflow run / outbox state lives in event records; this command is the only writer (origin automation, so it never retriggers). */
register('workflow.record_run', (cx, p: { id: Id; data: Json; create?: boolean }) => {
  const have = cx.d.get('event', p.id)
  if (have) cx.d.mut('event', p.id).data = p.data
  else cx.d.add('event', { ...cx.meta(p.id), type: 'workflow_run', pageId: null, principalId: null, data: p.data })
})

/** Saving a workflow bumps its definition revision, so run keys of the old definition never collide with the new one. */
register('workflow.save', (cx, p: { id?: Id; body: Record<string, Json> }) => {
  const id = p.id ?? cx.ids()
  const have = cx.d.get('workflow', id)
  validate(cx, 'workflow', have ? ({ ...(have as unknown as Record<string, Json>), ...p.body }) : p.body, !!have)
  if (have) {
    const m = cx.d.mut('workflow', id) as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(p.body)) if (!['id', 'vaultId', 'revision', 'createdAt', 'createdBy', 'format', 'definitionRevision'].includes(k)) m[k] = structuredClone(v)
    ;(m as { definitionRevision: number }).definitionRevision = have.definitionRevision + 1
  } else cx.d.add('workflow', { ...structuredClone(p.body), ...cx.meta(id), definitionRevision: 1, enabled: p.body.enabled ?? true, paused: false, triggers: p.body.triggers ?? [], triggerMode: p.body.triggerMode ?? 'any', viewScopeId: p.body.viewScopeId ?? null, propertyId: p.body.propertyId ?? null } as never)
  return { id }
})
