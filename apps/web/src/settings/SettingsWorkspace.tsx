// the release switches of the old app (release-features.json): presets ship off; sync is part of this app
const APPEARANCE_PRESETS_ENABLED = false, SYNC_ENABLED = true, isTauri = true
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { useUIMotion } from '../ds/motion'
import { WorkspaceHeader } from '../ds/WorkspaceHeader'
import { BrandMark } from '../shell/BrandMark'
import { SaveStatus } from '../ds/SaveStatus'
import { useLabels } from './labels'
import { useState, type ReactNode } from 'react'
import { Button } from '../ds/Button'
import { Dropdown } from '../ds/Dropdown'
import { Brand } from '../shell/Brand'
import { DEFAULTS, FONTS, useSettings, updateSettings, type Settings } from '../deviceSettings'
import { Icon } from '../ds/icons'
import { SettingRow, SettingGroup, Range, Choice, Toggle } from './parts'
import { SidebarStylePicker } from './SidebarPreview'
import { LivePreview } from './WorkspacePreview'
import { AccentSwatches } from './AccentSwatches'
const TEXT_SIZE_MIN = 12, TEXT_SIZE_MAX = 28 // the editor's text-size range, as in the old app
import { appearancePresets } from '../appearancePresets'

export type Category = 'appearance' | 'editor' | 'language' | 'general' | 'data' | 'sync' | 'database' | 'connections' | 'shortcuts' | 'about'
const allCategories: { id: Category; label: string; icon: string; description: string }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'palette', description: 'A workspace that feels like you.' },
  { id: 'editor', label: 'Editor & font', icon: 'type', description: 'Make room for the way you write.' },
  { id: 'language', label: 'Language & layout', icon: 'globe', description: 'Your language. Your direction.' },
  { id: 'general', label: 'General', icon: 'settings', description: 'Small preferences that make a difference.' },
  { id: 'data', label: 'Data & backup', icon: 'download', description: 'A safe place for everything you keep.' },
  { id: 'sync', label: 'Sync', icon: 'cloud', description: 'Your notes, on every device you own.' },
  { id: 'database', label: 'Database', icon: 'table', description: 'The details behind your connected views.' },
  { id: 'connections', label: 'AI connection', icon: 'globe', description: 'Your knowledge. Your permission.' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', description: 'Find your flow, one shortcut at a time.' },
  { id: 'about', label: 'About', icon: 'info', description: 'A calm home for your ideas.' },
]
// the AI connection tab comes with the desktop MCP bridge (M14); until then it is not offered
const categories = allCategories.filter(c => c.id !== 'connections' && (c.id !== 'sync' || (SYNC_ENABLED && isTauri)))
export function Appearance() {
  const s = useSettings(), l = useLabels()
  return <>
    <SettingGroup title={l('Theme & color')}>
      {APPEARANCE_PRESETS_ENABLED && (<SettingRow label={l('Appearance preset')}><Choice label={l('Appearance preset')} value={s.appearancePreset} items={appearancePresets.map(({ id, label }) => ({ value: id, label: l(label) }))} onChange={appearancePreset => updateSettings({ appearancePreset })} /></SettingRow>)}
      <SettingRow label={l('Theme')} hint={l('Set the mood for your workspace.')}><Choice label={l('Theme')} value={s.theme} items={[{ value: 'light', label: l('Light'), icon: 'sun' }, { value: 'dark', label: l('Dark'), icon: 'moon' }, { value: 'system', label: l('System'), icon: 'monitor' }]} onChange={theme => updateSettings({ theme })} /></SettingRow>
      <SettingRow label={l('Accent color')} hint={l('A small detail. A personal touch.')}><AccentSwatches /></SettingRow>
    </SettingGroup>
    <SettingGroup title={l('Workspace')}>
      <SettingRow label={l('Corner radius')} hint={l('From crisp edges to softer shapes.')}><Range label={l('Corner radius')} value={s.radius} min={4} max={20} onChange={radius => updateSettings({ radius })} /></SettingRow>
      <SidebarStylePicker />
      <SettingRow label={l('Page list')}><Dropdown label={l('Page list')} value={s.pagesView} options={[{ value: 'tree', label: l('Tree') }, { value: 'compact', label: l('Compact') }]} onChange={pagesView => updateSettings({ pagesView })} /></SettingRow>
    </SettingGroup>
    <SettingGroup title={l('Page details')}><Toggle label={l('Show cover image')} hint={l('Give each page a little personality.')} setting="showCovers" /><Toggle label={l('Show page icons')} hint={l('Recognize a page at a glance.')} setting="showIcons" /></SettingGroup>
  </>
}
export function EditorSettings() {
  const s = useSettings(), l = useLabels()
  return <SettingGroup title={l('Typography')}>
    <SettingRow label={l('Persian & Arabic font')}><Dropdown label={l('Persian & Arabic font')} value={s.font} options={FONTS.filter(f => f.group !== 'english').map(f => ({ value: f.id, label: f.label }))} onChange={font => updateSettings({ font })} /></SettingRow>
    <SettingRow label={l('English font')}><Dropdown label={l('English font')} value={s.fontEn ?? 'default'} options={[{ value: 'default', label: 'Instrument Sans' }, ...FONTS.filter(f => f.group !== 'persian').map(f => ({ value: f.id, label: f.label }))]} onChange={font => updateSettings({ fontEn: font === 'default' ? null : font as Settings['font'] })} /></SettingRow>
    <SettingRow label={l('Text size')} hint={l('Editor text stays independent of interface sizing.')}><Range label={l('Text size')} value={s.fontSize} min={TEXT_SIZE_MIN} max={TEXT_SIZE_MAX} onChange={fontSize => updateSettings({ fontSize })} /></SettingRow>
  </SettingGroup>
}
export function LanguageSettings() {
  const s = useSettings(), l = useLabels()
  return <SettingGroup title={l('Language & layout')}>
    <SettingRow label={l('Interface language')} hint={l('Your notes are never translated.')}><Choice label={l('Interface language')} value={s.lang} items={[{ value: 'en', label: 'English' }, { value: 'fa', label: 'فارسی' }]} onChange={lang => updateSettings({ lang })} /></SettingRow>
    <SettingRow label={l('Layout direction')} hint={l('Controls the interface, not the text in your notes.')}><Dropdown label={l('Layout direction')} value={s.dir} options={[{ value: 'auto', label: l('Auto') }, { value: 'ltr', label: l('Left to right') }, { value: 'rtl', label: l('Right to left') }]} onChange={dir => updateSettings({ dir })} /></SettingRow>
  </SettingGroup>
}
export function GeneralSettings() {
  const l = useLabels()
  return <SettingGroup title={l('Comfort')}><Toggle label={l('Reduce motion')} hint={l('Keep transitions quiet and immediate.')} setting="reduceMotion" /></SettingGroup>
}
export interface WorkspaceProps {
  onLeave?: () => void
  embedded?: boolean
  panelHost?: HTMLElement | null
  initialCategory?: Category
  activeCategory?: Category
  onCategoryChange?: (category: Category) => void
  panels?: Partial<Record<Category, ReactNode>>
  appearanceExtras?: ReactNode
  editorExtras?: ReactNode
  context?: (category: Category) => ReactNode
  onReset?: () => void
}
export function SettingsWorkspace({ embedded = false, panelHost, initialCategory = 'appearance', activeCategory, onCategoryChange, panels = {}, appearanceExtras, editorExtras, context, onReset, onLeave }: WorkspaceProps) {
  const motionOf = useUIMotion(), [localCategory, setCategory] = useState<Category>(initialCategory), [reset, setReset] = useState(false)
  const current = categories.find(item => item.id === (activeCategory ?? localCategory)) ?? categories[0]!
  const category = current.id
  const s = useSettings(), l = useLabels()
  const Main = embedded ? 'div' : 'main'
  const navigation = <nav className="prefs-categories" aria-label={l('Settings')}>{categories.map(c => <Button key={c.id} className="prefs-nav-button" variant="ghost" data-testid={`settings-tab-${c.id}`} aria-current={category === c.id ? 'page' : undefined} onClick={() => { setCategory(c.id); onCategoryChange?.(c.id); setReset(false); if (embedded) document.querySelector('.prefs-embedded .prefs-main')?.scrollTo(0, 0); else window.scrollTo(0, 0) }} icon={<Icon name={c.icon} />}><span>{l(c.label)}</span></Button>)}</nav>
  return <div className={"prefs-shell" + (embedded ? " prefs-embedded" : "")}>
    {panelHost && createPortal(navigation, panelHost)}
    {panelHost === undefined && <aside className="prefs-nav">
      <div className="prefs-brand"><WorkspaceHeader mark={<BrandMark />} name={<Brand />} /></div>
      
      <div className="prefs-workspace"><span className="prefs-workspace-icon"><Icon name="layers" /></span><div><b>{l('Personal space')}</b><small>{l('Local workspace')}</small></div></div>
      <div className="prefs-nav-caption">{l('Preferences')}</div>
      {navigation}
      <div className="prefs-nav-footer">{onLeave && <Button className="prefs-nav-button prefs-back" variant="ghost" icon={<Icon name="arrow-left" className="ds-flip" />} onClick={onLeave}><span>{l('Back to workspace')}</span></Button>}<span className="prefs-prefs-tag">{l(embedded ? 'Settings' : 'Design study')}</span><p>{l(embedded ? 'Make the appearance and editor your own.' : 'A preview of the new shared UI direction.')}</p>{!embedded && <small>{l('Preview settings stay separate from your app.')}</small>}</div>
    </aside>}
    <Main className="prefs-main">
      <header className="prefs-top"><span>{l('Workspace')}<span>/</span>{l('Settings')}</span><SaveStatus state="saved" label={l('Saved locally')} /></header>
      <div className="prefs-content">
        <div className="prefs-title"><div><span className="prefs-eyebrow">{l('Make yourself at home')}</span><h1>{l('Settings')}</h1><p>{l('Thoughtful defaults. A few personal touches.')}</p></div></div>
        <div className="prefs-columns"><motion.div className="prefs-panel" key={category} initial={motionOf.reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={motionOf.transition}><header className="prefs-panel-title"><h2>{l(current.label)}</h2><p>{l(current.description)}</p></header>{panels[category] ?? (category === 'appearance' ? <><Appearance />{appearanceExtras}</> : category === 'editor' ? <><EditorSettings />{editorExtras}</> : category === 'language' ? <LanguageSettings /> : category === 'general' ? <GeneralSettings /> : null)}
          <footer className="prefs-panel-footer"><span>{l(embedded ? 'Changes save automatically.' : 'Preview settings stay separate from your app.')}</span>{['appearance','editor','language','general'].includes(category) && <Button size="sm" variant="ghost" onClick={() => onReset ? onReset() : setReset(!reset)}>{l(embedded ? 'Reset all' : 'Reset preview')}</Button>}</footer>
          {reset && <section className="prefs-reset" aria-label={l('Reset preview')}><p>{l('Reset these preview preferences? Your notes and other app windows are unaffected.')}</p><div><Button size="sm" onClick={() => setReset(false)}>{l('Cancel')}</Button><Button size="sm" variant="primary" onClick={() => { updateSettings({ ...DEFAULTS, lang: s.lang, dir: s.dir }); setReset(false) }}>{l('Reset preview')}</Button></div></section>}
        </motion.div>{['appearance', 'editor', 'language', 'general'].includes(category) ? <LivePreview /> : context?.(category)}</div>
      </div>
    </Main>
  </div>
}

