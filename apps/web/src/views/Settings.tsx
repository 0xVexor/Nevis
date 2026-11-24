// Settings: the old app's workspace (categories in the side panel, a panel per category, a live preview), with this app's own data behind it.
// Two kinds of setting stay apart on purpose: this device only (never synced) and the workspace's (one op each, on every device).
import { useContext, useEffect, useState } from 'react'
import { formatSize } from '@nevis/editor'
import { download } from '../download'
import { isDesktop } from '../desktop'
import { mirrorFolder, setMirrorFolder } from '../mirror'
import { me, type Me } from '../auth'
import { PreferenceGroup, PreferenceRow, SegmentedChoice } from '../ds'
import { DEFAULTS, getSettings, updateSettings } from '../deviceSettings'
import { t } from '../i18n'
import { readSynced, writeSynced } from '../workspaceSettings'
import { About, EditorExtras } from '../settings/SettingsSections'
import { Appearance, EditorSettings, GeneralSettings, LanguageSettings, SettingsWorkspace } from '../settings/SettingsWorkspace'
import { ShortcutsSettings } from '../settings/ShortcutsSettings'
import { SETTINGS_TABS, type SettingsTab } from '../settings/settingsTabs'
import { PanelHost } from '../shell/panelHost'
import type { Workspace } from '../workspace'

export function Settings({ ws, initialTab, onTabChange, onLeave, onWorkspaces }: { ws: Workspace; initialTab?: string; onTabChange?: (tab: SettingsTab) => void; onLeave?: () => void; onWorkspaces?: () => void }) {
  const synced = readSynced(ws)
  const [account, setAccount] = useState<Me | null>(null)
  useEffect(() => { let dead = false; void me().then(m => { if (!dead) setAccount(m) }, () => undefined); return () => { dead = true } }, [])
  const files = ws.rt.blobStatus()
  const host = useContext(PanelHost)
  const reset = () => { if (confirm(t('Reset all settings to their defaults? Language and direction stay as they are.'))) { const c = getSettings(); updateSettings({ ...DEFAULTS, lang: c.lang, dir: c.dir }) } }
  const saveExport = async (kind: 'bundle' | 'markdown') => {
    try {
      const bytes = await (kind === 'bundle' ? ws.exportBundle() : ws.exportMarkdown())
      download(bytes, kind === 'bundle' ? 'nevis.nevis.zip' : 'nevis-markdown.zip')
    } catch { ws.notify(t('Could not complete the action. Please try again.')) }
  }
  return (
    <div data-testid="settings">
      <SettingsWorkspace
        embedded panelHost={host} onLeave={onLeave} activeCategory={SETTINGS_TABS.find(tab => tab.id === initialTab)?.id ?? 'appearance'} onCategoryChange={onTabChange} onReset={reset} editorExtras={<EditorExtras />}
        panels={{
          appearance: <div data-testid="settings-device"><Appearance /></div>,
          editor: <><EditorSettings /><EditorExtras /></>,
          language: <LanguageSettings />,
          general: <GeneralSettings />,
          database: (
            <div data-testid="settings-synced">
              <PreferenceGroup title={t('Synced settings')}>
                <PreferenceRow label={t('Calendar')}>
                  <SegmentedChoice label={t('Calendar')} value={synced.calendar} items={[{ value: 'jalali', label: t('Jalali') }, { value: 'gregorian', label: t('Gregorian') }]} onChange={v => void writeSynced(ws, 'calendar', v)} />
                </PreferenceRow>
              </PreferenceGroup>
            </div>
          ),
          data: (
            <>
              <div data-testid="settings-data">
                <PreferenceGroup title={t('Your data')}>
                  {onWorkspaces && <PreferenceRow label={t('Choose Import notes from the workspace list.')}><button type="button" className="ds-btn ds-btn--sm" onClick={onWorkspaces}>{t('Workspaces')}</button></PreferenceRow>}
                  <PreferenceRow label={t('All notes, lossless (bundle)')}><button type="button" className="ds-btn ds-btn--sm" data-testid="export-bundle" onClick={() => void saveExport('bundle')}>{t('Download bundle')}</button></PreferenceRow>
                  <PreferenceRow label={t('Markdown files (readable by other tools)')}><button type="button" className="ds-btn ds-btn--sm" data-testid="export-markdown" onClick={() => void saveExport('markdown')}>{t('Download Markdown')}</button></PreferenceRow>
                  {isDesktop && (
                    <PreferenceRow label={t('Markdown mirror (one-way: the app writes and never reads; edits to the files are overwritten)')}>
                      <input data-testid="mirror-dir" dir="ltr" defaultValue={mirrorFolder(ws.ws)} placeholder="/Users/you/Notes" aria-label={t('Mirror folder')}
                        onBlur={e => { setMirrorFolder(ws.ws, e.target.value.trim()); ws.startMirror(e.target.value.trim()) }} />
                    </PreferenceRow>
                  )}
                </PreferenceGroup>
              </div>
              {account && (
                <div data-testid="settings-storage">
                  <PreferenceGroup title={t('Account storage')}>
                    <PreferenceRow label={t('Space used (text and files)')}>
                      <span data-testid="quota-used">{formatSize(account.usedBytes)}{account.quotaBytes > 0 ? ` ${t('of')} ${formatSize(account.quotaBytes)}` : ''}</span>
                      {account.quotaBytes > 0 && <progress max={account.quotaBytes} value={account.usedBytes} aria-label={t('Space used')} />}
                    </PreferenceRow>
                    {files.pending > 0 && <PreferenceRow label={t('Files waiting to upload')}><span data-testid="quota-pending">{files.pending}</span></PreferenceRow>}
                  </PreferenceGroup>
                </div>
              )}
            </>
          ),
          sync: <PreferenceGroup title={t('Sync')}><PreferenceRow label={t('Status')}><span data-testid="settings-sync">{ws.rt.lastError || (ws.rt.lastSyncAt ? t('Synced') : t('Connecting'))}</span></PreferenceRow><PreferenceRow label={t('Sync')}><button type="button" className="ds-btn ds-btn--sm" onClick={() => ws.rt.retry()}>{t('Sync now')}</button></PreferenceRow></PreferenceGroup>,
          shortcuts: <ShortcutsSettings />,
          about: <About />,
        }}
        context={category => { const section = SETTINGS_TABS.find(tab => tab.id === category); return section ? <aside className="prefs-preview prefs-context"><h3>{t(section.title)}</h3><p>{t(section.hint)}</p></aside> : null }}
      />
    </div>
  )
}
