import { useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PanelHost } from '../shell/panelHost'
import { formatSize } from '@nevis/editor'
import { download } from '../download'
import { isDesktop } from '../desktop'
import { mirrorFolder, setMirrorFolder } from '../mirror'
import { me, type Me } from '../auth'
import { Button, Icon, PreferenceGroup, PreferenceRow, RangeControl, SaveStatus, SegmentedChoice } from '../ds'
import { setDeviceSettings, useDeviceSettings } from '../deviceSettings'
import { t } from '../i18n'
import { readSynced, writeSynced } from '../workspaceSettings'
import type { Workspace } from '../workspace'

type Tab = 'appearance' | 'data' | 'sync' | 'shortcuts' | 'about'
const TABS: { id: Tab; label: string; title: string; hint: string; icon: string }[] = [
  { id: 'appearance', label: 'Appearance', title: 'Appearance', hint: 'Colors, background, glass and the shape of the app.', icon: 'palette' },
  { id: 'data', label: 'Data & backup', title: 'Data & backup', hint: 'Import, export and back up your notes.', icon: 'file-archive' },
  { id: 'sync', label: 'Sync', title: 'Sync', hint: 'Keep your workspaces the same on all your devices.', icon: 'cloud' },
  { id: 'shortcuts', label: 'Shortcuts', title: 'Keyboard shortcuts', hint: 'Everything you can do without leaving the keyboard.', icon: 'keyboard' },
  { id: 'about', label: 'About', title: 'About', hint: 'What this app is.', icon: 'info' },
]
const SHORTCUTS: [string, string][] = [['جست‌وجو و دستورها', 'Ctrl/⌘ + K'], ['صفحهٔ تازه', 'Alt + N'], ['خانه', 'Alt + H'], ['پررنگ / کج / زیرخط', 'Ctrl/⌘ + B / I / U'], ['منوی بلوک‌ها', '/'], ['پیوند به صفحه', '[['], ['جست‌وجو در صفحه', 'Ctrl/⌘ + F'], ['راست‌به‌چپ / چپ‌به‌راست', 'Ctrl/⌘ + Shift + ← / →']]

/** Two kinds of setting, kept apart on purpose: this device only (never synced) and the workspace's (one op each, on every device). */
export function Settings({ ws }: { ws: Workspace }) {
  const device = useDeviceSettings()
  const synced = readSynced(ws)
  const [account, setAccount] = useState<Me | null>(null)
  useEffect(() => { let dead = false; void me().then(m => { if (!dead) setAccount(m) }, () => undefined); return () => { dead = true } }, [])
  const files = ws.rt.blobStatus()
  const host = useContext(PanelHost)
  const [tab, setTab] = useState<Tab>('appearance')
  const current = TABS.find(x => x.id === tab)!
  const navigation = (
    <nav className="prefs-categories" aria-label={t('Settings')}>
      {TABS.map(x => <Button key={x.id} className="prefs-nav-button" variant="ghost" data-testid={`settings-tab-${x.id}`} aria-current={tab === x.id ? 'page' : undefined} icon={<Icon name={x.icon} size={16} />} onClick={() => setTab(x.id)}><span>{t(x.label)}</span></Button>)}
    </nav>
  )
  const panels: Record<Tab, ReactNode> = {
    appearance: <><div data-testid="settings-device">
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
        </PreferenceGroup>
      </div>
      </>,
    data: <><div data-testid="settings-data">
        <PreferenceGroup title="دادهٔ شما">
          <PreferenceRow label="همهٔ یادداشت‌ها، بدون اتلاف (باندل)"><button className="ds-btn ds-btn--sm" data-testid="export-bundle" onClick={() => void ws.exportBundle().then(b => download(b, 'nevis.nevis.zip'))}>دانلود باندل</button></PreferenceRow>
          <PreferenceRow label="فایل‌های Markdown (خوانا برای ابزارهای دیگر)"><button className="ds-btn ds-btn--sm" data-testid="export-markdown" onClick={() => void ws.exportMarkdown().then(b => download(b, 'nevis-markdown.zip'))}>دانلود Markdown</button></PreferenceRow>
          {isDesktop && (
            <PreferenceRow label="آینهٔ Markdown (یک‌طرفه: برنامه می‌نویسد، هرگز نمی‌خواند؛ ویرایش فایل‌ها بازنویسی می‌شود)">
              <input data-testid="mirror-dir" dir="ltr" defaultValue={mirrorFolder(ws.ws)} placeholder="/Users/you/Notes" aria-label="پوشهٔ آینه"
                onBlur={e => { setMirrorFolder(ws.ws, e.target.value.trim()); ws.startMirror(e.target.value.trim()) }} />
            </PreferenceRow>
          )}
        </PreferenceGroup>
      </div>
      {account && (
        <div data-testid="settings-storage">
          <PreferenceGroup title="فضای ذخیره‌سازی حساب">
            <PreferenceRow label="فضای مصرف‌شده (متن و فایل‌ها)">
              <span data-testid="quota-used">{formatSize(account.usedBytes)}{account.quotaBytes > 0 ? ` از ${formatSize(account.quotaBytes)}` : ''}</span>
              {account.quotaBytes > 0 && <progress max={account.quotaBytes} value={account.usedBytes} aria-label="فضای مصرف‌شده" />}
            </PreferenceRow>
            {files.pending > 0 && <PreferenceRow label="فایل‌های منتظر آپلود"><span data-testid="quota-pending">{files.pending}</span></PreferenceRow>}
          </PreferenceGroup>
        </div>
      )}
      </>,
    sync: <><PreferenceGroup title={t('Sync')}><PreferenceRow label="وضعیت"><span data-testid="settings-sync">{ws.rt.lastError || (ws.rt.lastSyncAt ? 'همگام' : 'در حال اتصال')}</span></PreferenceRow></PreferenceGroup></>,
    shortcuts: <><PreferenceGroup title={t('Keyboard shortcuts')}>
        <dl className="shortcuts">{SHORTCUTS.map(([what, keys]) => <div key={what}><dt>{what}</dt><dd dir="ltr">{keys}</dd></div>)}</dl>
      </PreferenceGroup>
</>,
    about: <PreferenceGroup title={t('About')}><PreferenceRow label="نِویس"><span>یادداشت‌های آفلاین‌محور با همگام‌سازی روی سرور خودتان</span></PreferenceRow></PreferenceGroup>,
  }
  return (
    <div className="prefs-shell prefs-embedded" data-testid="settings" dir="rtl">
      {host && createPortal(navigation, host)}
      <div className="prefs-main">
        <header className="prefs-top"><span>{t('Workspace')}<span>/</span>{t('Settings')}</span><SaveStatus state="saved" label={t('Saved locally')} /></header>
        <div className="prefs-content">
          <div className="prefs-title"><div><span className="prefs-eyebrow">{t('Make yourself at home')}</span><h1>{t('Settings')}</h1><p>{t('Thoughtful defaults. A few personal touches.')}</p></div></div>
          <div className="prefs-columns">
            <div className="prefs-panel" key={tab}>
              {panels[tab]}
              <footer className="prefs-panel-footer"><span>{t('Changes save automatically.')}</span></footer>
            </div>
            <aside className="prefs-preview prefs-context"><h3>{t(current.title)}</h3><p>{t(current.hint)}</p></aside>
          </div>
        </div>
      </div>
    </div>
  )
}
