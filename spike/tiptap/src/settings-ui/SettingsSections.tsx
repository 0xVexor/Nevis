import { Brand } from '../Brand'
import type { CSSProperties } from 'react'
import { Button, Disclosure, Icon, PreferenceGroup, PreferenceRow } from '../design-system'
import { BrandMark } from '../BrandMark'
import { UpdateSettings } from '../UpdateUI'
import appPackage from '../../package.json'
import { useEffect, useRef } from 'react'
import { FONTS, TEXT_COLORS, loadFontPreview, updateSettings, useSettings, type FontDef, type FontGroup, type FontId } from '../settings'
import { t } from '../i18n'
import { LATIN_DEFAULT } from '../fontStack'

// ───── building blocks: a card holds rows; a row is "label + hint" on one side and its control on the other ─────

const Swatches = ({ value, colors, onPick, fallback }: { value: string | null; colors: string[]; onPick: (c: string | null) => void; fallback: string }) => {
  const custom = !!value && !colors.includes(value)
  return (
    <div className="prefs-swatches" role="group">
      <Button className="prefs-swatch tone-teal" title={t('Default')} aria-label={t('Default')} aria-pressed={!value} onClick={() => onPick(null)}>
        {!value && <Icon name="check" size={12} />}
      </Button>
      {colors.map((c) => (
        <Button key={c} className="prefs-swatch" style={{ '--swatch': c } as CSSProperties} title={c} aria-label={c} aria-pressed={value === c} onClick={() => onPick(c)}>
          {value === c && <Icon name="check" size={12} />}
        </Button>
      ))}
      <label className="prefs-custom-color" title={t('Custom color')} data-on={custom || undefined} style={custom ? ({ '--swatch': value } as CSSProperties) : undefined}>
        <Icon name={custom ? 'check' : 'plus'} size={12} />
        <input type="color" aria-label={t('Custom color')} value={value ?? fallback} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  )
}

const GROUPS: { id: FontGroup; label: string; sample: string }[] = [
  { id: 'persian', label: 'Persian & Arabic', sample: 'سلام، این یک نمونه است ۱۲۳' },
  { id: 'english', label: 'English', sample: 'The quick brown fox 123' },
  { id: 'system', label: 'System', sample: 'Aa  آب' },
]

function FontCard({ face, sample, on, onPick }: { face: FontDef; sample: string; on: boolean; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !face.css) return
    const watch = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && (loadFontPreview(face), watch.disconnect()), { rootMargin: '200px' })
    watch.observe(el)
    return () => watch.disconnect()
  }, [face])
  return (
    <button ref={ref} className={'fp-card' + (on ? ' on' : '')} aria-pressed={on} onClick={onPick}>
      <span className="fp-name">
        {t(face.label)}
        {on && <Icon name="check" size={14} />}
      </span>
      <span className="fp-sample" dir="auto" style={{ fontFamily: face.stack }}>
        {sample}
      </span>
    </button>
  )
}

function FontPicker({ value, groups, none, onPick }: { value: FontId | null; groups: FontGroup[]; none?: { label: string; stack: string }; onPick: (id: FontId | null) => void }) {
  return (
    <div className="fp">
      {none && (
        <div className="fp-group">
          <div className="fp-grid">
            <button className={'fp-card' + (value === null ? ' on' : '')} aria-pressed={value === null} onClick={() => onPick(null)}>
              <span className="fp-name">
                {none.label}
                {value === null && <Icon name="check" size={14} />}
              </span>
              <span className="fp-sample" dir="auto" style={{ fontFamily: none.stack }}>
                The quick brown fox 123
              </span>
            </button>
          </div>
        </div>
      )}
      {GROUPS.filter((g) => groups.includes(g.id)).map((g) => (
        <div key={g.id} className="fp-group">
          <div className="fp-label">{t(g.label)}</div>
          <div className="fp-grid">
            {FONTS.filter((f) => f.group === g.id).map((f) => (
              <FontCard key={f.id} face={f} sample={f.sample ?? g.sample} on={value === f.id} onPick={() => onPick(f.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function EditorExtras() {
  const s = useSettings()
  return (
    <>
      <PreferenceGroup title={t('Text')}>
        <PreferenceRow label={t('Text color')} hint={t('Leave on default to follow the theme.')} wide>
          <Swatches value={s.textColor} colors={TEXT_COLORS} fallback="#888888" onPick={(textColor) => updateSettings({ textColor })} />
        </PreferenceRow>
        <div className="font-preview tiptap-like">
          <h4>{t('Preview')}</h4>
          <p>
            متغیر <code>count</code> را تعریف کنید و مقدار ۱۰ بدهید. This is an English sentence in the middle.
          </p>
        </div>
      </PreferenceGroup>
      <Disclosure className="prefs-disclosure" title={t('Font previews')}>      <PreferenceGroup title={t('Persian font')} hint={t('For Persian and Arabic letters only. English letters use the English font below. Every font is built in, so it works offline.')}>
        <FontPicker value={s.font} groups={['persian', 'system']} onPick={(font) => font && updateSettings({ font })} />
      </PreferenceGroup>

      <PreferenceGroup title={t('English font')} hint={t('For Latin letters and numbers, whatever the Persian font is.')}>
        <FontPicker value={s.fontEn} groups={['english', 'system']} none={{ label: t('Default (Instrument Sans)'), stack: LATIN_DEFAULT }} onPick={(fontEn) => updateSettings({ fontEn })} />
      </PreferenceGroup>

</Disclosure>
    </>
  )
}

export function About() {
  return (
    <>
      <PreferenceGroup title={<Brand />}>
        <div className="prefs-about">
          <span className="prefs-about-logo">
            <BrandMark size={34} />
          </span>
          <p>{t('Your notes, checklists and drawings in one calm place. Everything stays on your device.')}</p>
          <small>{t('Version {version}', { version: appPackage.version })}</small>
          <small>{t('Created by')} Vexor</small>
        </div>
      </PreferenceGroup>
      <PreferenceGroup title={t('Updates')}>
        <UpdateSettings />
      </PreferenceGroup>
    </>
  )
}

