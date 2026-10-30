import { Brand } from './Brand'
import { UpdateSettings } from './UpdateUI'
import appPackage from '../package.json'
import { Suspense, lazy, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
const DatabaseSettings = lazy(() => import('./database/ui/DatabaseSettings').then((m) => ({ default: m.DatabaseSettings })))
import { confirmDialog } from './dialog'
import { ACCENTS, DEFAULTS, FONTS, PRESETS, TEXT_COLORS, loadFont, updateSettings, useSettings, type FontGroup, type FontId, type SidebarStyle, type Theme } from './settings'
import { pickFiles } from './io'
import { putFile } from './attachments'
import * as Ic from './icons'
import { t } from './i18n'
import { SHORTCUTS, keyLabel, shortcutKeys } from './shortcuts'

type Tab = 'appearance' | 'editor' | 'language' | 'general' | 'data' | 'database' | 'shortcuts' | 'about'
const TABS: { id: Tab; label: string; title: string; hint: string; icon: ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', title: 'Appearance', hint: 'Colors, background, glass and the shape of the app.', icon: <Ic.Palette /> },
  { id: 'editor', label: 'Editor & font', title: 'Editor & font', hint: 'The typeface, size and color of your page text.', icon: <Ic.Type /> },
  { id: 'language', label: 'Language', title: 'Language & layout', hint: 'The interface language and which side things sit on.', icon: <Ic.Globe /> },
  { id: 'general', label: 'General', title: 'General', hint: 'Reminders and how files are stored.', icon: <Ic.Settings /> },
  { id: 'data', label: 'Data & backup', title: 'Data & backup', hint: 'Import, export and back up your notes.', icon: <Ic.Archive /> },
  { id: 'database', label: 'Database', title: 'Database', hint: 'Calendar defaults, maps and connected services.', icon: <Ic.Table /> },
  { id: 'shortcuts', label: 'Shortcuts', title: 'Keyboard shortcuts', hint: 'Everything you can do without leaving the keyboard.', icon: <Ic.Keyboard /> },
  { id: 'about', label: 'About', title: 'About', hint: 'What this app is.', icon: <Ic.Info /> },
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

// ───── building blocks: a card holds rows; a row is "label + hint" on one side and its control on the other ─────

const Card = ({ icon, title, hint, children }: { icon?: ReactNode; title: ReactNode; hint?: string; children: ReactNode }) => (
  <section className="sx-card">
    <header className="sx-card-head">
      {icon && <span className="sx-ic">{icon}</span>}
      <div>
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
      </div>
    </header>
    <div className="sx-card-body">{children}</div>
  </section>
)

/** `wide` rows put the control under the text (swatches, grids); the others keep it beside it. */
const Row = ({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) => (
  <div className={'sx-row' + (wide ? ' wide' : '')}>
    <div className="sx-tx">
      <b>{label}</b>
      {hint && <small>{hint}</small>}
    </div>
    <div className="sx-ctl">{children}</div>
  </div>
)

const Switch = ({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) => (
  <button role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} />
)

const Toggle = ({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) => (
  <Row label={label} hint={hint}>
    <Switch label={label} on={on} onChange={onChange} />
  </Row>
)

const Range = ({ label, value, min, max, step = 1, unit = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) => (
  <div className="sx-range">
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value} style={{ ['--p' as string]: ((value - min) / (max - min)) * 100 + '%' } as CSSProperties} onChange={(e) => onChange(+e.target.value)} />
    <output>
      {value}
      {unit}
    </output>
  </div>
)

const Segmented = <V extends string>({ value, options, onChange }: { value: V; options: { id: V; label: string; lang?: string }[]; onChange: (v: V) => void }) => (
  <div className="segmented" role="radiogroup">
    {options.map((o) => (
      <button key={o.id} role="radio" aria-checked={value === o.id} lang={o.lang} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
        {o.label}
      </button>
    ))}
  </div>
)

const Swatches = ({ value, colors, onPick, fallback }: { value: string | null; colors: string[]; onPick: (c: string | null) => void; fallback: string }) => {
  const custom = !!value && !colors.includes(value)
  return (
    <div className="swatches">
      <button className={'swatch default' + (!value ? ' on' : '')} title={t('Default')} aria-label={t('Default')} onClick={() => onPick(null)}>
        <Ic.Check size={14} />
      </button>
      {colors.map((c) => (
        <button key={c} className={'swatch' + (value === c ? ' on' : '')} style={{ background: c }} title={c} aria-label={c} onClick={() => onPick(c)}>
          <Ic.Check size={14} />
        </button>
      ))}
      <label className={'swatch custom' + (custom ? ' on' : '')} title={t('Custom color')} style={custom ? { background: value! } : undefined}>
        {custom ? <Ic.Check size={14} /> : <Ic.Plus size={14} />}
        <input type="color" value={value ?? fallback} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  )
}

/** Miniature of the app drawn with the live tokens (background, glass, radius, accent), so every change shows up here at once. */
function Preview() {
  return (
    <div className="pv" aria-hidden>
      <div className="pv-side">
        <i className="pv-logo" />
        <i className="pv-row cur" />
        <i className="pv-row" />
        <i className="pv-row" />
        <i className="pv-row short" />
      </div>
      <div className="pv-main">
        <i className="pv-title" />
        <i className="pv-line" />
        <i className="pv-line short" />
        <i className="pv-line" />
        <i className="pv-btn" />
      </div>
    </div>
  )
}

// ───── tabs ─────

function Appearance() {
  const s = useSettings()
  const bgKey = s.bg.kind === 'preset' ? s.bg.id : s.bg.kind
  return (
    <>
      <div className="sx-hero">
        <Preview />
      </div>

      <Card icon={<Ic.Palette />} title={t('Theme & color')}>
        <Row label={t('Theme')} wide>
          <div className="theme-cards">
            {THEMES.map((th) => (
              <button key={th.id} className={'theme-card' + (s.theme === th.id ? ' on' : '')} aria-pressed={s.theme === th.id} onClick={() => updateSettings({ theme: th.id })}>
                <span className={'theme-prev tp-' + th.id}>
                  <i />
                  <i />
                  <i />
                </span>
                {t(th.label)}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t('Accent color')} hint={t('Buttons, highlights and the mouse pointer follow it.')} wide>
          <Swatches value={s.accent} colors={ACCENTS} fallback="#6857f0" onPick={(accent) => updateSettings({ accent })} />
        </Row>
      </Card>

      <Card icon={<Ic.Image />} title={t('Background')} hint={t('Shows behind the sidebar and around the app.')}>
        <Row label={t('Style')} wide>
          <div className="bg-grid">
            <button className={'bg-tile' + (bgKey === 'default' ? ' on' : '')} onClick={() => updateSettings({ bg: { kind: 'default' } })}>
              <span className="bg-prev bp-default" />
              {t('Default')}
            </button>
            <button className={'bg-tile' + (bgKey === 'none' ? ' on' : '')} onClick={() => updateSettings({ bg: { kind: 'none' } })}>
              <span className="bg-prev bp-none" />
              {t('Plain')}
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
              <span className="bg-prev bp-add">
                <Ic.Image size={20} />
              </span>
              {t('My image')}
            </button>
          </div>
        </Row>
        {s.bg.kind === 'preset' && (
          <Row label={t('Color strength')} hint={t('How strongly the background colors glow.')}>
            <Range label={t('Color strength')} value={s.bgStrength} min={50} max={200} step={5} unit="%" onChange={(bgStrength) => updateSettings({ bgStrength })} />
          </Row>
        )}
      </Card>

      <Card icon={<Ic.Layers />} title={t('Surfaces')} hint={t('Make the panels see-through so the background shows behind them.')}>
        <Row label={t('Sidebar style')}>
          <Segmented value={s.sidebar} options={SIDEBAR_STYLES.map((o) => ({ ...o, label: t(o.label) }))} onChange={(sidebar) => updateSettings({ sidebar })} />
        </Row>
        <Row label={t('Page list')} hint={t('Tree nests subpages. Compact lists each folder as one row with its pages right under it.')}>
          <Segmented value={s.pagesView} options={[{ id: 'tree', label: t('Tree') }, { id: 'compact', label: t('Compact') }]} onChange={(pagesView) => updateSettings({ pagesView })} />
        </Row>
        <Row label={t('Sidebar glass')} hint={t('Transparency and blur of the sidebar.')}>
          <Range label={t('Sidebar glass')} value={s.sideGlass} min={0} max={100} step={5} unit="%" onChange={(sideGlass) => updateSettings({ sideGlass })} />
        </Row>
        <Row label={t('Main panel glass')} hint={t('Transparency and blur of the page area.')}>
          <Range label={t('Main panel glass')} value={s.mainGlass} min={0} max={100} step={5} unit="%" onChange={(mainGlass) => updateSettings({ mainGlass })} />
        </Row>
        <Row label={t('Corner radius')}>
          <Range label={t('Corner radius')} value={s.radius} min={4} max={20} unit="px" onChange={(radius) => updateSettings({ radius })} />
        </Row>
      </Card>

      <Card icon={<Ic.Settings />} title={t('Interface')}>
        <Toggle label={t('Show cover image')} on={s.showCovers} onChange={(showCovers) => updateSettings({ showCovers })} />
        <Toggle label={t('Show page icons')} on={s.showIcons} onChange={(showIcons) => updateSettings({ showIcons })} />
        <Toggle label={t('Reduce motion')} hint={t('Minimizes animations.')} on={s.reduceMotion} onChange={(reduceMotion) => updateSettings({ reduceMotion })} />
      </Card>
    </>
  )
}

const GROUPS: { id: FontGroup; label: string; sample: string }[] = [
  { id: 'persian', label: 'Persian & Arabic', sample: 'سلام، این یک نمونه است ۱۲۳' },
  { id: 'english', label: 'English', sample: 'The quick brown fox 123' },
  { id: 'system', label: 'System', sample: 'Aa  آب' },
]

function FontPicker({ value, onPick }: { value: FontId; onPick: (id: FontId) => void }) {
  useEffect(() => FONTS.forEach(loadFont), []) // every card previews its own face
  return (
    <div className="fp">
      {GROUPS.map((g) => (
        <div key={g.id} className="fp-group">
          <div className="fp-label">{t(g.label)}</div>
          <div className="fp-grid">
            {FONTS.filter((f) => f.group === g.id).map((f) => (
              <button key={f.id} className={'fp-card' + (value === f.id ? ' on' : '')} aria-pressed={value === f.id} onClick={() => onPick(f.id)}>
                <span className="fp-name">
                  {t(f.label)}
                  {value === f.id && <Ic.Check size={14} />}
                </span>
                <span className="fp-sample" dir="auto" style={{ fontFamily: f.stack }}>
                  {f.sample ?? g.sample}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function Editor() {
  const s = useSettings()
  return (
    <>
      <Card icon={<Ic.Type />} title={t('Font')} hint={t('Applies to the text of your pages. Every font is built in, so it works offline.')}>
        <FontPicker value={s.font} onPick={(font) => updateSettings({ font })} />
      </Card>

      <Card icon={<Ic.Settings />} title={t('Text')}>
        <Row label={t('Text size')}>
          <Range label={t('Text size')} value={s.fontSize} min={13} max={22} unit="px" onChange={(fontSize) => updateSettings({ fontSize })} />
        </Row>
        <Row label={t('Text color')} hint={t('Leave on default to follow the theme.')} wide>
          <Swatches value={s.textColor} colors={TEXT_COLORS} fallback="#888888" onPick={(textColor) => updateSettings({ textColor })} />
        </Row>
        <div className="font-preview tiptap-like">
          <h4>{t('Preview')}</h4>
          <p>
            متغیر <code>count</code> را تعریف کنید و مقدار ۱۰ بدهید. This is an English sentence in the middle.
          </p>
        </div>
      </Card>
    </>
  )
}

function LanguageTab() {
  const s = useSettings()
  return (
    <Card icon={<Ic.Globe />} title={t('Language & layout')}>
      <Row label={t('Interface language')} hint={t('Changes the language of menus, buttons and messages. Your page content is never translated.')}>
        <Segmented
          value={s.lang}
          options={[
            { id: 'en', label: 'English' },
            { id: 'fa', label: 'فارسی', lang: 'fa' },
          ]}
          onChange={(lang) => updateSettings({ lang })}
        />
      </Row>
      <Row label={t('Layout direction')} hint={t('Where the sidebar, lists and panels sit. “Auto” follows the language.')}>
        <Segmented
          value={s.dir}
          options={[
            { id: 'auto', label: t('Auto') },
            { id: 'ltr', label: t('Left to right') },
            { id: 'rtl', label: t('Right to left') },
          ]}
          onChange={(dir) => updateSettings({ dir })}
        />
      </Row>
    </Card>
  )
}

function General() {
  const s = useSettings()
  return (
    <Card icon={<Ic.Settings />} title={t('Reminders & files')}>
      <Toggle label={t('Flashcard reminders')} hint={t('Notifies you when cards are due and the app is in the background.')} on={s.cardReminders} onChange={(cardReminders) => updateSettings({ cardReminders })} />
      <Toggle label={t('Compress large images')} hint={t('Shrinks big pictures when you add them, so the vault stays light.')} on={s.compressImages} onChange={(compressImages) => updateSettings({ compressImages })} />
    </Card>
  )
}

function Shortcuts() {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const groups = SHORTCUTS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !needle || i.label.toLowerCase().includes(needle) || t(i.label).toLowerCase().includes(needle) || shortcutKeys(i).some((k) => k.map(keyLabel).join('+').toLowerCase().includes(needle))),
  })).filter((g) => g.items.length)
  return (
    <>
      <div className="sc-search">
        <Ic.Search size={15} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search shortcuts…')} aria-label={t('Search shortcuts…')} />
      </div>
      {groups.map((g) => (
        <Card key={g.title} title={t(g.title)}>
          <ul className="sc-list">
            {g.items.map((i) => (
              <li key={i.label}>
                <span>{t(i.label)}</span>
                <span className="sc-keys">
                  {shortcutKeys(i).map((chord, n) => (
                    <span key={n} className="sc-chord" dir="ltr">
                      {n > 0 && <em>{t('or')}</em>}
                      {chord.map((k, j) => (
                        <kbd key={j}>{keyLabel(k)}</kbd>
                      ))}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {!groups.length && <p className="sc-none">{t('No shortcut matches.')}</p>}
    </>
  )
}

export interface DataActions {
  importMarkdown: () => void
  importVault: () => void
  exportAll: () => void
  backup: () => void
  restore: () => void
  autoBackup: () => void
  workspaces: () => void
}

const Action = ({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint?: string; onClick: () => void }) => (
  <button className="sx-action" onClick={onClick}>
    <span className="sx-ic">{icon}</span>
    <span className="sx-tx">
      <b>{label}</b>
      {hint && <small>{hint}</small>}
    </span>
    <Ic.Chevron size={14} />
  </button>
)

function DataTab({ a }: { a: DataActions }) {
  return (
    <>
      <Card icon={<Ic.Upload />} title={t('Import')}>
        <Action icon={<Ic.Upload />} label={t('Import Markdown files…')} onClick={a.importMarkdown} />
        <Action icon={<Ic.Folders />} label={t('Import Obsidian vault (folder)…')} onClick={a.importVault} />
      </Card>
      <Card icon={<Ic.Archive />} title={t('Export & backup')}>
        <Action icon={<Ic.Archive />} label={t('Export all pages (zip with Markdown & images)')} onClick={a.exportAll} />
        <Action icon={<Ic.Download />} label={t('Full backup (JSON)')} onClick={a.backup} />
        <Action icon={<Ic.Upload />} label={t('Restore from backup…')} onClick={a.restore} />
        <Action icon={<Ic.Save />} label={t('Automatic backup to folder…')} onClick={a.autoBackup} />
      </Card>
      <Card icon={<Ic.Layers />} title={t('Workspaces')}>
        <Action icon={<Ic.Layers />} label={t('Workspaces…')} onClick={a.workspaces} />
      </Card>
    </>
  )
}

function About() {
  return (
    <>
      <Card icon={<Ic.Info />} title={<Brand />}>
        <div className="sx-about">
          <span className="sx-logo">
            <Ic.Logo size={34} />
          </span>
          <p>{t('Your notes, checklists and drawings in one calm place. Everything stays on your device.')}</p>
          <small>{t('Version {version}', { version: appPackage.version })}</small>
          <small>{t('Created by')} Vexor</small>
        </div>
      </Card>
      <Card icon={<Ic.Download />} title={t('Updates')}><UpdateSettings /></Card>
    </>
  )
}

export function SettingsView({ data }: { data: DataActions }) {
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
        <button className="ghost-btn" onClick={reset}>
          {t('Reset all')}
        </button>
      </header>
      <div className="sx-layout">
        <nav className="set-tabs" role="tablist" aria-label={t('Settings')}>
          {TABS.map((th) => (
            <button key={th.id} role="tab" aria-selected={tab === th.id} className={tab === th.id ? 'on' : ''} onClick={() => setTab(th.id)}>
              {th.icon}
              {t(th.label)}
            </button>
          ))}
        </nav>
        <div className="sx-pane" role="tabpanel">
          <header className="sx-pane-head">
            <h3>{t(cur.title)}</h3>
            <p>{t(cur.hint)}</p>
          </header>
          {tab === 'appearance' ? <Appearance /> : tab === 'editor' ? <Editor /> : tab === 'language' ? <LanguageTab /> : tab === 'general' ? <General /> : tab === 'data' ? <DataTab a={data} /> : tab === 'database' ? <Suspense fallback={null}><DatabaseSettings /></Suspense> : tab === 'shortcuts' ? <Shortcuts /> : <About />}
        </div>
      </div>
    </div>
  )
}
