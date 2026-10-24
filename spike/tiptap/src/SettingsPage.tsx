import { useState, type ReactNode } from 'react'
import { ACCENTS, DEFAULTS, FONTS, PRESETS, TEXT_COLORS, updateSettings, useSettings, type FontId, type SidebarStyle, type Theme } from './settings'
import { pickFiles } from './io'
import { putFile } from './attachments'
import * as Ic from './icons'
import { t } from './i18n'
import { Select } from './ui'

type Tab = 'appearance' | 'editor' | 'language'
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', icon: <Ic.Palette /> },
  { id: 'editor', label: 'Editor & font', icon: <Ic.Type /> },
  { id: 'language', label: 'Language', icon: <Ic.Globe /> },
]

const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

const SIDEBAR_STYLES: { id: SidebarStyle; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'compact', label: 'Compact' },
  { id: 'icons', label: 'Icons only' },
]

const Toggle = ({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) => (
  <div className="toggle-row">
    <span className="toggle-tx">
      <b>{label}</b>
      {hint && <small>{hint}</small>}
    </span>
    <button role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} />
  </div>
)

const Group = ({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) => (
  <section className="set-group">
    <h3>{title}</h3>
    {hint && <p>{hint}</p>}
    {children}
  </section>
)

/** Miniature of the app drawn with the live tokens, so every setting shows up here at once. */
function Preview() {
  return (
    <div className="pv" aria-hidden>
      <div className="pv-side">
        <i className="pv-logo" />
        <i className="pv-row cur" />
        <i className="pv-row" />
        <i className="pv-row" />
      </div>
      <div className="pv-main">
        <i className="pv-title" />
        <i className="pv-line" />
        <i className="pv-line short" />
        <i className="pv-btn" />
      </div>
    </div>
  )
}

function Appearance() {
  const s = useSettings()
  const custom = !!s.accent && !ACCENTS.includes(s.accent)
  const bgKey = s.bg.kind === 'preset' ? s.bg.id : s.bg.kind
  return (
    <>
      <Group title={t('Theme')}>
        <div className="theme-cards">
          {THEMES.map((th) => (
            <button key={th.id} className={'theme-card' + (s.theme === th.id ? ' on' : '')} onClick={() => updateSettings({ theme: th.id })}>
              <span className={'theme-prev tp-' + th.id}>
                <i /><i /><i />
              </span>
              {t(th.label)}
            </button>
          ))}
        </div>
      </Group>

      <Group title={t('Accent color')}>
        <div className="swatches">
          <button className={'swatch default' + (!s.accent ? ' on' : '')} title={t('Default')} onClick={() => updateSettings({ accent: null })}>
            <Ic.Check size={14} />
          </button>
          {ACCENTS.map((c) => (
            <button key={c} className={'swatch' + (s.accent === c ? ' on' : '')} style={{ background: c }} title={c} onClick={() => updateSettings({ accent: c })}>
              <Ic.Check size={14} />
            </button>
          ))}
          <label className={'swatch custom' + (custom ? ' on' : '')} title={t('Custom color')} style={custom ? { background: s.accent! } : undefined}>
            {custom ? <Ic.Check size={14} /> : <Ic.Plus size={14} />}
            <input type="color" value={s.accent ?? '#6857f0'} onChange={(e) => updateSettings({ accent: e.target.value })} />
          </label>
        </div>
      </Group>

      <Group title={t('Background')} hint={t('Shows behind the sidebar and around the app.')}>
        <div className="bg-grid">
          <button className={'bg-tile' + (bgKey === 'default' ? ' on' : '')} onClick={() => updateSettings({ bg: { kind: 'default' } })}>
            <span className="bg-prev bp-default" />{t('Default')}
          </button>
          <button className={'bg-tile' + (bgKey === 'none' ? ' on' : '')} onClick={() => updateSettings({ bg: { kind: 'none' } })}>
            <span className="bg-prev bp-none" />{t('Plain')}
          </button>
          {PRESETS.map((p) => (
            <button key={p.id} className={'bg-tile' + (bgKey === p.id ? ' on' : '')} onClick={() => updateSettings({ bg: { kind: 'preset', id: p.id } })}>
              <span className="bg-prev" style={{ ['--c1' as string]: p.dark[0], ['--c2' as string]: p.dark[1], ['--l1' as string]: p.light[0], ['--l2' as string]: p.light[1] }} />
              {t(p.label)}
            </button>
          ))}
          <button
            className={'bg-tile' + (bgKey === 'image' ? ' on' : '')}
            onClick={async () => {
              const [f] = await pickFiles('image/*')
              if (f) updateSettings({ bg: { kind: 'image', file: await putFile(f) } })
            }}
          >
            <span className="bg-prev bp-add"><Ic.Image size={20} /></span>{t('My image')}
          </button>
        </div>
      </Group>

      <Group title={t('Sidebar style')}>
        <div className="segmented">
          {SIDEBAR_STYLES.map((o) => (
            <button key={o.id} className={s.sidebar === o.id ? 'on' : ''} onClick={() => updateSettings({ sidebar: o.id })}>{t(o.label)}</button>
          ))}
        </div>
      </Group>

      <Group title={t('Corner radius')}>
        <div className="range-row">
          <input type="range" min={4} max={20} step={1} value={s.radius} onChange={(e) => updateSettings({ radius: +e.target.value })} />
          <output>{s.radius}px</output>
        </div>
      </Group>

      <div className="toggle-list">
        <Toggle label={t('Glass effect')} hint={t('Floating, blurred sidebar over the background')} on={s.glass} onChange={(glass) => updateSettings({ glass })} />
        <Toggle label={t('Show cover image')} on={s.showCovers} onChange={(showCovers) => updateSettings({ showCovers })} />
        <Toggle label={t('Show page icons')} on={s.showIcons} onChange={(showIcons) => updateSettings({ showIcons })} />
      </div>
    </>
  )
}

function Editor() {
  const s = useSettings()
  return (
    <>
      <Group title={t('Text size')}>
        <div className="range-row">
          <input type="range" min={13} max={22} step={1} value={s.fontSize} onChange={(e) => updateSettings({ fontSize: +e.target.value })} />
          <output>{s.fontSize}px</output>
        </div>
      </Group>

      <Group title={t('Text color')}>
        <div className="swatches">
          <button className={'swatch default' + (!s.textColor ? ' on' : '')} title={t('Default')} onClick={() => updateSettings({ textColor: null })}>
            <Ic.Check size={14} />
          </button>
          {TEXT_COLORS.map((c) => (
            <button key={c} className={'swatch' + (s.textColor === c ? ' on' : '')} style={{ background: c }} title={c} onClick={() => updateSettings({ textColor: c })}>
              <Ic.Check size={14} />
            </button>
          ))}
          <label className={'swatch custom' + (s.textColor && !TEXT_COLORS.includes(s.textColor) ? ' on' : '')} title={t('Custom color')} style={s.textColor && !TEXT_COLORS.includes(s.textColor) ? { background: s.textColor } : undefined}>
            {s.textColor && !TEXT_COLORS.includes(s.textColor) ? <Ic.Check size={14} /> : <Ic.Plus size={14} />}
            <input type="color" value={s.textColor ?? '#888888'} onChange={(e) => updateSettings({ textColor: e.target.value })} />
          </label>
        </div>
      </Group>

      <div className="font-preview tiptap-like">
        <h4>{t('Preview')}</h4>
        <p>متغیر <code>count</code> را تعریف کنید و مقدار ۱۰ بدهید. This is an English sentence in the middle.</p>
      </div>
    </>
  )
}

function LanguageTab() {
  const s = useSettings()
  return (
    <>
      <Group title={t('Interface language')} hint={t('Changes the language of menus, buttons and messages. Your page content is never translated.')}>
        <div className="segmented">
          <button className={s.lang === 'en' ? 'on' : ''} onClick={() => updateSettings({ lang: 'en' })}>English</button>
          <button className={s.lang === 'fa' ? 'on' : ''} onClick={() => updateSettings({ lang: 'fa' })} lang="fa">فارسی</button>
        </div>
      </Group>
      <Group title={t('Layout direction')} hint={t('Where the sidebar, lists and panels sit. “Auto” follows the language.')}>
        <div className="segmented">
          {([['auto', 'Auto'], ['ltr', 'Left to right'], ['rtl', 'Right to left']] as const).map(([id, label]) => (
            <button key={id} className={s.dir === id ? 'on' : ''} onClick={() => updateSettings({ dir: id })}>{t(label)}</button>
          ))}
        </div>
      </Group>
    </>
  )
}

export function SettingsView() {
  const [tab, setTab] = useState<Tab>('appearance')
  const s = useSettings()
  return (
    <div className="settings">
      <header className="set-head">
        <div>
          <h2>{t('Settings')}</h2>
          <p>{t('Make the appearance and editor your own.')}</p>
        </div>
        <button className="ghost-btn" onClick={() => updateSettings({ ...DEFAULTS, lang: s.lang, dir: s.dir })}>{t('Reset all')}</button>
      </header>
      <div className="set-body">
        <nav className="set-tabs">
          {TABS.map((th) => (
            <button key={th.id} className={tab === th.id ? 'on' : ''} onClick={() => setTab(th.id)}>
              {th.icon}
              {t(th.label)}
            </button>
          ))}
        </nav>
        <div className="set-card">
          <header className="set-card-head">
            <h3>{tab === 'appearance' ? t('Appearance') : tab === 'editor' ? t('Editor') : t('Language & layout')}</h3>
            <p>{tab === 'appearance' ? t('Customize how the app looks and feels.') : tab === 'editor' ? t('Set the size and color of page text.') : t('Choose the interface language and which side things sit on.')}</p>
          </header>
          {tab === 'appearance' ? <Appearance /> : tab === 'editor' ? <Editor /> : <LanguageTab />}
        </div>
        <aside className="set-side">
          <h3>{t('Preview')}</h3>
          <Preview />
          <label className="field">
            <span>{t('Font')}</span>
            <Select value={s.font} onChange={(v) => updateSettings({ font: v as FontId })} options={FONTS.map((f) => ({ value: f.id, label: t(f.label) }))} />
          </label>
          <Toggle label={t('Reduce motion')} hint={t('Minimizes animations.')} on={s.reduceMotion} onChange={(reduceMotion) => updateSettings({ reduceMotion })} />
        </aside>
      </div>
    </div>
  )
}
