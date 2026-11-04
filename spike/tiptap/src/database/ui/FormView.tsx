// Form view. Build: the questions (each linked to a property, required, shown only when an earlier answer matches) beside a live
// preview of the form. Fill in: the form itself, submitted through the same validator the gateway uses. Drafts of unsent answers
// live only in this browser. A hosted public link needs the gateway; without one the panel says so instead of showing a link.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { civilOf, formatCivil } from '../dates.ts'
import { cfgOf } from '../props/config.ts'
import { DatePicker } from './DatePicker'
import type { Definition, Id, Json } from '../model/types.ts'
import { validateFormConfig, visibleQuestions, evaluateSubmission, type FormConfig, type Question, type Condition } from '../forms.ts'
import { optionsOf } from '../props/config.ts'
import { randomId } from '../model/ids.ts'
import { Button, Checkbox, Dropdown, Field, FormField, Icon, IconButton, Notice, Panel, Popover, Radio, Segmented, SwitchRow } from '../../design-system'
import { locale, t } from '../../i18n'
import { ErrorLine, Hint, KindIcon, ViewMessage, errorText, rawOptions } from './common'
import { GatewayClient, GatewayError, buildPublication, gatewayConfig, loadLinks, saveLink, type PublicationLink } from '../gateway/client'
import type { ViewProps } from './viewTypes'

const EMPTY: FormConfig = { questions: [], version: 0, open: false, anonymous: false, submitMessage: '' }
const BLOCKED_KINDS = ['formula', 'rollup', 'button', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'connected', 'verification', 'title2']
const draftKey = (viewId: Id) => `not.db.formdraft.${viewId}`
const COND_LABEL: Record<Condition['op'], string> = { equals: 'is', not_equals: 'is not', contains: 'contains', is_empty: 'is empty', is_not_empty: 'is not empty' }

/** A date answer: the database's own picker (Jalali when the property shows Jalali, Persian digits), not the browser's control. */
function DateAnswer({
  def,
  svc,
  value,
  onChange,
  field,
}: {
  def: Definition
  svc: ViewProps['svc']
  value: Json | undefined
  onChange: (v: Json) => void
  field: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const cfg = cfgOf.date(def)
  const zone = cfg.defaultZone ?? svc.zone
  const civil = typeof value === 'string' && value ? value : null
  return (
    <>
      <button type="button" {...field} className="ds-field dv-form-date" aria-haspopup="dialog" aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        <Icon name="calendar" size={15} />
        <span data-empty={!civil || undefined}>{civil ? formatCivil(civil, { calendar: cfg.displayCalendar, locale: locale() }) : t('Pick a date')}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <Panel size="sm">
            <DatePicker
              single
              value={civil ? { kind: 'date', start: civil, end: null } : null}
              config={cfg}
              zone={zone}
              weekStart={svc.weekStart}
              todayCivil={civilOf(svc.now(), zone)}
              onChange={(v) => {
                onChange(v && v.kind === 'date' ? v.start : null)
                setAnchor(null)
              }}
              onClose={() => setAnchor(null)}
            />
          </Panel>
        </Popover>
      )}
    </>
  )
}

function Answer({ def, q, value, onChange, svc, err }: { def: Definition; q: Question; value: Json | undefined; onChange: (v: Json) => void; svc: ViewProps['svc']; err?: string }) {
  const id = 'fq-' + q.id
  const opts = optionsOf(def)
  const common = { id, 'aria-invalid': !!err, 'aria-describedby': err ? id + '-e' : undefined, dir: 'auto' as const, className: 'ds-field' }
  let input: ReactElement
  switch (def.kind) {
    case 'select':
    case 'status':
      input =
        q.inputStyle === 'radio' ? (
          <div className="dv-checks" role="radiogroup" aria-labelledby={id + '-l'}>
            {opts.map((o) => (
              <Radio key={o.id} name={id} checked={value === o.id} onChange={() => onChange(o.id)}>
                <span dir="auto">{o.name}</span>
              </Radio>
            ))}
          </div>
        ) : (
          <Dropdown label={q.title || def.name} placeholder={t('Choose…')} value={(value as string) ?? ''} onChange={(v) => onChange(v || null)} options={rawOptions(opts)} />
        )
      break
    case 'multi_select': {
      const cur = (Array.isArray(value) ? value : []) as string[]
      input = (
        <div className="dv-checks" role="group" aria-labelledby={id + '-l'}>
          {opts.map((o) => (
            <Checkbox
              key={o.id}
              checked={cur.includes(o.id)}
              disabled={!cur.includes(o.id) && !!q.maxSelections && cur.length >= q.maxSelections}
              onChange={(on) => onChange(on ? [...cur, o.id] : cur.filter((x) => x !== o.id))}
            >
              <span dir="auto">{o.name}</span>
            </Checkbox>
          ))}
        </div>
      )
      break
    }
    case 'checkbox':
      input = (
        <Checkbox checked={value === true} onChange={(on) => onChange(on)}>
          <span dir="auto">{def.name}</span>
        </Checkbox>
      )
      break
    case 'number':
      input = <input {...common} dir="ltr" inputMode="decimal" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'date':
      input = <DateAnswer def={def} svc={svc} value={value} onChange={onChange} field={{ id: common.id, 'aria-invalid': common['aria-invalid'], 'aria-describedby': common['aria-describedby'] }} />
      break
    case 'relation': {
      const targets = q.optionProjection ?? []
      const cur = (Array.isArray(value) ? value : []) as string[]
      input = (
        <div className="dv-checks" role="group" aria-labelledby={id + '-l'}>
          {targets.length === 0 ? (
            <Hint>{t('No choices are available.')}</Hint>
          ) : (
            targets.map((tid) => (
              <Checkbox key={tid} checked={cur.includes(tid)} onChange={(on) => onChange(on ? [...cur, tid] : cur.filter((x) => x !== tid))}>
                <span dir="auto">{svc.state.pages.get(tid)?.title ?? tid}</span>
              </Checkbox>
            ))
          )}
        </div>
      )
      break
    }
    default:
      input =
        q.inputStyle === 'multiline' || def.kind === 'text' ? (
          <textarea {...common} rows={3} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input
            {...common}
            dir={def.kind === 'email' || def.kind === 'url' || def.kind === 'phone' ? 'ltr' : 'auto'}
            type={def.kind === 'email' ? 'email' : def.kind === 'url' ? 'url' : def.kind === 'phone' ? 'tel' : 'text'}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
          />
        )
  }
  return (
    <div className="dv-question" data-bad={err ? true : undefined}>
      <label id={id + '-l'} htmlFor={id} className="dv-question-label" dir="auto">
        {q.title || def.name}
        {q.required && (
          <span className="dv-required" title={t('Required')}>
            {' '}
            *
          </span>
        )}
      </label>
      {q.description && (
        <small className="dv-hint" dir="auto">
          {q.description}
        </small>
      )}
      {input}
      {err && (
        <Notice id={id + '-e'} tone="bad" compact>{err}</Notice>
      )}
    </div>
  )
}

/** The form as people fill it in. `preview` keeps the answers in memory and never sends them. */
function FormFill({ svc, view, form, preview, onSent }: { svc: ViewProps['svc']; view: ViewProps['view']; form: FormConfig; preview?: boolean; onSent?: (msg: string) => void }) {
  const [answers, setAnswers] = useState<Record<Id, Json>>(() => {
    if (preview) return {}
    try {
      return JSON.parse(localStorage.getItem(draftKey(view.id)) ?? '{}') as Record<Id, Json>
    } catch {
      return {}
    }
  })
  const [errors, setErrors] = useState<Record<Id, string>>({})
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (preview) return
    try {
      localStorage.setItem(draftKey(view.id), JSON.stringify(answers))
    } catch {
      /* draft is a convenience only */
    }
  }, [answers, view.id, preview])
  const shown = visibleQuestions(form, answers)
  const submit = async () => {
    const asked = new Set(shown.map((q) => q.id))
    const given: Record<Id, Json> = {}
    for (const q of shown) if (answers[q.id] !== undefined) given[q.id] = answers[q.id]
    const pre = evaluateSubmission({ ...form, questions: form.questions.filter((q) => asked.has(q.id)) }, (id) => svc.state.prop(id), given)
    if (pre.errors.length) return setErrors(Object.fromEntries(pre.errors.map((e) => [e.questionId, e.message])))
    setErrors({})
    if (preview) return
    setBusy(true)
    const r = await svc.tryExec([{ type: 'form.submit', payload: { formViewId: view.id, version: form.version, submissionId: randomId(), answers: given } }])
    setBusy(false)
    if (!r.ok) return setErr(errorText(r.code, r.message))
    setErr(null)
    setAnswers({})
    try {
      localStorage.removeItem(draftKey(view.id))
    } catch {
      /* ignore */
    }
    onSent?.(form.submitMessage || t('Thank you. Your answer was recorded.'))
  }
  return (
    <form
      className="dv-form-fill"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h3 className="dv-form-title" dir="auto">
        {view.name}
      </h3>
      {shown.length === 0 && <Hint>{t('Add a question to see it here.')}</Hint>}
      {shown.map((q) => {
        const d = svc.state.prop(q.propertyId)
        return d ? (
          <Answer
            key={q.id}
            def={d}
            q={q}
            svc={svc}
            value={answers[q.id]}
            err={errors[q.id]}
            onChange={(v) => {
              setAnswers({ ...answers, [q.id]: v })
              setErrors((prev) => {
                const next = { ...prev }
                delete next[q.id]
                return next
              })
            }}
          />
        ) : null
      })}
      {err && <ErrorLine>{err}</ErrorLine>}
      <div className="dv-form-acts">
        <Button type="submit" variant="primary" disabled={busy || shown.length === 0}>
          {preview ? t('Check answers') : t('Send')}
        </Button>
        {preview && <span className="dv-hint">{t('Preview: answers here are not saved.')}</span>}
      </div>
    </form>
  )
}

export function FormView({ svc, view, ctl }: ViewProps) {
  const cfg: FormConfig = { ...EMPTY, ...(view.configuration as unknown as Partial<FormConfig>) }
  const [mode, setMode] = useState<'build' | 'fill'>(ctl.canSchema ? 'build' : 'fill')
  const [draft, setDraft] = useState<FormConfig>(cfg)
  const [dirty, setDirty] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (!dirty) setDraft(cfg)
  }, [view.configuration]) // eslint-disable-line react-hooks/exhaustive-deps
  const props = svc.state.props(view.sourceId!).filter((p) => !BLOCKED_KINDS.includes(p.kind))
  const problems = useMemo(() => validateFormConfig(draft, (id) => svc.state.prop(id)), [draft, svc, svc.getVersion()]) // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState<string | null>(null)
  const set = (patch: Partial<FormConfig>) => {
    setDraft({ ...draft, ...patch })
    setDirty(true)
  }
  const ordered = [...draft.questions].sort((a, b) => a.order - b.order)
  const setQ = (id: Id, patch: Partial<Question>) => set({ questions: draft.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) })
  const add = (p: Definition) =>
    set({ questions: [...draft.questions, { id: randomId(), propertyId: p.id, title: p.name, description: '', syncLabel: true, required: p.kind === 'title', order: draft.questions.length }] })
  const move = (i: number, d: number) => {
    const a = [...ordered]
    const j = i + d
    if (j < 0 || j >= a.length) return
    ;[a[i], a[j]] = [a[j], a[i]]
    set({ questions: a.map((q, k) => ({ ...q, order: k })) })
  }
  const save = async (open?: boolean) => {
    const next = { ...draft, open: open ?? draft.open }
    const r = await svc.tryExec([{ type: 'form.configure', payload: { viewId: view.id, config: next as unknown as Json } }])
    if (!r.ok) return setErr(errorText(r.code, r.message))
    setErr(null)
    setDirty(false)
    ctl.notice(next.open ? t('The form is open.') : t('Form saved.'))
  }
  const unused = props.filter((p) => !draft.questions.some((q) => q.propertyId === p.id))

  return (
    <div className="dv-form">
      <header className="dv-period">
        {ctl.canSchema && (
          <Segmented
            label={t('Form mode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'build', label: t('Build') },
              { value: 'fill', label: t('Fill in') },
            ]}
          />
        )}
        <span className="dv-form-state" data-open={cfg.open || undefined}>
          <Icon name={cfg.open ? 'check-circle' : 'lock'} size={15} /> {cfg.open ? t('Open, accepting answers') : t('Closed')}
        </span>
        {mode === 'build' && (
          <span className="dv-period-end">
            <Button size="sm" variant="ghost" disabled={problems.length > 0 || draft.questions.length === 0} onClick={() => void save(!cfg.open)}>
              {cfg.open ? t('Close the form') : t('Open the form')}
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save()}>
              {t('Save form')}
            </Button>
          </span>
        )}
      </header>
      {err && <ErrorLine>{err}</ErrorLine>}
      {mode === 'build' ? (
        <div className="dv-form-build">
          <div className="dv-form-questions">
            {!gatewayConfig() && (
              <Notice>{t('A public link needs the Nevis gateway. It is not set up in this workspace, so answers can only be entered here by people who can edit this database.')}</Notice>
            )}
            {gatewayConfig() && <PublishPanel svc={svc} viewId={view.id} dirty={dirty} />}
            {ordered.length === 0 && <ViewMessage title={t('No questions yet')}>{t('Each question fills in one property of the new item.')}</ViewMessage>}
            <ol className="dv-qlist">
              {ordered.map((q, i) => {
                const d = svc.state.prop(q.propertyId)
                const bad = problems.filter((p) => p.questionId === q.id)
                return (
                  <li key={q.id} className="dv-qcard" data-bad={bad.length ? true : undefined}>
                    <header className="dv-qcard-head">
                      <span className="dv-step-n">{i + 1}</span>
                      {d && <KindIcon kind={d.kind} />}
                      <b dir="auto">{d ? d.name : t('Deleted property')}</b>
                      <span className="dv-rule-tools">
                        <IconButton label={t('Move up')} disabled={i === 0} onClick={() => move(i, -1)}>
                          <Icon name="arrow-up" size={15} />
                        </IconButton>
                        <IconButton label={t('Move down')} disabled={i === ordered.length - 1} onClick={() => move(i, 1)}>
                          <Icon name="arrow-down" size={15} />
                        </IconButton>
                        <IconButton label={t('Remove question')} onClick={() => set({ questions: draft.questions.filter((x) => x.id !== q.id).map((x, k) => ({ ...x, order: k })) })}>
                          <Icon name="x" size={15} />
                        </IconButton>
                      </span>
                    </header>
                    <FormField label={t('Question')}>
                      <Field value={q.title} onChange={(e) => setQ(q.id, { title: e.target.value })} />
                    </FormField>
                    <FormField label={t('Help text')}>
                      <Field value={q.description} onChange={(e) => setQ(q.id, { description: e.target.value })} />
                    </FormField>
                    <SwitchRow label={t('Required')} checked={q.required} onChange={(v) => setQ(q.id, { required: v })} />
                    <ConditionEditor q={q} all={draft.questions} svc={svc} onChange={(c) => setQ(q.id, { visibleWhen: c })} />
                    {bad.map((p, k) => (
                      <ErrorLine key={k}>{p.message}</ErrorLine>
                    ))}
                  </li>
                )
              })}
            </ol>
            {unused.length > 0 && (
              <FormField label={t('Add a question')}>
                <Dropdown
                  label={t('Add a question')}
                  placeholder={t('Choose a property…')}
                  value=""
                  onChange={(v) => {
                    const p = props.find((x) => x.id === v)
                    if (p) add(p)
                  }}
                  options={rawOptions(unused)}
                />
              </FormField>
            )}
            <FormField label={t('Message after sending')}>
              <Field value={draft.submitMessage} placeholder={t('Thank you. Your answer was recorded.')} onChange={(e) => set({ submitMessage: e.target.value })} />
            </FormField>
          </div>
          <aside className="dv-form-preview" aria-label={t('Preview')}>
            <h4 className="dv-subhead">{t('Preview')}</h4>
            <FormFill key={JSON.stringify(draft.questions)} svc={svc} view={view} form={draft} preview />
          </aside>
        </div>
      ) : done ? (
        <ViewMessage
          title={done}
          action={
            <Button size="sm" onClick={() => setDone(null)}>
              {t('Send another answer')}
            </Button>
          }
        />
      ) : !cfg.open ? (
        <ViewMessage title={t('This form is closed')}>{t('Open it from the Build tab to accept answers.')}</ViewMessage>
      ) : (
        <div className="dv-form-single">
          <FormFill svc={svc} view={view} form={cfg} onSent={setDone} />
        </div>
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
  useEffect(() => {
    if (link)
      void client
        .publicationStatus(link.id)
        .then((s) => setCounts(s.submissions))
        .catch(() => setCounts(null))
  }, [client, link])
  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    try {
      await f()
    } catch (e) {
      setMsg(e instanceof GatewayError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const publish = () =>
    run(async () => {
      const payload = buildPublication(svc, viewId)
      const r = link ? await client.update(link.id, payload, link.version) : await client.publish(payload)
      const next = { id: r.id, publicId: r.publicId, version: r.version, url: r.url, viewId }
      saveLink(next, viewId)
      setLink(next)
    })
  const revoke = () =>
    run(async () => {
      if (!link) return
      await client.revoke(link.id)
      saveLink(null, viewId)
      setLink(null)
      setCounts(null)
    })
  return (
    <section className="dv-qcard" aria-label={t('Public link')}>
      <header className="dv-qcard-head">
        <Icon name="link" size={16} />
        <b>{link ? t('Published, version {n}', { n: link.version }) : t('Not published')}</b>
      </header>
      {link && <Field ltr readOnly value={link.url} aria-label={t('Public link')} onFocus={(e) => e.currentTarget.select()} />}
      <Hint>{t('Publishing sends only the questions above and the choices they offer. Answers wait on the gateway as “received, pending import” until this app imports them.')}</Hint>
      {counts && (
        <p className="dv-text">
          {t('Waiting for import')}: {counts.pending ?? 0} · {t('Imported')}: {counts.applied ?? 0} · {t('Needs repair')}: {counts.rejected ?? 0}
        </p>
      )}
      {dirty && <Hint>{t('Save your changes before publishing.')}</Hint>}
      {msg && <ErrorLine>{msg}</ErrorLine>}
      <div className="dv-form-acts">
        <Button size="sm" variant="primary" disabled={busy || dirty} onClick={() => void publish()}>
          {link ? t('Publish changes') : t('Publish')}
        </Button>
        {link && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke()}>
            {t('Stop publishing')}
          </Button>
        )}
      </div>
    </section>
  )
}

function ConditionEditor({ q, all, svc, onChange }: { q: Question; all: Question[]; svc: ViewProps['svc']; onChange: (c: Condition | null) => void }) {
  const earlier = all.filter((x) => x.order < q.order)
  const c = q.visibleWhen
  if (!earlier.length) return null
  return (
    <div className="dv-cond">
      <SwitchRow label={t('Show only when…')} checked={!!c} onChange={(v) => onChange(v ? { questionId: earlier[0].id, op: 'is_not_empty' } : null)} />
      {c && (
        <div className="dv-rule">
          <Dropdown
            className="ds-dd-btn--sm"
            label={t('Question')}
            value={c.questionId}
            onChange={(v) => onChange({ ...c, questionId: v })}
            options={earlier.map((x) => ({ value: x.id, label: x.title || svc.state.prop(x.propertyId)?.name || t('Deleted property'), raw: true }))}
          />
          <Dropdown
            className="ds-dd-btn--sm"
            label={t('Condition')}
            value={c.op}
            onChange={(v) => onChange({ ...c, op: v })}
            options={(Object.keys(COND_LABEL) as Condition['op'][]).map((o) => ({ value: o, label: COND_LABEL[o] }))}
          />
          {(c.op === 'equals' || c.op === 'not_equals' || c.op === 'contains') && (
            <input
              className="ds-field dv-operand"
              dir="auto"
              aria-label={t('Value')}
              placeholder={t('Value')}
              value={(c.value as string) ?? ''}
              onChange={(e) => onChange({ ...c, value: e.target.value })}
            />
          )}
        </div>
      )}
    </div>
  )
}
