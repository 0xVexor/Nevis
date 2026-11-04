import { ShortcutsSettings } from '../../settings-ui/ShortcutsSettings'
import { useLabels } from '../../settings-ui/labels'
import { BrandMark } from '../../BrandMark'
import { useRef, useState } from 'react'
import { Button } from '../../design-system/Button'
import { Disclosure, Field, Notice, Switch } from '../../design-system/controls'
import { Dropdown } from '../../design-system/Menu'
import { Icon } from '../../design-system/icons'
import { getSettings, updateSettings, type Settings } from '../../settings'
import { setPreference } from '../../preferenceEvents'
import appPackage from '../../../package.json'
import { SettingGroup, SettingRow, Toggle } from '../../settings-ui/parts'
import type { Category } from '../../settings-ui/SettingsWorkspace'
import { readStudyBackup, STUDY_FORMAT } from './backup'

function Note({ title, children, icon = 'info' }: { title: string; children: string; icon?: string }) {
  return <div className="prefs-note"><Icon name={icon} /><div><b>{title}</b><p>{children}</p></div></div>
}
function readLocal<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem('nevis.study.' + key) ?? 'null') ?? fallback } catch { return fallback }
}
function useLocal<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readLocal(key, fallback))
  const save = (next: T) => { setValue(next); localStorage.setItem('nevis.study.' + key, JSON.stringify(next)) }
  return [value, save] as const
}
function BackupSettings() {
  const l = useLabels(), file = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState(''), [error, setError] = useState('')
  const [review, setReview] = useState<Partial<Settings> | null>(null)
  const [lastExport, setLastExport] = useLocal('lastExport', '')
  const exportPreview = () => {
    const blob = new Blob([JSON.stringify({ format: STUDY_FORMAT, exportedAt: new Date().toISOString(), preferences: getSettings() }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = 'nevis-preview-preferences.json'; a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setLastExport(new Date().toISOString()); setMessage(l('Preview preferences exported.')); setError('')
  }
  return <>
    <Note title={l('Your main workspace is untouched')} icon="shield">{l('This study contains preferences only. Full document backups, attachments and workspace restore stay in the desktop app.')}</Note>
    <SettingGroup title={l('Export & restore')}>
      <SettingRow label={l('Export preview preferences')} hint={l('A portable JSON copy of the appearance and editor settings on this port.')}><Button icon={<Icon name="download" />} onClick={exportPreview}>{l('Export JSON')}</Button></SettingRow>
      <SettingRow label={l('Restore preview preferences')} hint={l('Review a preview export before applying it. Existing notes are never replaced.')}><Button icon={<Icon name="upload" />} onClick={() => file.current?.click()}>{l('Choose a file')}</Button><input ref={file} hidden type="file" accept=".json,application/json" onChange={async event => { const selected = event.target.files?.[0]; if (!selected) return; try { if (selected.size > 1_000_000) throw new Error('This file is too large.'); setReview(readStudyBackup(await selected.text())); setError(''); setMessage('') } catch (e) { setError(l(e instanceof Error ? e.message : 'Could not read the file.')) } event.target.value = '' }} /></SettingRow>
      {lastExport && <p className="prefs-caption">{l('Last export')}: <time dateTime={lastExport}>{new Date(lastExport).toLocaleString()}</time></p>}
      {review && <section className="prefs-review"><h3>{l('Ready to restore preferences')}</h3><p>{l('Theme, fonts, language and layout will be applied to this preview only.')}</p><div className="prefs-actions"><Button onClick={() => setReview(null)}>{l('Cancel')}</Button><Button variant="primary" onClick={() => { updateSettings(review); setReview(null); setMessage(l('Preview preferences restored.')) }}>{l('Apply preferences')}</Button></div></section>}
      {message && <Notice tone="ok" role="status" compact>{message}</Notice>}{error && <Notice tone="bad" compact>{error}</Notice>}
    </SettingGroup>
    <SettingGroup title={l('Automatic backups')}>
      <SettingRow label={l('Back up automatically')} hint={l('Scheduled vault backups need the desktop app and an open workspace.')}><Switch label={l('Back up automatically')} checked={false} disabled onChange={() => {}} /></SettingRow>
      <SettingRow label={l('Backup folder')} hint={l('Choose a folder outside your vault in the desktop app.')}><Button disabled>{l('Choose folder')}</Button></SettingRow>
      <SettingRow label={l('Back up now')} hint={l('Documents, databases and attachments are included in a full vault backup.')}><Button disabled>{l('Create backup')}</Button></SettingRow>
    </SettingGroup>
    <SettingGroup title={l('Import & workspaces')}>
      <SettingRow label={l('Import notes')} hint={l('Markdown, text and backup import use the existing review flow in the app.')}><Button disabled>{l('Import files')}</Button></SettingRow>
      <SettingRow label={l('Workspaces')} hint={l('Switch, create and restore workspaces in Nevis.')}><Button disabled>{l('Manage workspaces')}</Button></SettingRow>
    </SettingGroup>
  </>
}
function ConnectionSettings() {
  const l = useLabels()
  const [policy, setPolicy] = useLocal('aiPolicy', { allowWrites: false, scope: 'selected', client: 'claude', excluded: false })
  const set = (patch: Partial<typeof policy>) => setPolicy({ ...policy, ...patch })
  return <>
    <div className="prefs-connection-head"><span className="prefs-service-icon"><Icon name="globe" /></span><div><b>{l('Nevis local connection')}</b><p>{l('Read your knowledge. Keep control.')}</p></div><span className="prefs-status-tag">{l('Not connected')}</span></div>
    <Note title={l('Desktop connection required')} icon="shield">{l('This browser preview cannot expose your documents or install an AI client. The controls below preview an access policy only.')}</Note>
    <SettingGroup title={l('Access policy preview')}>
      <SettingRow label={l('Allow AI access')} hint={l('Only an active desktop bridge can enable document access.')}><Switch checked={false} disabled label={l('Allow AI access')} onChange={() => {}} /></SettingRow>
      <SettingRow label={l('Allow document editing')} hint={l('Preview setting only. Off means read-only; no permissions are granted here.')}><Switch checked={policy.allowWrites} label={l('Allow document editing')} onChange={allowWrites => set({ allowWrites })} /></SettingRow>
      <SettingRow label={l('Document scope')} hint={l('Choose what a future connection would be allowed to see.')}><Dropdown label={l('Document scope')} value={policy.scope} options={[{ value: 'selected', label: l('Selected pages') }, { value: 'vault', label: l('Whole workspace') }]} onChange={scope => set({ scope })} /></SettingRow>
      <SettingRow label={l('Exclude private pages')} hint={l('Page exclusions are selected from your actual vault in the desktop app.')}><Switch checked={policy.excluded} label={l('Exclude private pages')} onChange={excluded => set({ excluded })} /></SettingRow>
    </SettingGroup>
    <SettingGroup title={l('Connect a client')}>
      <SettingRow label={l('AI app')}><Dropdown label={l('AI app')} value={policy.client} options={[{ value: 'claude', label: 'Claude Desktop' }, { value: 'codex', label: 'ChatGPT / Codex' }, { value: 'gemini', label: 'Gemini CLI' }]} onChange={client => set({ client })} /></SettingRow>
      <div className="prefs-actions"><Button variant="primary" disabled>{l('Add to AI app')}</Button><Button disabled>{l('Copy connection')}</Button></div>
      <Disclosure className="prefs-disclosure" title={l('How the connection works')}><ol><li>{l('Open your vault in the desktop app.')}</li><li>{l('Review the scope and editing permissions.')}</li><li>{l('Enable the connection, add your client, then restart the AI app.')}</li></ol><p>{l('The connection works only while Nevis is open. Changing vaults disconnects the client.')}</p></Disclosure>
    </SettingGroup>
  </>
}
function DatabaseSettings() {
  const l = useLabels()
  const [config, setConfig] = useLocal('databaseDraft', { week: '6', tiles: '', attribution: '', gateway: '' })
  const [token, setToken] = useState(''), [saved, setSaved] = useState(false)
  const set = (patch: Partial<typeof config>) => { setConfig({ ...config, ...patch }); setSaved(false) }
  const tilesInvalid = !!config.tiles && !/^https:\/\/.*\{z\}.*\{x\}.*\{y\}/.test(config.tiles)
  const gatewayInvalid = !!config.gateway && !/^https:\/\//.test(config.gateway) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(config.gateway)
  return <>
    <SettingGroup title={l('Calendar')}>
      <SettingRow label={l('First day of the week')} hint={l('Used by calendar views, week filters and charts.')}><Dropdown label={l('First day of the week')} value={config.week} options={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((label, index) => ({ value: String(index), label: l(label) }))} onChange={week => set({ week })} /></SettingRow>
    </SettingGroup>
    <SettingGroup title={l('Maps')}>
      <label className="prefs-field"><span>{l('Map tile URL')}</span><Field ltr value={config.tiles} placeholder="https://tiles.example.com/{z}/{x}/{y}.png" aria-invalid={tilesInvalid} onChange={event => set({ tiles: event.target.value })} /><small>{l('Choose an HTTPS provider with {z}, {x} and {y}. No provider is built in.')}</small></label>
      {tilesInvalid && <Notice tone="bad" compact>{l('Use an HTTPS URL containing {z}, {x} and {y}.')}</Notice>}
      <label className="prefs-field"><span>{l('Map attribution')}</span><Field value={config.attribution} placeholder={l('Map provider attribution')} onChange={event => set({ attribution: event.target.value })} /></label>
    </SettingGroup>
    <SettingGroup title={l('Gateway')}>
      <p className="prefs-caption">{l('Connect your own gateway for public forms and scheduled messages. Saving does not contact a server.')}</p>
      <label className="prefs-field"><span>{l('Gateway address')}</span><Field ltr value={config.gateway} placeholder="https://gateway.example.com" aria-invalid={gatewayInvalid} onChange={event => set({ gateway: event.target.value })} /></label>
      {gatewayInvalid && <Notice tone="bad" compact>{l('Use HTTPS, or an HTTP localhost address.')}</Notice>}
      <label className="prefs-field"><span>{l('Gateway owner token')}</span><Field ltr type="password" autoComplete="off" value={token} onChange={event => { setToken(event.target.value); setSaved(false) }} /><small>{l('Use a test value in this preview. The token is kept in memory and is not sent anywhere.')}</small></label>
      <div className="prefs-actions"><Button variant="primary" disabled={tilesInvalid || gatewayInvalid} onClick={() => { setPreference('not.db.weekStart', config.week); setPreference('not.db.map', config.tiles ? JSON.stringify({ template: config.tiles, attribution: config.attribution }) : 'null'); setPreference('not.db.gateway', config.gateway); setSaved(true) }}>{l('Save preview configuration')}</Button><Button disabled>{l('Check connection')}</Button></div>
      {saved && <Notice tone="ok" role="status" compact>{l('Configuration saved on this preview origin. No server was contacted.')}</Notice>}
    </SettingGroup>
    <div className="prefs-status-list"><div><span>{l('Local database')}</span><b>{l('On this device')}</b></div><div><span>{l('Gateway')}</span><b>{l('Not verified')}</b></div><div><span>{l('Connected providers')}</span><b>{l('Not connected')}</b></div></div>
  </>
}
function AboutSettings() {
  const l = useLabels()
  return <>
    <div className="prefs-about-brand"><BrandMark size={32} /><h3>Nevis<span>.</span></h3><p>{l('Your notes, checklists and drawings in one calm place. Everything stays on your device.')}</p><span className="prefs-status-tag">{l('Version')} {appPackage.version}</span></div>
    <SettingGroup title={l('Updates')}><SettingRow label={l('App updates')} hint={l('Update checks and installation run in the desktop app.')}><Button disabled>{l('Check for updates')}</Button></SettingRow><Toggle label={l('Receive pre-release updates')} hint={l('Include early versions that may be less stable.')} setting="prereleaseUpdates" /></SettingGroup>
    <SettingGroup title={l('Design system')}><p className="prefs-caption">{l('This preview explores the shared foundations and complete Settings navigation before production migration.')}</p><div className="prefs-actions"><a className="prefs-text-link" href="/#/design-system" target="_blank" rel="noreferrer">{l('Open component gallery')} ↗</a></div></SettingGroup>
    <p className="prefs-caption">{l('Created by')} Vexor</p>
  </>
}
export function ExtraSettings({ category }: { category: Category }) {
  if (category === 'data') return <BackupSettings />
  if (category === 'connections') return <ConnectionSettings />
  if (category === 'database') return <DatabaseSettings />
  if (category === 'shortcuts') return <ShortcutsSettings />
  return <AboutSettings />
}
export function SettingsContext({ category }: { category: Category }) {
  const l = useLabels()
  const content: Record<string, { icon: string; title: string; text: string; items: string[] }> = {
    data: { icon: 'download', title: 'A copy you can keep', text: 'A good backup is easy to create and clear about what it restores.', items: ['Export a preview preferences file', 'Review before restoring', 'Keep full vault backups outside the vault'] },
    connections: { icon: 'shield', title: 'Access starts with permission', text: 'The desktop bridge shares only what you allow, while Nevis is open.', items: ['Read-only by default', 'Choose the document scope', 'Disconnect when switching vaults'] },
    database: { icon: 'table', title: 'Local by default', text: 'Your database works on your device. Maps and gateway services are optional.', items: ['Calendar defaults', 'Your own map provider', 'Explicit gateway configuration'] },
    shortcuts: { icon: 'keyboard', title: 'Keep your hands on the keys', text: 'Search the complete shortcut list. Change supported app bindings with conflict checks.', items: ['Physical keys support Persian layouts', 'Escape cancels recording', 'Restore defaults per shortcut'] },
    about: { icon: 'leaf', title: 'Built around your ideas', text: 'One visual language across notes, databases and the tools you use every day.', items: ['Local-first workspace', 'English and Persian', 'Shared, reusable foundations'] },
  }
  const c = content[category]
  return <aside className="prefs-preview prefs-context"><span className="prefs-context-icon"><Icon name={c.icon} size={24} /></span><h3>{l(c.title)}</h3><p>{l(c.text)}</p><ul>{c.items.map(item => <li key={item}><Icon name="check" />{l(item)}</li>)}</ul><small>{l('Design preview · separate from your main workspace')}</small></aside>
}
