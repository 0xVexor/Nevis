import { lazy, Suspense } from 'react'
import { McpConnectionSettings } from './mcp/ConnectionSettings'
import { DataTab, type DataApi } from './DataTab'
import { confirmDialog } from './dialog'
import { DEFAULTS, getSettings, updateSettings } from './settings'
import { t } from './i18n'
import { SettingsWorkspace } from './settings-ui/SettingsWorkspace'
import { About, EditorExtras } from './settings-ui/SettingsSections'
import { ShortcutsSettings } from './settings-ui/ShortcutsSettings'
import { SETTINGS_TABS, type SettingsTab } from './settings-ui/settingsTabs'
const DatabaseSettings = lazy(() => import('./database/ui/DatabaseSettings').then(module => ({ default: module.DatabaseSettings })))
export { SETTINGS_TABS, type SettingsTab }
/** Production adapter: approved presentation, existing vault/platform behavior. No preview services. */
export function SettingsView({ data, initialTab, onLeave, panelHost }: { data: DataApi; initialTab?: SettingsTab; onLeave?: () => void; panelHost: HTMLElement | null }) {
  const reset = async () => {
    if (await confirmDialog({ title: t('Reset all settings'), message: t('Reset all settings to their defaults? Language and direction stay as they are.'), confirmLabel: t('Reset'), danger: true })) {
      const current = getSettings()
      updateSettings({ ...DEFAULTS, lang: current.lang, dir: current.dir })
    }
  }
  return <SettingsWorkspace embedded panelHost={panelHost} onLeave={onLeave} initialCategory={initialTab} onReset={() => void reset()}
    editorExtras={<EditorExtras />}
    panels={{ data: <DataTab api={data} />, connections: <McpConnectionSettings />,
      database: <Suspense fallback={<p role="status">{t('Loading…')}</p>}><DatabaseSettings /></Suspense>, shortcuts: <ShortcutsSettings />, about: <About /> }}
    context={category => { const section = SETTINGS_TABS.find(tab => tab.id === category)!
      return <aside className="prefs-preview prefs-context"><h3>{t(section.title)}</h3><p>{t(section.hint)}</p></aside>
    }} />
}
