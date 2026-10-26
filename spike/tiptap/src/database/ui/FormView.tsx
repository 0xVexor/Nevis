// Form view: a builder for editors (questions linked to properties, required, branching, open/closed) and a fill / preview mode that
// submits through the same validator the gateway uses. Drafts of unsent answers live only in this browser. A hosted public link needs
// the gateway, which is not configured here: the panel says so instead of showing a link that would not work.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { Definition, Id, Json } from '../model/types.ts'
import { validateFormConfig, visibleQuestions, answerToCell, evaluateSubmission, type FormConfig, type Question, type Condition } from '../forms.ts'
import { optionsOf } from '../props/config.ts'
import { randomId } from '../model/ids.ts'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { errorText } from './common'
import { Field, Seg, Switch } from './forms'
import { GatewayClient, GatewayError, buildPublication, gatewayConfig, loadLinks, saveLink, type PublicationLink } from '../gateway/client'
import type { ViewProps } from './viewTypes'

const EMPTY: FormConfig = { questions: [], version: 0, open: false, anonymous: false, submitMessage: '' }
const BLOCKED_KINDS = ['formula', 'rollup', 'button', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'connected', 'verification', 'title2']
const draftKey = (viewId: Id) => `not.db.formdraft.${viewId}`

function Answer({ def, q, value, onChange, svc, err }: { def: Definition; q: Question; value: Json | undefined; onChange: (v: Json) => void; svc: ViewProps['svc']; err?: string }) {
  const id = 'fq-' + q.id
  const opts = optionsOf(def)
  const common = { id, 'aria-invalid': !!err, 'aria-describedby': err ? id + '-e' : undefined, dir: 'auto' as const }
  let input: ReactElement
  switch (def.kind) {
    case 'select': case 'status':
      input = q.inputStyle === 'radio'
        ? <div role="radiogroup" aria-labelledby={id + '-l'}>{opts.map((o) => <label key={o.id} className="db-radio"><input type="radio" name={id} checked={value === o.id} onChange={() => onChange(o.id)} /> {o.name}</label>)}</div>
        : <select {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}><option value="">{t('Choose…')}</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      break
    case 'multi_select': {
      const cur = (Array.isArray(value) ? value : []) as string[]
      input = <div role="group" aria-labelledby={id + '-l'}>{opts.map((o) => <label key={o.id} className="db-radio"><input type="checkbox" checked={cur.includes(o.id)} disabled={!cur.includes(o.id) && !!q.maxSelections && cur.length >= q.maxSelections} onChange={(e) => onChange(e.target.checked ? [...cur, o.id] : cur.filter((x) => x !== o.id))} /> {o.name}</label>)}</div>
      break
    }
    case 'checkbox':
      input = <label className="db-radio"><input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {def.name}</label>
      break
    case 'number':
      input = <input {...common} inputMode="decimal" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'date':
      input = <input {...common} type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'relation': {
      const rel = svc.state.relationOf(def.id)
      const targets = q.optionProjection ?? []
      const cur = (Array.isArray(value) ? value : []) as string[]
      input = <div role="group" aria-labelledby={id + '-l'}>{targets.length === 0 ? <small>{t('No choices are available.')}</small> : targets.map((tid) => <label key={tid} className="db-radio"><input type="checkbox" checked={cur.includes(tid)} onChange={(e) => onChange(e.target.checked ? [...cur, tid] : cur.filter((x) => x !== tid))} /> {svc.state.pages.get(tid)?.title ?? tid}</label>)}{rel ? null : null}</div>
      break
    }
    default:
      input = q.inputStyle === 'multiline' || def.kind === 'text' ? <textarea {...common} rows={3} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} /> : <input {...common} type={def.kind === 'email' ? 'email' : def.kind === 'url' ? 'url' : def.kind === 'phone' ? 'tel' : 'text'} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <div className={'db-fq' + (err ? ' bad' : '')}>
      <label id={id + '-l'} htmlFor={id} className="db-fq-l" dir="auto">{q.title || def.name}{q.required && <span aria-hidden> *</span>}</label>
      {q.description && <small dir="auto">{q.description}</small>}
      {input}
      {err && <div id={id + '-e'} className="db-error" role="alert">{err}</div>}
    </div>
  )
}

export function FormView({ svc, view, ctl }: ViewProps) {
  const cfg: FormConfig = { ...EMPTY, ...(view.configuration as unknown as Partial<FormConfig>) }
  const [mode, setMode] = useState<'build' | 'fill'>(ctl.canSchema ? 'build' : 'fill')
  const [draft, setDraft] = useState<FormConfig>(cfg)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setDraft(cfg) }, [view.configuration]) // eslint-disable-line react-hooks/exhaustive-deps
  const props = svc.state.props(view.sourceId!).filter((p) => !BLOCKED_KINDS.includes(p.kind))
  const problems = useMemo(() => validateFormConfig(draft, (id) => svc.state.prop(id)), [draft, svc, svc.getVersion()]) // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState<string | null>(null)
  const set = (patch: Partial<FormConfig>) => { setDraft({ ...draft, ...patch }); setDirty(true) }
  const setQ = (id: Id, patch: Partial<Question>) => set({ questions: draft.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) })
  const add = (p: Definition) => {
    const q: Question = { id: randomId(), propertyId: p.id, title: p.name, description: '', syncLabel: true, required: p.kind === 'title', order: draft.questions.length }
    set({ questions: [...draft.questions, q] })
  }
  const move = (i: number, d: number) => {
    const a = [...draft.questions].sort((x, y) => x.order - y.order)
    const j = i + d
    if (j < 0 || j >= a.length) return
    ;[a[i], a[j]] = [a[j], a[i]]
    set({ questions: a.map((q, k) => ({ ...q, order: k })) })
  }
  const save = async (open?: boolean) => {
    const next = { ...draft, open: open ?? draft.open }
    const r = await svc.tryExec([{ type: 'form.configure', payload: { viewId: view.id, config: next as unknown as Json } }])
    if (!r.ok) { setErr(errorText(r.code, r.message)); return }
    setErr(null); setDirty(false)
    ctl.notice(next.open ? t('The form is open.') : t('Form saved.'))
  }

  // fill / preview
  const [answers, setAnswers] = useState<Record<Id, Json>>(() => {
    try { return JSON.parse(localStorage.getItem(draftKey(view.id)) ?? '{}') as Record<Id, Json> } catch { return {} }
  })
  const [errors, setErrors] = useState<Record<Id, string>>({})
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { try { localStorage.setItem(draftKey(view.id), JSON.stringify(answers)) } catch { /* draft is a convenience only */ } }, [answers, view.id])
  const live = mode === 'fill' ? cfg : draft
  const shown = visibleQuestions(live, answers)
  const submit = async () => {
    const asked = new Set(shown.map((q) => q.id))
    const given: Record<Id, Json> = {}
    for (const q of shown) if (answers[q.id] !== undefined) given[q.id] = answers[q.id]
    const pre = evaluateSubmission({ ...live, questions: live.questions.filter((q) => asked.has(q.id)) }, (id) => svc.state.prop(id), given)
    if (pre.errors.length) { setErrors(Object.fromEntries(pre.errors.map((e) => [e.questionId, e.message]))); return }
    setErrors({}); setBusy(true)
    const r = await svc.tryExec([{ type: 'form.submit', payload: { formViewId: view.id, version: cfg.version, submissionId: randomId(), answers: given } }])
    setBusy(false)
    if (!r.ok) { setErr(errorText(r.code, r.message)); return }
    setErr(null); setAnswers({}); setDone(cfg.submitMessage || t('Thank you. Your answer was recorded.'))
    try { localStorage.removeItem(draftKey(view.id)) } catch { /* ignore */ }
  }
  void answerToCell

  return (
    <div className="db-form">
      {ctl.canSchema && <Seg value={mode} onChange={setMode} label={t('Form mode')} options={[{ value: 'build', label: t('Build') }, { value: 'fill', label: t('Fill in') }]} />}
      {err && <div className="db-error-box" role="alert">{err}</div>}
      {mode === 'build' ? (
        <div className="db-form-build">
          <div className="db-form-status">
            <b>{cfg.open ? t('Open — accepting answers here') : t('Closed')}</b>
            {!gatewayConfig() && <small>{t('A public link needs the Noviq gateway. It is not set up in this workspace, so answers can only be entered here by people who can edit this database.')}</small>}
          </div>
          {gatewayConfig() && <PublishPanel svc={svc} viewId={view.id} dirty={dirty} />}
          <ol className="db-fq-list">
            {[...draft.questions].sort((a, b) => a.order - b.order).map((q, i) => {
              const d = svc.state.prop(q.propertyId)
              const bad = problems.filter((p) => p.questionId === q.id)
              return (
                <li key={q.id} className={'db-fqb' + (bad.length ? ' bad' : '')}>
                  <div className="db-fqb-head">
                    <b dir="auto">{d ? d.name : t('Deleted property')}</b>
                    <span className="spacer" />
                    <button type="button" className="icon-btn" aria-label={t('Move up')} disabled={i === 0} onClick={() => move(i, -1)}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Ic.Chevron size={12} /></span></button>
                    <button type="button" className="icon-btn" aria-label={t('Move down')} disabled={i === draft.questions.length - 1} onClick={() => move(i, 1)}><Ic.Chevron size={12} /></button>
                    <button type="button" className="icon-btn" aria-label={t('Remove question')} onClick={() => set({ questions: draft.questions.filter((x) => x.id !== q.id).map((x, k) => ({ ...x, order: k })) })}><Ic.Close size={12} /></button>
                  </div>
                  <Field label={t('Question')}><input dir="auto" value={q.title} onChange={(e) => setQ(q.id, { title: e.target.value })} /></Field>
                  <Field label={t('Help text')}><input dir="auto" value={q.description} onChange={(e) => setQ(q.id, { description: e.target.value })} /></Field>
                  <Switch label={t('Required')} on={q.required} onChange={(v) => setQ(q.id, { required: v })} />
                  <ConditionEditor q={q} all={draft.questions} svc={svc} onChange={(c) => setQ(q.id, { visibleWhen: c })} />
                  {bad.map((p, k) => <div key={k} className="db-error" role="alert">{p.message}</div>)}
                </li>
              )
            })}
          </ol>
          <Field label={t('Add a question')}>
            <select value="" onChange={(e) => { const p = props.find((x) => x.id === e.target.value); if (p) add(p) }}>
              <option value="">{t('Choose a property…')}</option>
              {props.filter((p) => !draft.questions.some((q) => q.propertyId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label={t('Message after sending')}><input dir="auto" value={draft.submitMessage} onChange={(e) => set({ submitMessage: e.target.value })} /></Field>
          <div className="db-form-actions">
            <button type="button" className="primary" disabled={!dirty && !problems.length} onClick={() => void save()}>{t('Save')}</button>
            <button type="button" disabled={problems.length > 0 || draft.questions.length === 0} onClick={() => void save(!cfg.open)}>{cfg.open ? t('Close the form') : t('Open the form')}</button>
          </div>
        </div>
      ) : done ? (
        <div className="db-empty" role="status"><b>{done}</b><button type="button" onClick={() => setDone(null)}>{t('Send another answer')}</button></div>
      ) : !cfg.open ? (
        <div className="db-empty"><b>{t('This form is closed')}</b><p>{t('Open it from the Build tab to accept answers.')}</p></div>
      ) : (
        <form className="db-form-fill" noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
          {shown.map((q) => {
            const d = svc.state.prop(q.propertyId)
            return d ? <Answer key={q.id} def={d} q={q} svc={svc} value={answers[q.id]} err={errors[q.id]} onChange={(v) => setAnswers({ ...answers, [q.id]: v })} /> : null
          })}
          <div className="db-form-actions"><button type="submit" className="primary" disabled={busy}>{t('Send')}</button></div>
        </form>
      )}
    </div>
  )
}

function PublishPanel({ svc, viewId, dirty }: { svc: ViewProps['svc']; viewId: Id; dirty: boolean }) {
  const cfg = gatewayConfig()!
  const [link, setLink] = useState<PublicationLink | null>(loadLinks()[viewId] ?? null)
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const client = useMemo(() => new GatewayClient(cfg), [cfg.url, cfg.token]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (link) void client.publicationStatus(link.id).then((s) => setCounts(s.submissions)).catch(() => setCounts(null)) }, [client, link])
  const run = async (f: () => Promise<void>) => {
    setBusy(true); setMsg(null)
    try { await f() } catch (e) { setMsg(e instanceof GatewayError ? e.message : String(e)) } finally { setBusy(false) }
  }
  const publish = () => run(async () => {
    const payload = buildPublication(svc, viewId)
    const r = link ? await client.update(link.id, payload, link.version) : await client.publish(payload)
    const next = { id: r.id, publicId: r.publicId, version: r.version, url: r.url, viewId }
    saveLink(next, viewId); setLink(next)
  })
  const revoke = () => run(async () => { if (!link) return; await client.revoke(link.id); saveLink(null, viewId); setLink(null); setCounts(null) })
  return (
    <div className="db-form-status" role="group" aria-label={t('Public link')}>
      <b>{link ? t('Published — version {n}', { n: link.version }) : t('Not published')}</b>
      {link && <input readOnly dir="ltr" value={link.url} aria-label={t('Public link')} onFocus={(e) => e.currentTarget.select()} />}
      <small>{t('Publishing sends only the questions above and the choices they offer. Answers wait on the gateway as “received, pending import” until this app imports them.')}</small>
      {counts && <small>{t('Waiting for import')}: {counts.pending ?? 0} · {t('Imported')}: {counts.applied ?? 0} · {t('Needs repair')}: {counts.rejected ?? 0}</small>}
      {dirty && <small>{t('Save your changes before publishing.')}</small>}
      {msg && <div className="db-error" role="alert">{msg}</div>}
      <div className="db-form-actions">
        <button type="button" className="primary" disabled={busy || dirty} onClick={() => void publish()}>{link ? t('Publish changes') : t('Publish')}</button>
        {link && <button type="button" disabled={busy} onClick={() => void revoke()}>{t('Stop publishing')}</button>}
      </div>
    </div>
  )
}

function ConditionEditor({ q, all, svc, onChange }: { q: Question; all: Question[]; svc: ViewProps['svc']; onChange: (c: Condition | null) => void }) {
  const earlier = all.filter((x) => x.order < q.order)
  const c = q.visibleWhen
  if (!earlier.length) return null
  return (
    <div className="db-cond">
      <Switch label={t('Show only when…')} on={!!c} onChange={(v) => onChange(v ? { questionId: earlier[0].id, op: 'is_not_empty' } : null)} />
      {c && (
        <div className="db-cond-row">
          <select aria-label={t('Question')} value={c.questionId} onChange={(e) => onChange({ ...c, questionId: e.target.value })}>{earlier.map((x) => <option key={x.id} value={x.id}>{x.title || svc.state.prop(x.propertyId)?.name}</option>)}</select>
          <select aria-label={t('Condition')} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as Condition['op'] })}>
            {(['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'] as const).map((o) => <option key={o} value={o}>{t(o.replace('_', ' '))}</option>)}
          </select>
          {(c.op === 'equals' || c.op === 'not_equals' || c.op === 'contains') && <input dir="auto" aria-label={t('Value')} value={(c.value as string) ?? ''} onChange={(e) => onChange({ ...c, value: e.target.value })} />}
        </div>
      )}
    </div>
  )
}
