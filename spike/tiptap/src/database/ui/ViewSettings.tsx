// "View settings": layout switch and the settings of the current layout (cards, density, grouping, date property, open mode…).
import { useState } from 'react'
import type { Definition, Id, Json, View, ViewType } from '../model/types.ts'
import type { DatabaseService } from '../service.ts'
import { Popover } from '../../ui'
import { Select } from '../../ui'
import { t } from '../../i18n'
import { errorText } from './common'
import { Field, Seg, Switch } from './forms'
import { GroupEditor, type GroupConfig } from './ViewControls'
import { VIEW_ICON, VIEW_LABEL } from './viewMeta'
import type { ViewCtl } from './viewTypes'

const LAYOUTS: ViewType[] = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart', 'map', 'feed', 'form']

const propsOf = (svc: DatabaseService, view: View, kinds: string[]): Definition[] => svc.state.props(view.sourceId!).filter((p) => kinds.includes(p.kind))

export function ViewSettings({ svc, view, anchor, onClose, ctl }: { svc: DatabaseService; view: View; anchor: DOMRect; onClose: () => void; ctl: ViewCtl }) {
  const cfg = view.configuration as Record<string, Json>
  const [err, setErr] = useState<string | null>(null)
  const set = (patch: Record<string, Json>) => void ctl.patch(patch)
  const sel = (id: string, kinds: string[], label: string, none = false) => (
    <Field label={label}>
      <Select value={(cfg[id] as string) ?? ''} options={[...(none ? [{ value: '', label: t('None') }] : []), ...propsOf(svc, view, kinds).map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ [id]: v || null })} />
    </Field>
  )
  const setType = async (type: ViewType) => {
    const r = await svc.tryExec([{ type: 'view.set_type', payload: { viewId: view.id, type } }])
    if (!r.ok) setErr(errorText(r.code, r.message))
  }
  const sourceOk = !!view.sourceId
  const subItems = (svc.state.get('source', view.sourceId ?? '')?.settings as { subItems?: boolean } | undefined)?.subItems
  return (
    <Popover anchor={anchor} onClose={onClose} align="end">
      <div className="db-pop xwide" onClick={(e) => e.stopPropagation()}>
        {view.type !== 'dashboard' && (
          <div className="db-layouts" role="radiogroup" aria-label={t('Layout')}>
            {LAYOUTS.map((ty) => <button key={ty} type="button" role="radio" aria-checked={ty === view.type} className={'db-layout' + (ty === view.type ? ' on' : '')} disabled={!ctl.canSchema} onClick={() => void setType(ty)}>{VIEW_ICON[ty]()}<span>{t(VIEW_LABEL[ty])}</span></button>)}
          </div>
        )}
        {err && <div className="db-err" role="alert">{err}</div>}
        {sourceOk && view.type !== 'form' && view.type !== 'chart' && (
          <Field label={t('Open items in')}>
            <Seg value={(cfg.openMode as string) ?? 'side_peek'} onChange={(v) => set({ openMode: v })} options={[{ value: 'side_peek', label: t('Side peek') }, { value: 'center_peek', label: t('Center peek') }, { value: 'full_page', label: t('Full page') }]} />
          </Field>
        )}
        {view.type === 'table' && (
          <>
            <Field label={t('Row height')}><Seg value={(cfg.density as string) ?? 'compact'} onChange={(v) => set({ density: v })} options={[{ value: 'compact', label: t('Compact') }, { value: 'normal', label: t('Taller') }, { value: 'relaxed', label: t('Wrap text') }]} /></Field>
            <Switch label={t('Wrap long text')} on={!!cfg.wrap} onChange={(v) => set({ wrap: v })} />
            <Field label={t('Sub-items')}>
              <Select value={(cfg.subItems as string) ?? 'flat'} options={[{ value: 'flat', label: t('Flat list') }, { value: 'nested', label: t('Nested under parents') }, { value: 'parents', label: t('Parents only') }, { value: 'children', label: t('Sub-items only') }]} onChange={(v) => set({ subItems: v })} />
            </Field>
            {subItems === false && <div className="db-date-hint">{t('Sub-items are switched off for this source; stored links are kept.')}</div>}
          </>
        )}
        {view.type === 'board' && (
          <>
            {sel('groupPropertyId', ['select', 'multi_select', 'status', 'people', 'checkbox', 'relation', 'formula'], t('Group by'))}
            {sel('subgroupPropertyId', ['select', 'multi_select', 'status', 'people', 'checkbox', 'relation'], t('Sub-group by'), true)}
            <Field label={t('Card size')}><Seg value={(cfg.cardSize as string) ?? 'medium'} onChange={(v) => set({ cardSize: v })} options={[{ value: 'small', label: t('Small') }, { value: 'medium', label: t('Medium') }, { value: 'large', label: t('Large') }]} /></Field>
            <Switch label={t('Hide empty groups')} on={!!cfg.hideEmpty} onChange={(v) => set({ hideEmpty: v })} />
            {sel('coverPropertyId', ['files'], t('Card cover'), true)}
          </>
        )}
        {(view.type === 'gallery') && (
          <>
            <Field label={t('Card size')}><Seg value={(cfg.cardSize as string) ?? 'medium'} onChange={(v) => set({ cardSize: v })} options={[{ value: 'small', label: t('Small') }, { value: 'medium', label: t('Medium') }, { value: 'large', label: t('Large') }]} /></Field>
            <Field label={t('Preview')}><Select value={(cfg.previewSource as string) ?? 'cover'} options={[{ value: 'cover', label: t('Page cover') }, { value: 'content', label: t('First image in the page') }, { value: 'property', label: t('A files property') }, { value: 'none', label: t('None') }]} onChange={(v) => set({ previewSource: v })} /></Field>
            {cfg.previewSource === 'property' && sel('coverPropertyId', ['files'], t('Files property'))}
            <Field label={t('Image fit')}><Seg value={(cfg.fit as string) ?? 'cover'} onChange={(v) => set({ fit: v })} options={[{ value: 'cover', label: t('Fill') }, { value: 'contain', label: t('Fit') }]} /></Field>
          </>
        )}
        {view.type === 'calendar' && (
          <>
            {sel('datePropertyId', ['date', 'formula', 'created_time', 'last_edited_time'], t('Show by'))}
            <Field label={t('Mode')}><Seg value={(cfg.calendarMode as string) ?? 'month'} onChange={(v) => set({ calendarMode: v })} options={[{ value: 'month', label: t('Month') }, { value: 'week', label: t('Week') }]} /></Field>
          </>
        )}
        {view.type === 'timeline' && (
          <>
            {sel('datePropertyId', ['date', 'formula'], t('Range property'))}
            <Field label={t('Scale')}><Select value={(cfg.scale as string) ?? 'week'} options={['hour', 'day', 'week', 'month', 'quarter', 'year'].map((s) => ({ value: s, label: t(s[0].toUpperCase() + s.slice(1)) }))} onChange={(v) => set({ scale: v })} /></Field>
            <Switch label={t('Show the table')} on={cfg.showTable !== false} onChange={(v) => set({ showTable: v })} />
            <Switch label={t('Show dependency arrows')} on={cfg.showDependencies !== false} onChange={(v) => set({ showDependencies: v })} />
          </>
        )}
        {view.type === 'map' && sel('placePropertyId', ['place'], t('Place property'))}
        {view.type === 'list' && (
          <Field label={t('Density')}><Seg value={(cfg.density as string) ?? 'compact'} onChange={(v) => set({ density: v })} options={[{ value: 'compact', label: t('Compact') }, { value: 'normal', label: t('Comfortable') }]} /></Field>
        )}
        {(view.type === 'list' || view.type === 'gallery') && (
          <>
            <div className="db-field-l">{t('Group')}</div>
            <GroupEditor svc={svc} sourceId={view.sourceId!} group={(cfg.group as GroupConfig) ?? null} onChange={(g) => set({ group: g as Json })} />
          </>
        )}
        {view.type === 'feed' && <Switch label={t('Show view and comment counts')} on={cfg.counts !== false} onChange={(v) => set({ counts: v })} />}
        {sourceOk && ctl.canSchema && (
          <Field label={t('Default template for new items')}>
            <Select value={view.defaultTemplateId ?? ''} options={[{ value: '', label: t('Source default') }, ...svc.state.live('template').filter((tp) => tp.sourceId === view.sourceId).map((tp) => ({ value: tp.id, label: tp.name }))]} onChange={(v) => void svc.tryExec([{ type: 'view.patch', payload: { viewId: view.id, defaultTemplateId: (v || null) as Id | null } }])} />
          </Field>
        )}
      </div>
    </Popover>
  )
}
