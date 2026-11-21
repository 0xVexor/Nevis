import { PreferenceGroup, PreferenceRow, RangeControl, SegmentedChoice } from '../ds'
import { setDeviceSettings, useDeviceSettings } from '../deviceSettings'
import { t } from '../i18n'
import { readSynced, writeSynced } from '../workspaceSettings'
import type { Workspace } from '../workspace'

const SHORTCUTS: [string, string][] = [['جست‌وجو و دستورها', 'Ctrl/⌘ + K'], ['صفحهٔ تازه', 'Alt + N'], ['خانه', 'Alt + H'], ['پررنگ / کج / زیرخط', 'Ctrl/⌘ + B / I / U'], ['منوی بلوک‌ها', '/'], ['پیوند به صفحه', '[['], ['جست‌وجو در صفحه', 'Ctrl/⌘ + F'], ['راست‌به‌چپ / چپ‌به‌راست', 'Ctrl/⌘ + Shift + ← / →']]

/** Two kinds of setting, kept apart on purpose: this device only (never synced) and the workspace's (one op each, on every device). */
export function Settings({ ws }: { ws: Workspace }) {
  const device = useDeviceSettings()
  const synced = readSynced(ws)
  return (
    <section className="screen" data-testid="settings" dir="rtl">
      <h1>{t('Settings')}</h1>
      <div data-testid="settings-device">
        <PreferenceGroup title={t('This device')}>
          <PreferenceRow label={t('Theme')}>
            <SegmentedChoice label={t('Theme')} value={device.theme} items={[{ value: 'system', label: t('System') }, { value: 'light', label: t('Light') }, { value: 'dark', label: t('Dark') }]} onChange={v => setDeviceSettings({ theme: v })} />
          </PreferenceRow>
          <PreferenceRow label={t('Text size')}><RangeControl label={t('Text size')} value={device.textScale} min={80} max={150} step={5} unit="%" onChange={v => setDeviceSettings({ textScale: v })} /></PreferenceRow>
          <PreferenceRow label={t('Sidebar width')}><RangeControl label={t('Sidebar width')} value={device.sidebarWidth} min={200} max={420} step={4} onChange={v => setDeviceSettings({ sidebarWidth: v })} /></PreferenceRow>
          <PreferenceRow label={t('Accent colour')}>
            <input type="color" aria-label={t('Accent colour')} value={device.accent || '#087f74'} onChange={e => setDeviceSettings({ accent: e.target.value })} />
          </PreferenceRow>
        </PreferenceGroup>
      </div>
      <div data-testid="settings-synced">
        <PreferenceGroup title={t('Synced settings')}>
          <PreferenceRow label={t('Calendar')}>
            <SegmentedChoice label={t('Calendar')} value={synced.calendar} items={[{ value: 'jalali', label: t('Jalali') }, { value: 'gregorian', label: t('Gregorian') }]} onChange={v => void writeSynced(ws, 'calendar', v)} />
          </PreferenceRow>
          <PreferenceRow label={t('First day of the week')}>
            <SegmentedChoice label={t('First day of the week')} value={synced.weekStart} items={[{ value: 'sat', label: t('Saturday') }, { value: 'sun', label: t('Sunday') }, { value: 'mon', label: t('Monday') }]} onChange={v => void writeSynced(ws, 'weekStart', v)} />
          </PreferenceRow>
        </PreferenceGroup>
      </div>
      <PreferenceGroup title={t('Keyboard shortcuts')}>
        <dl className="shortcuts">{SHORTCUTS.map(([what, keys]) => <div key={what}><dt>{what}</dt><dd dir="ltr">{keys}</dd></div>)}</dl>
      </PreferenceGroup>
    </section>
  )
}
