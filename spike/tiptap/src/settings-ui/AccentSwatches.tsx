import { Button } from '../design-system/Button'
import { Icon } from '../design-system/icons'
import { updateSettings, useSettings } from '../settings'
import { t } from '../i18n'

export const ACCENTS = [
  { value: null, label: 'Teal', css: 'teal' },
  { value: '#6857f0', label: 'Violet', css: 'violet' },
  { value: '#3b6cf6', label: 'Blue', css: 'blue' },
  { value: '#22b07d', label: 'Green', css: 'green' },
  { value: '#ef5b4f', label: 'Coral', css: 'coral' },
] as const

/** The accent choice shared by Settings and first launch. Writes the real accent setting. */
export function AccentSwatches() {
  const accent = useSettings().accent
  return (
    <div className="prefs-swatches" role="group" aria-label={t('Accent color')}>
      {ACCENTS.map((a) => (
        <Button key={a.label} className={'prefs-swatch tone-' + a.css} aria-label={t(a.label)} title={t(a.label)} aria-pressed={accent === a.value} onClick={() => updateSettings({ accent: a.value })}>
          {accent === a.value && <Icon name="check" size={12} />}
        </Button>
      ))}
      <label className="prefs-custom-color" title={t('Custom color')}>
        <Icon name="plus" size={12} />
        <input type="color" aria-label={t('Custom color')} value={accent ?? '#087f74'} onChange={(event) => updateSettings({ accent: event.target.value })} />
      </label>
    </div>
  )
}
