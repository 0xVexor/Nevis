// Buttons and automations of one source: list, editor (triggers, view scope, actions), dry run, run history and outbox state.
import { useState } from 'react'
import type { Action, Cell, Definition, Filter, Id, Json, RepeatSchedule, Trigger, WorkflowRecord } from '../model/types.ts'
import { cellToText, parseCellText } from '../props/registry.ts'
import type { RunData } from '../workflows/engine.ts'
import type { DatabaseService } from '../service.ts'
import { Button, Dropdown, Field, FormField, Icon, IconButton, Panel, Popover, Segmented, Switch, SwitchRow } from '../../design-system'
import { confirmDialog } from '../../dialog'
import { t } from '../../i18n'
import { ErrorLine, Hint, errorText, rawOptions } from './common'
import { FilterEditor } from './ViewControls'
import { FormulaEditor } from './PropertyEditor'

type Changes = Record<Id, { cell?: Cell | null; expr?: string }>
type Body = Omit<WorkflowRecord, keyof import('../model/types.ts').RecordMeta | 'definitionRevision' | 'paused'> & { paused?: boolean }

const ACTION_LABEL: Record<Action['type'], string> = {
  set_values: 'Set values',
  create_page: 'Create an item',
  edit_matching: 'Edit matching items',
  define_variable: 'Define a variable',
  notify: 'Send a notification',
  confirm: 'Ask for confirmation',
  open: 'Open a page or link',
  webhook: 'Call a webhook',
  email: 'Send an email',
  slack: 'Send a Slack message',
}
const RUN_STATE: Record<string, string> = { done: 'Done', failed: 'Failed', queued: 'Queued', running: 'Running', sent: 'Sent', pending: 'Waiting' }

function ChangesEditor({ svc, sourceId, changes, onChange }: { svc: DatabaseService; sourceId: Id; changes: Changes; onChange: (c: Changes) => void }) {
  const props = svc.state.props(sourceId).filter((p) => p.kind !== 'button')
  const entries = Object.entries(changes)
  const [errs, setErrs] = useState<Record<Id, string>>({})
  const writable = props.filter((p) => ['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'people'].includes(p.kind))
  return (
    <div className="dv-filter">
      {entries.map(([pid, ch]) => {
        const def = svc.state.prop(pid)
        const isExpr = ch.expr !== undefined
        return (
          <div className="dv-rule" key={pid}>
            <Dropdown
              className="ds-dd-btn--sm"
              label={t('Property')}
              value={pid}
              options={rawOptions(writable)}
              onChange={(id) => {
                const n = { ...changes }
                delete n[pid]
                n[id] = { expr: '' }
                onChange(n)
              }}
            />
            <Segmented
              label={t('Set to')}
              value={isExpr ? 'expr' : 'value'}
              onChange={(v) => onChange({ ...changes, [pid]: v === 'expr' ? { expr: '' } : { cell: null } })}
              options={[
                { value: 'value', label: t('Value') },
                { value: 'expr', label: t('Formula') },
              ]}
            />
            {isExpr ? (
              <input className="ds-field dv-operand dv-code" dir="ltr" aria-label={t('Formula')} value={ch.expr} placeholder={'prop("Cost") * 2'} onChange={(e) => onChange({ ...changes, [pid]: { expr: e.target.value } })} />
            ) : (
              <input
                className="ds-field dv-operand"
                dir="auto"
                defaultValue={ch.cell && def ? cellToText(def, ch.cell) : ''}
                aria-label={t('Value')}
                placeholder={t('Value')}
                onBlur={(e) => {
                  if (!def) return
                  try {
                    const cell = e.target.value.trim() === '' ? null : parseCellText(def as Definition, e.target.value, { listDelimiter: ', ' })
                    setErrs((x) => ({ ...x, [pid]: '' }))
                    onChange({ ...changes, [pid]: { cell } })
                  } catch (err) {
                    setErrs((x) => ({ ...x, [pid]: err instanceof Error ? err.message : String(err) }))
                  }
                }}
              />
            )}
            <IconButton
              className="dv-rule-x"
              label={t('Remove')}
              onClick={() => {
                const n = { ...changes }
                delete n[pid]
                onChange(n)
              }}
            >
              <Icon name="x" size={15} />
            </IconButton>
            {errs[pid] && <ErrorLine>{errs[pid]}</ErrorLine>}
          </div>
        )
      })}
      <div className="dv-rule-adds">
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="plus" size={15} />}
          disabled={!writable.length}
          onClick={() => onChange({ ...changes, [(writable.find((p) => !changes[p.id]) ?? writable[0]).id]: { cell: null } })}
        >
          {t('Add a change')}
        </Button>
      </div>
    </div>
  )
}

function JsonField({ label, value, set }: { label: string; value: Json; set: (v: Json) => void }) {
  const [txt, setTxt] = useState(JSON.stringify(value, null, 1))
  const [bad, setBad] = useState(false)
  return (
    <FormField label={label} hint={bad ? t('This is not valid JSON yet.') : undefined}>
      <textarea
        className="ds-field dv-code"
        aria-invalid={bad}
        aria-label={label}
        dir="ltr"
        rows={4}
        value={txt}
        onChange={(e) => {
          setTxt(e.target.value)
          try {
            set(JSON.parse(e.target.value))
            setBad(false)
          } catch {
            setBad(true)
          }
        }}
      />
    </FormField>
  )
}

function ActionEditor({
  svc,
  sourceId,
  a,
  index,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  svc: DatabaseService
  sourceId: Id
  a: Action
  index: number
  count: number
  onChange: (a: Action) => void
  onRemove: () => void
  onMove: (d: -1 | 1) => void
}) {
  const sources = svc.state.live('source')
  return (
    <section className="dv-step" aria-label={t('Action {n}', { n: index + 1 })}>
      <header className="dv-step-head">
        <span className="dv-step-n">{index + 1}</span>
        <Dropdown className="ds-dd-btn--sm" label={t('Action')} value={a.type} options={(Object.keys(ACTION_LABEL) as Action['type'][]).map((k) => ({ value: k, label: ACTION_LABEL[k] }))} onChange={(k) => onChange(blank(k, sourceId))} />
        <span className="dv-rule-tools">
          <IconButton label={t('Move up')} disabled={index === 0} onClick={() => onMove(-1)}>
            <Icon name="arrow-up" size={15} />
          </IconButton>
          <IconButton label={t('Move down')} disabled={index === count - 1} onClick={() => onMove(1)}>
            <Icon name="arrow-down" size={15} />
          </IconButton>
          <IconButton label={t('Remove action')} onClick={onRemove}>
            <Icon name="trash" size={15} />
          </IconButton>
        </span>
      </header>
      {a.type === 'set_values' && <ChangesEditor svc={svc} sourceId={sourceId} changes={(a.changes as Changes) ?? {}} onChange={(c) => onChange({ ...a, changes: c as unknown as Json })} />}
      {a.type === 'create_page' && (
        <>
          <FormField label={t('In')}>
            <Dropdown label={t('In')} value={a.sourceId} options={rawOptions(sources)} onChange={(v) => onChange({ ...a, sourceId: v })} />
          </FormField>
          <FormField label={t('Name it')}>
            <Field
              value={(a.values as { __title?: { text?: string } }).__title?.text ?? ''}
              onChange={(e) => onChange({ ...a, values: { ...(a.values as Record<string, Json>), __title: { text: e.target.value } } as unknown as Json })}
            />
          </FormField>
          <ChangesEditor
            svc={svc}
            sourceId={a.sourceId}
            changes={Object.fromEntries(Object.entries(a.values as Record<string, Json>).filter(([k]) => k !== '__title')) as Changes}
            onChange={(c) => onChange({ ...a, values: { ...c, __title: (a.values as Record<string, Json>).__title ?? { text: '' } } as unknown as Json })}
          />
        </>
      )}
      {a.type === 'edit_matching' && (
        <>
          <FormField label={t('Items where')}>
            <FilterEditor svc={svc} sourceId={sourceId} filter={(a.query as { filter?: Filter | null }).filter ?? null} onChange={(f) => onChange({ ...a, query: { sourceId, filter: f } as unknown as Json })} />
          </FormField>
          <ChangesEditor svc={svc} sourceId={sourceId} changes={(a.changes as Changes) ?? {}} onChange={(c) => onChange({ ...a, changes: c as unknown as Json })} />
          <Hint>{t('More than 1000 items need your approval each time.')}</Hint>
        </>
      )}
      {a.type === 'define_variable' && (
        <>
          <FormField label={t('Name')}>
            <Field ltr value={a.name} onChange={(e) => onChange({ ...a, name: e.target.value.replace(/[^\p{L}\p{N}_]/gu, '') })} />
          </FormField>
          <FormulaEditor svc={svc} sourceId={sourceId} selfId={null} source={a.expression} onChange={(s) => onChange({ ...a, expression: s })} />
        </>
      )}
      {a.type === 'notify' && (
        <FormField label={t('Message')} hint={t('Use {name} to insert a variable.')}>
          <Field value={a.message} onChange={(e) => onChange({ ...a, message: e.target.value })} />
        </FormField>
      )}
      {a.type === 'confirm' && (
        <>
          <FormField label={t('Title')}>
            <Field value={a.title} onChange={(e) => onChange({ ...a, title: e.target.value })} />
          </FormField>
          <FormField label={t('Message')}>
            <Field value={a.message} onChange={(e) => onChange({ ...a, message: e.target.value })} />
          </FormField>
        </>
      )}
      {a.type === 'open' && (
        <FormField label={t('Address (https://…)')}>
          <Field ltr value={a.url ?? ''} onChange={(e) => onChange({ ...a, url: e.target.value })} />
        </FormField>
      )}
      {(a.type === 'webhook' || a.type === 'email' || a.type === 'slack') && (
        <>
          <FormField label={t('Connection')} hint={t('Secrets are stored outside your notes; set the connection up in Settings → Database.')}>
            <Field ltr value={a.connectionId} onChange={(e) => onChange({ ...a, connectionId: e.target.value })} />
          </FormField>
          {a.type === 'webhook' ? (
            <JsonField label={t('Request (JSON)')} value={a.request} set={(v) => onChange({ ...a, request: v })} />
          ) : (
            <JsonField label={t('Message (JSON)')} value={a.message} set={(v) => onChange({ ...a, message: v })} />
          )}
        </>
      )}
    </section>
  )
}

function blank(type: Action['type'], sourceId: Id): Action {
  switch (type) {
    case 'set_values':
      return { type, target: 'trigger', changes: {} }
    case 'create_page':
      return { type, sourceId, values: {} }
    case 'edit_matching':
      return { type, query: { sourceId, filter: null }, changes: {} }
    case 'define_variable':
      return { type, name: 'x', expression: '' }
    case 'notify':
      return { type, recipients: 'trigger', message: '' }
    case 'confirm':
      return { type, title: '', message: '' }
    case 'open':
      return { type, url: '' }
    case 'webhook':
      return { type, connectionId: '', request: { method: 'POST', path: '/', body: {} } }
    default:
      return { type, connectionId: '', message: { to: '', subject: '', body: '' } } as Action
  }
}

function WorkflowEditor({
  svc,
  sourceId,
  wf,
  propertyId,
  onDone,
  notify,
}: {
  svc: DatabaseService
  sourceId: Id
  wf: WorkflowRecord | null
  propertyId: Id | null
  onDone: () => void
  notify: (m: string) => void
}) {
  const [body, setBody] = useState<Body>(() =>
    wf
      ? ({ ...wf } as unknown as Body)
      : { sourceId, name: '', kind: propertyId ? 'button' : 'automation', triggers: [], triggerMode: 'any', viewScopeId: null, actions: [], enabled: true, propertyId },
  )
  const [err, setErr] = useState<string | null>(null)
  const views = svc.state.live('view').filter((v) => v.sourceId === sourceId && v.parentDashboardId === null)
  const props = svc.state.props(sourceId)
  const set = (p: Partial<Body>) => setBody({ ...body, ...p })
  const setTrig = (i: number, tr: Trigger) => set({ triggers: body.triggers.map((x, j) => (j === i ? tr : x)) })
  const save = async () => {
    const r = await svc.tryExec([{ type: 'workflow.save', payload: { id: wf?.id ?? null, body: { ...body, name: body.name || t('Untitled') } as unknown as Record<string, Json> } as Json }])
    if (r.ok) onDone()
    else setErr(errorText(r.code, r.message))
  }
  const dry = async () => {
    if (!wf) return notify(t('Save the workflow first, then test it.'))
    try {
      const pg = svc.state.rows(sourceId)[0]
      const res = await svc.engine.run(wf.id, { kind: body.kind === 'button' ? 'button' : 'automation', pageId: pg?.page.id ?? null, eventId: 'dry-' + Date.now(), actorId: svc.principalId, dryRun: true, confirmed: true, approve: true })
      notify(res.state === 'failed' ? (res.error ?? t('The dry run found a problem.')) : t('The dry run found no problems.'))
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e))
    }
  }
  const schedule = body.triggers.find((x) => x.type === 'schedule') as Extract<Trigger, { type: 'schedule' }> | undefined
  return (
    <Panel
      size="lg"
      title={wf ? body.name || t('Untitled') : body.kind === 'button' ? t('New button') : t('New automation')}
      onBack={onDone}
      className="dv-workflow"
      footer={
        <>
          <Button size="sm" variant="ghost" className="ds-panel-foot-start" onClick={() => void dry()}>
            {t('Test (dry run)')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            {t('Cancel')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save()}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <FormField label={t('Name')}>
        <Field value={body.name} onChange={(e) => set({ name: e.target.value })} />
      </FormField>
      {body.kind === 'automation' && (
        <>
          <SwitchRow label={t('Turned on')} checked={body.enabled} onChange={(v) => set({ enabled: v })} />
          <h4 className="dv-subhead">{t('When')}</h4>
          {body.triggers.map((tr, i) => (
            <div className="dv-rule" key={i}>
              <Dropdown
                className="ds-dd-btn--sm"
                label={t('Trigger')}
                value={tr.type}
                options={[
                  { value: 'page_added', label: 'An item is added' },
                  { value: 'property_changed', label: 'A property changes' },
                  { value: 'schedule', label: 'On a schedule' },
                ]}
                onChange={(v) =>
                  setTrig(
                    i,
                    v === 'page_added'
                      ? { type: 'page_added' }
                      : v === 'schedule'
                        ? { type: 'schedule', recurrence: { frequency: 'daily', interval: 1, startDate: new Date().toISOString().slice(0, 10), endDate: null, time: '09:00', timeZone: svc.zone } as unknown as Json }
                        : { type: 'property_changed', propertyId: props.find((p) => p.kind !== 'title')?.id ?? props[0].id },
                  )
                }
              />
              {tr.type === 'property_changed' && <Dropdown className="ds-dd-btn--sm" label={t('Property')} value={tr.propertyId} options={rawOptions(props)} onChange={(v) => setTrig(i, { ...tr, propertyId: v })} />}
              <IconButton className="dv-rule-x" label={t('Remove')} onClick={() => set({ triggers: body.triggers.filter((_, j) => j !== i) })}>
                <Icon name="x" size={15} />
              </IconButton>
            </div>
          ))}
          {!schedule && (
            <div className="dv-rule-adds">
              <Button size="sm" variant="ghost" icon={<Icon name="plus" size={15} />} onClick={() => set({ triggers: [...body.triggers, { type: 'page_added' }] })}>
                {t('Add a trigger')}
              </Button>
            </div>
          )}
          {body.triggers.length > 1 && (
            <FormField label={t('Run when')}>
              <Segmented
                label={t('Run when')}
                value={body.triggerMode}
                onChange={(v) => set({ triggerMode: v })}
                options={[
                  { value: 'any', label: t('Any trigger happens') },
                  { value: 'all', label: t('All happen within 3 seconds') },
                ]}
              />
            </FormField>
          )}
          {schedule &&
            (() => {
              const r = schedule.recurrence as unknown as RepeatSchedule
              const upd = (p: Partial<RepeatSchedule>) => set({ triggers: [{ type: 'schedule', recurrence: { ...r, ...p } as unknown as Json }] })
              return (
                <>
                  <div className="dv-pair">
                    <FormField label={t('Repeat')}>
                      <Dropdown
                        label={t('Repeat')}
                        value={r.frequency}
                        options={['daily', 'weekly', 'monthly', 'yearly'].map((f) => ({ value: f, label: f[0].toUpperCase() + f.slice(1) }))}
                        onChange={(v) => upd({ frequency: v as RepeatSchedule['frequency'] })}
                      />
                    </FormField>
                    <FormField label={t('Every')}>
                      <Field ltr type="number" min={1} value={r.interval} onChange={(e) => upd({ interval: Math.max(1, Number(e.target.value) || 1) })} />
                    </FormField>
                  </div>
                  <div className="dv-pair">
                    <FormField label={t('At')}>
                      <Field ltr type="time" value={r.time} onChange={(e) => upd({ time: e.target.value })} />
                    </FormField>
                    <FormField label={t('Starting')}>
                      <Field ltr type="date" value={r.startDate} onChange={(e) => upd({ startDate: e.target.value })} />
                    </FormField>
                  </div>
                  <Hint>{t('Scheduled runs happen while the app is open on the device chosen as runner; missed runs are caught up once on the next start.')}</Hint>
                </>
              )
            })()}
          {!schedule && (
            <FormField label={t('Only for items in view')}>
              <Dropdown label={t('Only for items in view')} value={body.viewScopeId ?? ''} options={[{ value: '', label: 'All items' }, ...rawOptions(views)]} onChange={(v) => set({ viewScopeId: v || null })} />
            </FormField>
          )}
        </>
      )}
      <h4 className="dv-subhead">{t('Do')}</h4>
      {body.actions.length === 0 && <Hint>{t('No actions yet.')}</Hint>}
      {body.actions.map((a, i) => (
        <ActionEditor
          key={i}
          svc={svc}
          sourceId={sourceId}
          a={a}
          index={i}
          count={body.actions.length}
          onChange={(n) => set({ actions: body.actions.map((x, j) => (j === i ? n : x)) })}
          onRemove={() => set({ actions: body.actions.filter((_, j) => j !== i) })}
          onMove={(d) => {
            const n = [...body.actions]
            const j = i + d
            if (j < 0 || j >= n.length) return
            ;[n[i], n[j]] = [n[j], n[i]]
            set({ actions: n })
          }}
        />
      ))}
      <div className="dv-rule-adds">
        <Button size="sm" variant="ghost" icon={<Icon name="plus" size={15} />} onClick={() => set({ actions: [...body.actions, blank('set_values', sourceId)] })}>
          {t('Add an action')}
        </Button>
      </div>
      {body.actions.length > 100 && <ErrorLine>{t('A workflow has at most 100 actions.')}</ErrorLine>}
      {err && <ErrorLine>{err}</ErrorLine>}
    </Panel>
  )
}

export function WorkflowPanel({
  svc,
  sourceId,
  anchor,
  onClose,
  notify,
  focusProperty,
}: {
  svc: DatabaseService
  sourceId: Id
  anchor: DOMRect
  onClose: () => void
  notify: (m: string) => void
  focusProperty: Id | null
}) {
  const list = svc.state.live('workflow').filter((w) => w.sourceId === sourceId)
  const focused = focusProperty ? (list.find((w) => w.propertyId === focusProperty) ?? null) : null
  const [editing, setEditing] = useState<{ wf: WorkflowRecord | null; propertyId: Id | null } | null>(focusProperty ? { wf: focused, propertyId: focusProperty } : null)
  const runs = svc.state
    .live('event')
    .filter((e) => e.type === 'workflow_run' && e.id.startsWith('run:'))
    .map((e) => e.data as unknown as RunData)
    .slice(-8)
    .reverse()
  const outbox = svc.engine.outbox().slice(-6)
  return (
    <Popover anchor={anchor} onClose={onClose} align="end">
      {editing ? (
        <WorkflowEditor svc={svc} sourceId={sourceId} wf={editing.wf} propertyId={editing.propertyId} onDone={() => (focusProperty ? onClose() : setEditing(null))} notify={notify} />
      ) : (
        <Panel
          size="lg"
          title={t('Buttons and automations')}
          footer={
            <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={() => setEditing({ wf: null, propertyId: null })}>
              {t('New automation')}
            </Button>
          }
        >
          {list.length === 0 ? (
            <Hint>{t('Nothing yet. Automations run when items change; buttons are added as a button property.')}</Hint>
          ) : (
            <div className="ds-list ds-list--framed">
              {list.map((w) => (
                <div className="ds-list-row" key={w.id}>
                  <Icon name={w.kind === 'button' ? 'pointer' : 'repeat'} size={16} />
                  <div className="ds-list-main">
                    <b dir="auto">{w.name || t('Untitled')}</b>
                    <small>
                      {w.kind === 'button' ? t('Button') : t('Automation')} · {t('{n} actions', { n: w.actions.length })}
                    </small>
                  </div>
                  <div className="ds-list-acts">
                    {w.kind === 'automation' && <Switch label={t('Turned on')} checked={w.enabled} onChange={(v) => void svc.tryExec([{ type: 'workflow.save', payload: { id: w.id, body: { enabled: v } } }])} />}
                    <IconButton label={t('Edit')} onClick={() => setEditing({ wf: w, propertyId: w.propertyId })}>
                      <Icon name="pencil" size={15} />
                    </IconButton>
                    <IconButton
                      label={t('Delete')}
                      onClick={async () => {
                        if (await confirmDialog({ title: t('Delete “{n}”?', { n: w.name }), danger: true, confirmLabel: t('Delete') })) await svc.tryExec([{ type: 'record.trash', payload: { kind: 'workflow', id: w.id } }])
                      }}
                    >
                      <Icon name="trash" size={15} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(runs.length > 0 || outbox.length > 0) && (
            <details className="dv-runs">
              <summary>{t('Recent runs')}</summary>
              <ul>
                {runs.map((r) => (
                  <li key={r.runKey} data-bad={r.state === 'failed' || undefined}>
                    <span dir="auto">{list.find((w) => w.id === r.workflowId)?.name ?? '…'}</span> · {t(RUN_STATE[r.state] ?? r.state)}
                    {r.error ? `: ${r.error}` : ''}
                  </li>
                ))}
                {outbox.map((o) => (
                  <li key={o.id} data-bad={o.state === 'failed' || undefined}>
                    {o.type} · {t(RUN_STATE[o.state] ?? o.state)}
                    {o.error ? `: ${o.error}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Panel>
      )}
    </Popover>
  )
}
