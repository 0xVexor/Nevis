// Buttons and automations of one source: list, editor (triggers, view scope, actions), dry run, run history and outbox state.
import { useState } from 'react'
import type { Action, Cell, Definition, Filter, Id, Json, RepeatSchedule, Trigger, WorkflowRecord } from '../model/types.ts'
import { parseCellText } from '../props/registry.ts'
import { cellToText } from '../props/registry.ts'
import type { RunData } from '../workflows/engine.ts'
import type { DatabaseService } from '../service.ts'
import { Popover, Select } from '../../ui'
import { confirmDialog } from '../../dialog'
import { t } from '../../i18n'
import * as Ic from '../../icons'
import { errorText } from './common'
import { Field, Seg, Switch } from './forms'
import { FilterEditor } from './ViewControls'
import { FormulaEditor } from './PropertyEditor'

type Changes = Record<Id, { cell?: Cell | null; expr?: string }>
type Body = Omit<WorkflowRecord, keyof import('../model/types.ts').RecordMeta | 'definitionRevision' | 'paused'> & { paused?: boolean }

const ACTION_LABEL: Record<Action['type'], string> = {
  set_values: 'Set values', create_page: 'Create an item', edit_matching: 'Edit matching items', define_variable: 'Define a variable', notify: 'Send a notification', confirm: 'Ask for confirmation',
  open: 'Open a page or link', webhook: 'Call a webhook', email: 'Send an email', slack: 'Send a Slack message',
}

function ChangesEditor({ svc, sourceId, changes, onChange }: { svc: DatabaseService; sourceId: Id; changes: Changes; onChange: (c: Changes) => void }) {
  const props = svc.state.props(sourceId).filter((p) => p.kind !== 'button')
  const entries = Object.entries(changes)
  const [errs, setErrs] = useState<Record<Id, string>>({})
  const writable = props.filter((p) => ['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'people'].includes(p.kind))
  return (
    <div className="db-changes">
      {entries.map(([pid, ch]) => {
        const def = svc.state.prop(pid)
        const isExpr = ch.expr !== undefined
        return (
          <div className="db-frow" key={pid}>
            <Select value={pid} options={writable.map((p) => ({ value: p.id, label: p.name }))} onChange={(id) => { const n = { ...changes }; delete n[pid]; n[id] = { expr: '' }; onChange(n) }} />
            <Seg value={isExpr ? 'expr' : 'value'} onChange={(v) => onChange({ ...changes, [pid]: v === 'expr' ? { expr: '' } : { cell: null } })} options={[{ value: 'value', label: t('Value') }, { value: 'expr', label: t('Formula') }]} />
            {isExpr ? (
              <input className="db-input mono" dir="ltr" value={ch.expr} placeholder={'prop("Cost") * 2'} onChange={(e) => onChange({ ...changes, [pid]: { expr: e.target.value } })} />
            ) : (
              <input className="db-input" dir="auto" defaultValue={ch.cell && def ? cellToText(def, ch.cell) : ''} aria-label={t('Value')} onBlur={(e) => {
                if (!def) return
                try {
                  const cell = e.target.value.trim() === '' ? null : parseCellText(def as Definition, e.target.value, { listDelimiter: ', ' })
                  setErrs((x) => ({ ...x, [pid]: '' }))
                  onChange({ ...changes, [pid]: { cell } })
                } catch (err) { setErrs((x) => ({ ...x, [pid]: err instanceof Error ? err.message : String(err) })) }
              }} />
            )}
            <button type="button" className="icon-btn" aria-label={t('Remove')} onClick={() => { const n = { ...changes }; delete n[pid]; onChange(n) }}><Ic.Close size={13} /></button>
            {errs[pid] && <div className="db-err" role="alert">{errs[pid]}</div>}
          </div>
        )
      })}
      <button type="button" className="db-linkbtn" onClick={() => writable[0] && onChange({ ...changes, [(writable.find((p) => !changes[p.id]) ?? writable[0]).id]: { cell: null } })}><Ic.Plus size={12} /> {t('Add a change')}</button>
    </div>
  )
}

function JsonField({ label, value, set }: { label: string; value: Json; set: (v: Json) => void }) {
  const [txt, setTxt] = useState(JSON.stringify(value, null, 1))
  const [bad, setBad] = useState(false)
  return (
    <Field label={label}>
      <textarea className={'db-input mono' + (bad ? ' err' : '')} dir="ltr" rows={4} value={txt} onChange={(e) => { setTxt(e.target.value); try { set(JSON.parse(e.target.value)); setBad(false) } catch { setBad(true) } }} />
    </Field>
  )
}

function ActionEditor({ svc, sourceId, a, onChange, onRemove, onMove }: { svc: DatabaseService; sourceId: Id; a: Action; onChange: (a: Action) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const sources = svc.state.live('source')
  return (
    <div className="db-action">
      <div className="db-action-head">
        <Select value={a.type} options={(Object.keys(ACTION_LABEL) as Action['type'][]).map((k) => ({ value: k, label: t(ACTION_LABEL[k]) }))} onChange={(k) => onChange(blank(k as Action['type'], sourceId))} />
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label={t('Move up')} onClick={() => onMove(-1)}><Ic.Up size={13} /></button>
        <button type="button" className="icon-btn" aria-label={t('Move down')} onClick={() => onMove(1)}><span style={{ display: 'inline-block', transform: 'rotate(180deg)' }}><Ic.Up size={13} /></span></button>
        <button type="button" className="icon-btn" aria-label={t('Remove action')} onClick={onRemove}><Ic.Trash size={13} /></button>
      </div>
      {a.type === 'set_values' && <ChangesEditor svc={svc} sourceId={sourceId} changes={(a.changes as Changes) ?? {}} onChange={(c) => onChange({ ...a, changes: c as unknown as Json })} />}
      {a.type === 'create_page' && (
        <>
          <Field label={t('In')}><Select value={a.sourceId} options={sources.map((s) => ({ value: s.id, label: s.name }))} onChange={(v) => onChange({ ...a, sourceId: v })} /></Field>
          <Field label={t('Name it')}><input className="db-input" dir="auto" value={((a.values as { __title?: { text?: string } }).__title?.text) ?? ''} onChange={(e) => onChange({ ...a, values: { ...(a.values as Record<string, Json>), __title: { text: e.target.value } } as unknown as Json })} /></Field>
          <ChangesEditor svc={svc} sourceId={a.sourceId} changes={Object.fromEntries(Object.entries(a.values as Record<string, Json>).filter(([k]) => k !== '__title')) as Changes} onChange={(c) => onChange({ ...a, values: { ...c, __title: (a.values as Record<string, Json>).__title ?? { text: '' } } as unknown as Json })} />
        </>
      )}
      {a.type === 'edit_matching' && (
        <>
          <Field label={t('Items where')}><FilterEditor svc={svc} sourceId={sourceId} filter={((a.query as { filter?: Filter | null }).filter) ?? null} onChange={(f) => onChange({ ...a, query: { sourceId, filter: f } as unknown as Json })} /></Field>
          <ChangesEditor svc={svc} sourceId={sourceId} changes={(a.changes as Changes) ?? {}} onChange={(c) => onChange({ ...a, changes: c as unknown as Json })} />
          <div className="db-date-hint">{t('More than 1000 items need your approval each time.')}</div>
        </>
      )}
      {a.type === 'define_variable' && (
        <>
          <Field label={t('Name')}><input className="db-input" dir="ltr" value={a.name} onChange={(e) => onChange({ ...a, name: e.target.value.replace(/[^\p{L}\p{N}_]/gu, '') })} /></Field>
          <FormulaEditor svc={svc} sourceId={sourceId} selfId={null} source={a.expression} onChange={(s) => onChange({ ...a, expression: s })} />
        </>
      )}
      {a.type === 'notify' && <Field label={t('Message')} hint={t('Use {name} to insert a variable.')}><input className="db-input" dir="auto" value={a.message} onChange={(e) => onChange({ ...a, message: e.target.value })} /></Field>}
      {a.type === 'confirm' && (
        <>
          <Field label={t('Title')}><input className="db-input" dir="auto" value={a.title} onChange={(e) => onChange({ ...a, title: e.target.value })} /></Field>
          <Field label={t('Message')}><input className="db-input" dir="auto" value={a.message} onChange={(e) => onChange({ ...a, message: e.target.value })} /></Field>
        </>
      )}
      {a.type === 'open' && <Field label={t('Address (https://…)')}><input className="db-input" dir="ltr" value={a.url ?? ''} onChange={(e) => onChange({ ...a, url: e.target.value })} /></Field>}
      {(a.type === 'webhook' || a.type === 'email' || a.type === 'slack') && (
        <>
          <Field label={t('Connection')} hint={t('Secrets are stored outside your notes; set the connection up in Settings → Database.')}><input className="db-input" dir="ltr" value={a.connectionId} onChange={(e) => onChange({ ...a, connectionId: e.target.value })} /></Field>
          {a.type === 'webhook' ? <JsonField label={t('Request (JSON)')} value={a.request} set={(v) => onChange({ ...a, request: v })} /> : <JsonField label={t('Message (JSON)')} value={a.message} set={(v) => onChange({ ...a, message: v })} />}
        </>
      )}
    </div>
  )
}

function blank(type: Action['type'], sourceId: Id): Action {
  switch (type) {
    case 'set_values': return { type, target: 'trigger', changes: {} }
    case 'create_page': return { type, sourceId, values: {} }
    case 'edit_matching': return { type, query: { sourceId, filter: null }, changes: {} }
    case 'define_variable': return { type, name: 'x', expression: '' }
    case 'notify': return { type, recipients: 'trigger', message: '' }
    case 'confirm': return { type, title: '', message: '' }
    case 'open': return { type, url: '' }
    case 'webhook': return { type, connectionId: '', request: { method: 'POST', path: '/', body: {} } }
    default: return { type, connectionId: '', message: { to: '', subject: '', body: '' } } as Action
  }
}

function WorkflowEditor({ svc, sourceId, wf, propertyId, onDone, notify }: { svc: DatabaseService; sourceId: Id; wf: WorkflowRecord | null; propertyId: Id | null; onDone: () => void; notify: (m: string) => void }) {
  const [body, setBody] = useState<Body>(() => wf ? ({ ...wf } as unknown as Body) : { sourceId, name: '', kind: propertyId ? 'button' : 'automation', triggers: [], triggerMode: 'any', viewScopeId: null, actions: [], enabled: true, propertyId })
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
    } catch (e) { notify(e instanceof Error ? e.message : String(e)) }
  }
  const schedule = (body.triggers.find((x) => x.type === 'schedule') as Extract<Trigger, { type: 'schedule' }> | undefined)
  return (
    <div className="db-form wf">
      <Field label={t('Name')}><input className="db-input" dir="auto" value={body.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      {body.kind === 'automation' && (
        <>
          <Switch label={t('Turned on')} on={body.enabled} onChange={(v) => set({ enabled: v })} />
          <div className="db-field-l">{t('When')}</div>
          {body.triggers.map((tr, i) => (
            <div className="db-frow" key={i}>
              <Select value={tr.type} options={[{ value: 'page_added', label: t('An item is added') }, { value: 'property_changed', label: t('A property changes') }, { value: 'schedule', label: t('On a schedule') }]} onChange={(v) => setTrig(i, v === 'page_added' ? { type: 'page_added' } : v === 'schedule' ? { type: 'schedule', recurrence: { frequency: 'daily', interval: 1, startDate: new Date().toISOString().slice(0, 10), endDate: null, time: '09:00', timeZone: svc.zone } as unknown as Json } : { type: 'property_changed', propertyId: props.find((p) => p.kind !== 'title')?.id ?? props[0].id })} />
              {tr.type === 'property_changed' && <Select value={tr.propertyId} options={props.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => setTrig(i, { ...tr, propertyId: v })} />}
              <button type="button" className="icon-btn" aria-label={t('Remove')} onClick={() => set({ triggers: body.triggers.filter((_, j) => j !== i) })}><Ic.Close size={13} /></button>
            </div>
          ))}
          {!schedule && <button type="button" className="db-linkbtn" onClick={() => set({ triggers: [...body.triggers, { type: 'page_added' }] })}><Ic.Plus size={12} /> {t('Add a trigger')}</button>}
          {body.triggers.length > 1 && <Field label={t('Run when')}><Seg value={body.triggerMode} onChange={(v) => set({ triggerMode: v })} options={[{ value: 'any', label: t('Any trigger happens') }, { value: 'all', label: t('All happen within 3 seconds') }]} /></Field>}
          {schedule && (() => {
            const r = schedule.recurrence as unknown as RepeatSchedule
            const upd = (p: Partial<RepeatSchedule>) => set({ triggers: [{ type: 'schedule', recurrence: { ...r, ...p } as unknown as Json }] })
            return (
              <>
                <Field label={t('Repeat')}><Select value={r.frequency} options={['daily', 'weekly', 'monthly', 'yearly'].map((f) => ({ value: f, label: t(f[0].toUpperCase() + f.slice(1)) }))} onChange={(v) => upd({ frequency: v as RepeatSchedule['frequency'] })} /></Field>
                <div className="db-row2">
                  <Field label={t('Every')}><input className="db-input" type="number" min={1} dir="ltr" value={r.interval} onChange={(e) => upd({ interval: Math.max(1, Number(e.target.value) || 1) })} /></Field>
                  <Field label={t('At')}><input className="db-input" type="time" dir="ltr" value={r.time} onChange={(e) => upd({ time: e.target.value })} /></Field>
                </div>
                <Field label={t('Starting')}><input className="db-input" type="date" dir="ltr" value={r.startDate} onChange={(e) => upd({ startDate: e.target.value })} /></Field>
                <div className="db-date-hint">{t('Scheduled runs happen while the app is open on the device chosen as runner; missed runs are caught up once on the next start.')}</div>
              </>
            )
          })()}
          {!schedule && <Field label={t('Only for items in view')}><Select value={body.viewScopeId ?? ''} options={[{ value: '', label: t('All items') }, ...views.map((v) => ({ value: v.id, label: v.name }))]} onChange={(v) => set({ viewScopeId: v || null })} /></Field>}
        </>
      )}
      <div className="db-field-l">{t('Do')}</div>
      {body.actions.map((a, i) => (
        <ActionEditor key={i} svc={svc} sourceId={sourceId} a={a} onChange={(n) => set({ actions: body.actions.map((x, j) => (j === i ? n : x)) })} onRemove={() => set({ actions: body.actions.filter((_, j) => j !== i) })} onMove={(d) => { const n = [...body.actions]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; set({ actions: n }) }} />
      ))}
      <button type="button" className="db-linkbtn" onClick={() => set({ actions: [...body.actions, blank('set_values', sourceId)] })}><Ic.Plus size={12} /> {t('Add an action')}</button>
      {body.actions.length > 100 && <div className="db-err">{t('A workflow has at most 100 actions.')}</div>}
      {err && <div className="db-err" role="alert">{err}</div>}
      <div className="db-date-foot"><button type="button" onClick={onDone}>{t('Cancel')}</button><button type="button" onClick={() => void dry()}>{t('Test (dry run)')}</button><button type="button" className="primary" onClick={() => void save()}>{t('Save')}</button></div>
    </div>
  )
}

export function WorkflowPanel({ svc, sourceId, anchor, onClose, notify, focusProperty }: { svc: DatabaseService; sourceId: Id; anchor: DOMRect; onClose: () => void; notify: (m: string) => void; focusProperty: Id | null }) {
  const list = svc.state.live('workflow').filter((w) => w.sourceId === sourceId)
  const focused = focusProperty ? list.find((w) => w.propertyId === focusProperty) ?? null : null
  const [editing, setEditing] = useState<{ wf: WorkflowRecord | null; propertyId: Id | null } | null>(focusProperty ? { wf: focused, propertyId: focusProperty } : null)
  const runs = svc.state.live('event').filter((e) => e.type === 'workflow_run' && e.id.startsWith('run:')).map((e) => e.data as unknown as RunData).sort((a, b) => 0 - (a.attempt - b.attempt)).slice(-8).reverse()
  const outbox = svc.engine.outbox().slice(-6)
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="db-pop xwide" onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <WorkflowEditor svc={svc} sourceId={sourceId} wf={editing.wf} propertyId={editing.propertyId} onDone={() => (focusProperty ? onClose() : setEditing(null))} notify={notify} />
        ) : (
          <>
            <div className="db-field-l">{t('Buttons and automations')}</div>
            {list.length === 0 && <div className="db-empty-hint">{t('Nothing yet. Automations run when items change; buttons are added as a button property.')}</div>}
            {list.map((w) => (
              <div className="db-wf-row" key={w.id}>
                <span className={'db-wf-kind ' + w.kind}>{w.kind === 'button' ? t('Button') : t('Automation')}</span>
                <b dir="auto">{w.name}</b>
                {w.kind === 'automation' && <Switch label="" on={w.enabled} onChange={(v) => void svc.tryExec([{ type: 'workflow.save', payload: { id: w.id, body: { enabled: v } } }])} />}
                <button type="button" className="icon-btn" aria-label={t('Edit')} onClick={() => setEditing({ wf: w, propertyId: w.propertyId })}><Ic.Pencil size={13} /></button>
                <button type="button" className="icon-btn" aria-label={t('Delete')} onClick={async () => { if (await confirmDialog({ title: t('Delete “{n}”?', { n: w.name }), danger: true, confirmLabel: t('Delete') })) await svc.tryExec([{ type: 'record.trash', payload: { kind: 'workflow', id: w.id } }]) }}><Ic.Trash size={13} /></button>
              </div>
            ))}
            <button type="button" className="db-linkbtn" onClick={() => setEditing({ wf: null, propertyId: null })}><Ic.Plus size={12} /> {t('New automation')}</button>
            {(runs.length > 0 || outbox.length > 0) && (
              <details className="db-runs">
                <summary>{t('Recent runs')}</summary>
                {runs.map((r) => <div key={r.runKey} className={'db-run ' + r.state}>{list.find((w) => w.id === r.workflowId)?.name ?? '…'} — {r.state}{r.error ? `: ${r.error}` : ''}</div>)}
                {outbox.map((o) => <div key={o.id} className={'db-run ' + o.state}>{o.type} → {o.state}{o.error ? `: ${o.error}` : ''}</div>)}
              </details>
            )}
          </>
        )}
      </div>
    </Popover>
  )
}
