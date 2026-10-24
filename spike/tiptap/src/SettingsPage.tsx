import { useState, type ReactNode } from 'react'
import { confirmDialog } from './dialog'
import { ACCENTS, DEFAULTS, FONTS, PRESETS, TEXT_COLORS, updateSettings, useSettings, type FontId, type SidebarStyle, type Theme } from './settings'
import { pickFiles } from './io'
import { putFile } from './attachments'
import * as Ic from './icons'
import { t } from './i18n'
import { Select } from './ui'
import { SHORTCUTS, keyLabel } from './shortcuts'

type Tab = 'appearance' | 'editor' | 'general' | 'shortcuts' | 'language'
const TABS: { id: Tab; label: string; title: string; hint: string; icon: ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', title: 'Appearance', hint: 'Customize how the app looks and feels.', icon: <Ic.Palette /> },
  { id: 'editor', label: 'Editor & font', title: 'Editor', hint: 'Set the font, size and color of page text.', icon: <Ic.Type /> },
  { id: 'general', label: 'General', title: 'General', hint: 'Reminders and how files are stored.', icon: <Ic.Settings /> },
  { id: 'shortcuts', label: 'Shortcuts', title: 'Keyboard shortcuts', hint: 'Everything you can do without leaving the keyboard.', icon: <Ic.Keyboard /> },
  { id: 'language', label: 'Language', title: 'Language & layout', hint: 'Choose the interface language and which side things sit on.', icon: <Ic.Globe /> },
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
        <Toggle label={t('Reduce motion')} hint={t('Minimizes animations.')} on={s.reduceMotion} onChange={(reduceMotion) => updateSettings({ reduceMotion })} />
      </div>
    </>
  )
}

function Editor() {
  const s = useSettings()
  return (
    <>
      <Group title={t('Font')}>
        <Select value={s.font} onChange={(v) => updateSettings({ font: v as FontId })} options={FONTS.map((f) => ({ value: f.id, label: t(f.label) }))} />
      </Group>

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

function General() {
  const s = useSettings()
  return (
    <div className="toggle-list first">
      <Toggle label={t('Flashcard reminders')} hint={t('Notifies you when cards are due and the app is in the background.')} on={s.cardReminders} onChange={(cardReminders) => updateSettings({ cardReminders })} />
      <Toggle label={t('Compress large images')} hint={t('Shrinks big pictures when you add them, so the vault and sync stay light.')} on={s.compressImages} onChange={(compressImages) => updateSettings({ compressImages })} />
    </div>
  )
}

function Shortcuts() {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const groups = SHORTCUTS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !needle || i.label.toLowerCase().includes(needle) || t(i.label).toLowerCase().includes(needle) || i.keys.some((k) => k.map(keyLabel).join('+').toLowerCase().includes(needle))),
  })).filter((g) => g.items.length)
  return (
    <>
      <div className="sc-search">
        <Ic.Search size={15} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search shortcuts…')} aria-label={t('Search shortcuts…')} />
      </div>
      {groups.map((g) => (
        <Group key={g.title} title={t(g.title)}>
          <ul className="sc-list">
            {g.items.map((i) => (
              <li key={i.label}>
                <span>{t(i.label)}</span>
                <span className="sc-keys">
                  {i.keys.map((chord, n) => (
                    <span key={n} className="sc-chord">
                      {n > 0 && <em>{t('or')}</em>}
                      {chord.map((k, j) => <kbd key={j}>{keyLabel(k)}</kbd>)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Group>
      ))}
      {!groups.length && <p className="sc-none">{t('No shortcut matches.')}</p>}
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
  const cur = TABS.find((x) => x.id === tab)!
  const reset = async () => {
    if (await confirmDialog({ title: t('Reset all settings'), message: t('Reset all settings to their defaults? Language and direction stay as they are.'), confirmLabel: t('Reset'), danger: true })) updateSettings({ ...DEFAULTS, lang: s.lang, dir: s.dir })
  }
  return (
    <div className="settings">
      <header className="set-head">
        <div>
          <h2>{t('Settings')}</h2>
          <p>{t('Make the appearance and editor your own.')}</p>
        </div>
        <button className="ghost-btn" onClick={reset}>{t('Reset all')}</button>
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
            <h3>{t(cur.title)}</h3>
            <p>{t(cur.hint)}</p>
          </header>
          {tab === 'appearance' ? <Appearance /> : tab === 'editor' ? <Editor /> : tab === 'general' ? <General /> : tab === 'shortcuts' ? <Shortcuts /> : <LanguageTab />}
        </div>
        {(tab === 'appearance' || tab === 'editor') && (
          <aside className="set-side">
            <h3>{t('Preview')}</h3>
            <Preview />
          </aside>
        )}
      </div>
    </div>
  )
}
