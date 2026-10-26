// Form commands: configure a form view and accept a submission (one row, idempotent by submission id).
import type { Id, Json } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { evaluateSubmission, validateFormConfig, type FormConfig } from '../forms.ts'
import { register } from './coordinator.ts'
import { addEdge } from './relations.ts'
import { createRow } from './rows.ts'
import { view } from './util.ts'

register('form.configure', (cx, p: { viewId: Id; config: FormConfig }) => {
  const v = view(cx, p.viewId)
  if (v.type !== 'form' || !v.sourceId) fail('INVALID_VALUE', 'not a form view')
  cx.access.assertSource(cx.env.actorId, v.sourceId!, 'edit_schema')
  const problems = validateFormConfig(p.config, (id) => cx.d.prop(id))
  const cur = (v.configuration as { version?: number }).version ?? 0
  if (problems.length && p.config.open) fail('INVALID_VALUE', `the form cannot be opened: ${problems[0].message}`, { problems: problems as unknown as Json })
  cx.d.mut('view', v.id).configuration = { ...(p.config as unknown as Record<string, Json>), version: cur + 1 } as Json
  return { version: cur + 1, problems: problems as unknown as Json }
})

register('form.submit', (cx, p: { formViewId: Id; version: number; submissionId: Id; answers: Record<Id, Json>; respondentContext?: Json }) => {
  const evId = `form:${p.formViewId}:${p.submissionId}`
  const have = cx.d.get('event', evId)
  if (have) return { ...(have.data as Record<string, Json>), repeated: true }
  const v = view(cx, p.formViewId)
  if (v.type !== 'form' || !v.sourceId) fail('INVALID_VALUE', 'not a form view')
  const cfg = v.configuration as unknown as FormConfig
  if (!cfg.open) fail('NOT_FOUND', 'this form is closed')
  if (p.version !== cfg.version) fail('REVISION_CONFLICT', 'the form changed; refresh it and submit again', { expected: p.version, current: cfg.version })
  cx.access.assertSource(cx.env.actorId, v.sourceId!, 'create')
  const broken = validateFormConfig(cfg, (id) => cx.d.prop(id))
  if (broken.some((b) => b.code === 'BROKEN')) fail('SCHEMA_MISMATCH', 'a question is linked to a deleted property; repair the form first')
  const res = evaluateSubmission(cfg, (id) => cx.d.prop(id), p.answers)
  if (res.errors.length) fail('INVALID_VALUE', res.errors[0].message, { errors: res.errors as unknown as Json })
  const r = createRow(cx, { sourceId: v.sourceId!, explicitValues: res.cells, viewId: v.id, title: res.title ?? '' })
  for (const [pid, targets] of Object.entries(res.relations)) {
    const rel = cx.d.relationOf(pid)
    if (rel) for (const t of targets) addEdge(cx, rel, r.pageId, t, false)
  }
  const receipt = { receiptId: cx.ids(), pageId: cfg.anonymous ? null : r.pageId, submissionId: p.submissionId, version: cfg.version }
  cx.d.add('event', { ...cx.meta(evId), type: 'form_receipt', pageId: r.pageId, principalId: cfg.anonymous ? null : cx.env.actorId, data: receipt as unknown as Json })
  return receipt as unknown as Json
})
