import { WorkspaceMark } from './WorkspaceMark'
import { shortcutLabel } from '../shortcuts'
import { useLabels } from './labels'
import { Icon } from '../design-system/icons'
import { updateSettings, useSettings, type Settings } from '../settings'


type Mode = Settings['sidebar']
const styles: { id: Mode; label: string; hint: string }[] = [
  { id: 'default', label: 'Default', hint: 'Room to navigate' },
  { id: 'compact', label: 'Compact', hint: 'Less space, same labels' },
  { id: 'icons', label: 'Icons only', hint: 'Just the essentials' },
]
/** The chooser and live preview share this same miniature, so mode geometry cannot drift. */
export function SidebarSample({ mode, pagesView = 'tree', thumbnail = false }: { mode: Mode; pagesView?: Settings['pagesView']; thumbnail?: boolean }) {
  const l = useLabels()
  return <div className={'prefs-sidebar-sample' + (thumbnail ? ' thumbnail' : '')} data-mode={mode} aria-hidden={thumbnail || undefined}>
    <div className="sample-brand"><WorkspaceMark /><b>Nevis.</b></div>
    <div className="sample-search"><Icon name="search" /><span>{l('Search')}</span><kbd>{shortcutLabel(['Mod', 'K'])}</kbd></div>
    <div className="sample-nav">
      {[['home', 'Home'], ['tasks', 'Tasks'], ['layers', 'Flashcards']].map(([icon, label]) => <div key={label} className="sample-nav-row"><Icon name={icon} /><span>{l(label)}</span>{label === 'Flashcards' && <i className="sample-count">6</i>}</div>)}
      <div className="sample-collections"><small className="sample-section">{l('Pages')}</small>
      <div className="sample-nav-row"><Icon name="folder" /><span>{l('Personal space')}</span></div>
      <div className={'sample-nav-row selected' + (pagesView === 'tree' ? ' nested' : '')}><Icon name="book" /><span>{l('Notes')}</span></div>
      <div className={'sample-nav-row' + (pagesView === 'tree' ? ' nested' : '')}><Icon name="file" /><span>{l('Reading list')}</span></div></div>
    </div>
    <div className="sample-footer"><div className="sample-nav-row"><Icon name="settings" /><span>{l('Settings')}</span></div><div className="sample-new ds-split"><span className="ds-btn ds-btn--primary sample-new-main"><Icon name="plus" /><span>{l('New page')}</span></span><span className="ds-btn ds-btn--primary sample-new-more"><Icon name="chevron-right" /></span></div></div>
  </div>
}
export function SidebarStylePicker() {
  const s = useSettings(), l = useLabels()
  return <fieldset className="prefs-sidebar-picker"><legend>{l('Sidebar style')}</legend><p>{l('Choose how much room navigation takes. Compact keeps every label.')}</p>
    <div className="prefs-sidebar-options">{styles.map(style => <label key={style.id} className="prefs-sidebar-option">
      <input type="radio" name="sidebar-style" value={style.id} checked={s.sidebar === style.id} onChange={() => updateSettings({ sidebar: style.id })} />
      <span className="prefs-sidebar-tile"><span className="prefs-sidebar-thumbnail"><SidebarSample mode={style.id} thumbnail /><span className="sample-fake-page"><i /><i /><i /></span></span><span className="prefs-sidebar-caption"><b>{l(style.label)}</b><span className="prefs-radio-mark" /></span><small>{l(style.hint)}</small></span>
    </label>)}</div>
  </fieldset>
}
