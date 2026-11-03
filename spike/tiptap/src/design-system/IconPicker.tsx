import { useState, type CSSProperties } from 'react'
import { ICON_GROUPS } from './iconData'
import { Icon } from './icons'
import { t } from '../i18n'

/** A few ready colours; anything else comes from the colour field. Automatic leaves the colour to the context. */
const COLORS = ['#6a5cff', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#64748b']

/**
 * Choose an icon from the design system's set (grouped, searchable) and its colour.
 * Changing the colour of the chosen icon applies at once without closing (`close` is false).
 * Visual reference: docs/design-system/index.html → Icons. Styles: components.css (.ds-icon-picker*).
 */
export function IconPicker({ name, color: initial, onPick, onClear, clearLabel }: { name?: string; color?: string; onPick: (name: string, color: string | undefined, close: boolean) => void; onClear: () => void; clearLabel?: string }) {
  const [q, setQ] = useState('')
  const [color, setColor] = useState(initial)
  const query = q.trim().toLowerCase()
  // subjects first: a page is about something; the interface icons follow
  const ordered = [...ICON_GROUPS.filter((g) => g.id === 'subjects'), ...ICON_GROUPS.filter((g) => g.id !== 'subjects')]
  const groups = ordered.map((g) => ({ ...g, names: Object.keys(g.icons).filter((n) => !query || n.includes(query) || g.icons[n][0].includes(query)) })).filter((g) => g.names.length)
  const recolor = (next: string | undefined) => {
    setColor(next)
    if (name) onPick(name, next, false)
  }
  const custom = !!color && !COLORS.includes(color)
  return (
    <div className="ds-icon-picker">
      <input className="ds-field" autoFocus dir="auto" placeholder={t('Search icons…')} aria-label={t('Search icons…')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="ds-icon-picker-colors" role="radiogroup" aria-label={t('Icon colour')}>
        <button type="button" role="radio" aria-checked={!color} className="ds-color-dot ds-color-dot--auto" title={t('Automatic')} aria-label={t('Automatic')} onClick={() => recolor(undefined)} />
        {COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={color === c} className="ds-color-dot" style={{ '--dot': c } as CSSProperties} title={c} aria-label={c} onClick={() => recolor(c)} />
        ))}
        <label className="ds-color-dot ds-color-dot--custom" aria-checked={custom} title={t('Your own color')} style={custom ? ({ '--dot': color } as CSSProperties) : undefined}>
          <input type="color" aria-label={t('Your own color')} value={color ?? '#6a5cff'} onChange={(e) => recolor(e.target.value)} />
          {!custom && <Icon name="plus" size={12} />}
        </label>
      </div>
      <div className="ds-icon-picker-scroll">
        {groups.map((g) => (
          <section key={g.id} aria-label={t(g.label)}>
            <h4 className="ds-icon-picker-head">{t(g.label)}</h4>
            <div className="ds-icon-picker-grid" style={color ? ({ color } as CSSProperties) : undefined}>
              {g.names.map((n) => (
                <button key={n} type="button" className="ds-icon-btn" aria-pressed={name === n} title={n} aria-label={n} onClick={() => onPick(n, color, true)}>
                  <Icon name={n} size={20} />
                </button>
              ))}
            </div>
          </section>
        ))}
        {groups.length === 0 && <p className="ds-icon-picker-empty">{t('No icon found')}</p>}
      </div>
      <div className="ds-icon-picker-foot">
        <span>{t('{n} icons', { n: groups.reduce((sum, g) => sum + g.names.length, 0) })}</span>
        <button type="button" className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onClear}>
          {clearLabel ?? t('Remove icon')}
        </button>
      </div>
    </div>
  )
}
