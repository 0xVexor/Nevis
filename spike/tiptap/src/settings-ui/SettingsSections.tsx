import { Brand } from '../Brand'
import { BrandMark } from '../BrandMark'
import { UpdateSettings } from '../UpdateUI'
import appPackage from '../../package.json'
import { useEffect, useRef } from 'react'
import { FONTS, TEXT_COLORS, loadFontPreview, updateSettings, useSettings, type FontDef, type FontGroup, type FontId } from '../settings'
import * as Ic from '../icons'
import { t } from '../i18n'
import { Card, Row } from '../SettingsParts'
import { LATIN_DEFAULT } from '../fontStack'

// ───── building blocks: a card holds rows; a row is "label + hint" on one side and its control on the other ─────

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
        {on && <Ic.Check size={14} />}
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
                {value === null && <Ic.Check size={14} />}
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
      <Card icon={<Ic.Settings />} title={t('Text')}>
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
      <details className="prefs-disclosure"><summary>{t('Font previews')}</summary>      <Card icon={<Ic.Type />} title={t('Persian font')} hint={t('For Persian and Arabic letters only. English letters use the English font below. Every font is built in, so it works offline.')}>
        <FontPicker value={s.font} groups={['persian', 'system']} onPick={(font) => font && updateSettings({ font })} />
      </Card>

      <Card icon={<Ic.Type />} title={t('English font')} hint={t('For Latin letters and numbers, whatever the Persian font is.')}>
        <FontPicker value={s.fontEn} groups={['english', 'system']} none={{ label: t('Default (Instrument Sans)'), stack: LATIN_DEFAULT }} onPick={(fontEn) => updateSettings({ fontEn })} />
      </Card>

</details>
    </>
  )
}

export function About() {
  return (
    <>
      <Card icon={<Ic.Info />} title={<Brand />}>
        <div className="sx-about">
          <span className="sx-logo">
            <BrandMark size={34} />
          </span>
          <p>{t('Your notes, checklists and drawings in one calm place. Everything stays on your device.')}</p>
          <small>{t('Version {version}', { version: appPackage.version })}</small>
          <small>{t('Created by')} Vexor</small>
        </div>
      </Card>
      <Card icon={<Ic.Download />} title={t('Updates')}>
        <UpdateSettings />
      </Card>
    </>
  )
}

