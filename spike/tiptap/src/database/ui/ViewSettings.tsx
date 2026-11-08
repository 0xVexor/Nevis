// "View settings": the layout of the view and the settings of that layout (cards, density, grouping, date property, open mode…).
import { useState } from 'react'
import type { Definition, Id, Json, View, ViewType } from '../model/types.ts'
import type { DatabaseService } from '../service.ts'
import { Dropdown, FormField, Panel, Popover, Segmented, SwitchRow } from '../../design-system'
import { t } from '../../i18n'
import { ErrorLine, Hint, errorText, rawOptions } from './common'
import { GroupEditor, type GroupConfig } from './ViewControls'
import { VIEW_LABEL, ViewIcon } from './viewMeta'
import type { ViewCtl } from './viewTypes'

const LAYOUTS: ViewType[] = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart', 'map', 'feed', 'form']

const propsOf = (svc: DatabaseService, view: View, kinds: string[]): Definition[] => svc.state.props(view.sourceId!).filter((p) => kinds.includes(p.kind))

export function ViewSettings({ svc, view, anchor, onClose, ctl }: { svc: DatabaseService; view: View; anchor: DOMRect; onClose: () => void; ctl: ViewCtl }) {
  const cfg = view.configuration as Record<string, Json>
  const [err, setErr] = useState<string | null>(null)
  const set = (patch: Record<string, Json>) => void ctl.patch(patch)
  const pick = (id: string, kinds: string[], label: string, none = false) => (
    <FormField label={label}>
      <Dropdown
        label={label}
        placeholder={t('Choose…')}
        value={(cfg[id] as string) ?? ''}
        options={[...(none ? [{ value: '', label: 'None' }] : []), ...rawOptions(propsOf(svc, view, kinds))]}
        onChange={(v) => set({ [id]: v || null })}
      />
    </FormField>
  )
  const setType = async (type: ViewType) => {
    const r = await svc.tryExec([{ type: 'view.set_type', payload: { viewId: view.id, type } }])
    setErr(r.ok ? null : errorText(r.code, r.message))
  }
  const sourceOk = !!view.sourceId
  const subItems = (svc.state.get('source', view.sourceId ?? '')?.settings as { subItems?: boolean } | undefined)?.subItems
  const cardSize = (
    <FormField label={t('Card size')}>
      <Segmented
        label={t('Card size')}
        value={(cfg.cardSize as string) ?? 'medium'}
        onChange={(v) => set({ cardSize: v })}
        options={[
          { value: 'small', label: t('Small') },
          { value: 'medium', label: t('Medium') },
          { value: 'large', label: t('Large') },
        ]}
      />
    </FormField>
  )
  return (
    <Popover anchor={anchor} onClose={onClose} align="end">
      <Panel title={t('View settings')} className="dv-view-settings">
        {view.type !== 'dashboard' && (
          <FormField label={t('Layout')}>
            <div className="dv-layouts" role="radiogroup" aria-label={t('Layout')}>
              {LAYOUTS.map((ty) => (
                <button key={ty} type="button" role="radio" aria-checked={ty === view.type} className="dv-layout" disabled={!ctl.canSchema} onClick={() => void setType(ty)}>
                  <ViewIcon type={ty} size={18} />
                  <span>{t(VIEW_LABEL[ty])}</span>
                </button>
              ))}
            </div>
          </FormField>
        )}
        {err && <ErrorLine>{err}</ErrorLine>}
        {sourceOk && view.type !== 'form' && view.type !== 'chart' && (
          <FormField label={t('Open items in')}>
            <Segmented
              label={t('Open items in')}
              value={(cfg.openMode as string) ?? 'side_peek'}
              onChange={(v) => set({ openMode: v })}
              options={[
                { value: 'side_peek', label: t('Side peek') },
                { value: 'center_peek', label: t('Center peek') },
                { value: 'full_page', label: t('Full page') },
              ]}
            />
          </FormField>
        )}
        {view.type === 'table' && (
          <>
            <FormField label={t('Row height')}>
              <Segmented
                label={t('Row height')}
                value={(cfg.density as string) ?? 'compact'}
                onChange={(v) => set({ density: v })}
                options={[
                  { value: 'compact', label: t('Compact') },
                  { value: 'normal', label: t('Taller') },
                  { value: 'relaxed', label: t('Wrap text') },
                ]}
              />
            </FormField>
            <SwitchRow label={t('Wrap long text')} checked={!!cfg.wrap} onChange={(v) => set({ wrap: v })} />
            <FormField label={t('Sub-items')}>
              <Dropdown
                label={t('Sub-items')}
                value={(cfg.subItems as string) ?? 'flat'}
                options={[
                  { value: 'flat', label: 'Flat list' },
                  { value: 'nested', label: 'Nested under parents' },
                  { value: 'parents', label: 'Parents only' },
                  { value: 'children', label: 'Sub-items only' },
                ]}
                onChange={(v) => set({ subItems: v })}
              />
            </FormField>
            {subItems === false && <Hint>{t('Sub-items are switched off for this source; stored links are kept.')}</Hint>}
          </>
        )}
        {view.type === 'board' && (
          <>
            {pick('groupPropertyId', ['select', 'multi_select', 'status', 'people', 'checkbox', 'relation', 'formula'], t('Group by'))}
            {pick('subgroupPropertyId', ['select', 'multi_select', 'status', 'people', 'checkbox', 'relation'], t('Sub-group by'), true)}
            {cardSize}
            <SwitchRow label={t('Hide empty groups')} checked={!!cfg.hideEmpty} onChange={(v) => set({ hideEmpty: v })} />
            {pick('coverPropertyId', ['files'], t('Card cover'), true)}
          </>
        )}
        {view.type === 'gallery' && (
          <>
            {cardSize}
            <FormField label={t('Preview')}>
              <Dropdown
                label={t('Preview')}
                value={(cfg.previewSource as string) ?? 'cover'}
                options={[
                  { value: 'cover', label: 'Page cover' },
                  { value: 'content', label: 'First image in the page' },
                  { value: 'property', label: 'A files property' },
                  { value: 'none', label: 'None' },
                ]}
                onChange={(v) => set({ previewSource: v })}
              />
            </FormField>
            {cfg.previewSource === 'property' && pick('coverPropertyId', ['files'], t('Files property'))}
            <FormField label={t('Image fit')}>
              <Segmented
                label={t('Image fit')}
                value={(cfg.fit as string) ?? 'cover'}
                onChange={(v) => set({ fit: v })}
                options={[
                  { value: 'cover', label: t('Fill') },
                  { value: 'contain', label: t('Fit') },
                ]}
              />
            </FormField>
          </>
        )}
        {view.type === 'calendar' && (
          <>
            {pick('datePropertyId', ['date', 'formula', 'created_time', 'last_edited_time'], t('Show by'))}
            <FormField label={t('Mode')}>
              <Segmented
                label={t('Mode')}
                value={(cfg.calendarMode as string) ?? 'month'}
                onChange={(v) => set({ calendarMode: v })}
                options={[
                  { value: 'month', label: t('Month') },
                  { value: 'week', label: t('Week') },
                ]}
              />
            </FormField>
          </>
        )}
        {view.type === 'timeline' && (
          <>
            {pick('datePropertyId', ['date', 'formula'], t('Range property'))}
            <FormField label={t('Scale')}>
              <Dropdown
                label={t('Scale')}
                value={(cfg.scale as string) ?? 'week'}
                options={['hour', 'day', 'week', 'month', 'quarter', 'year'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))}
                onChange={(v) => set({ scale: v })}
              />
            </FormField>
            <SwitchRow label={t('Show the table')} checked={cfg.showTable !== false} onChange={(v) => set({ showTable: v })} />
            <SwitchRow label={t('Show dependency arrows')} checked={cfg.showDependencies !== false} onChange={(v) => set({ showDependencies: v })} />
          </>
        )}
        {view.type === 'map' && pick('placePropertyId', ['place'], t('Place property'))}
        {view.type === 'list' && (
          <FormField label={t('Density')}>
            <Segmented
              label={t('Density')}
              value={(cfg.density as string) ?? 'compact'}
              onChange={(v) => set({ density: v })}
              options={[
                { value: 'compact', label: t('Compact') },
                { value: 'normal', label: t('Comfortable') },
              ]}
            />
          </FormField>
        )}
        {(view.type === 'list' || view.type === 'gallery') && <GroupEditor svc={svc} sourceId={view.sourceId!} group={(cfg.group as GroupConfig) ?? null} onChange={(g) => set({ group: g as Json })} />}
        {view.type === 'feed' && <SwitchRow label={t('Show view and comment counts')} checked={cfg.counts !== false} onChange={(v) => set({ counts: v })} />}
        {sourceOk && ctl.canSchema && (
          <FormField label={t('Default template for new items')}>
            <Dropdown
              label={t('Default template for new items')}
              value={view.defaultTemplateId ?? ''}
              options={[
                { value: '', label: 'Source default' },
                ...rawOptions(svc.state.live('template').filter((tp) => tp.sourceId === view.sourceId)),
              ]}
              onChange={(v) => void svc.tryExec([{ type: 'view.patch', payload: { viewId: view.id, defaultTemplateId: (v || null) as Id | null } }])}
            />
          </FormField>
        )}
      </Panel>
    </Popover>
  )
}
