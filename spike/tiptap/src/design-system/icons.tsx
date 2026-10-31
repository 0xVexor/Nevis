import { GLYPHS } from '../iconSet'

/**
 * Nevis design system — icon library.
 * One style: 24×24, 1.6 stroke, round caps and joins, no fills, `currentColor`. Never mix in filled or emoji icons.
 * Name → [search keywords, inner SVG markup]. Page icons (the 170+ glyphs in ../iconSet) resolve through the same <Icon>, so
 * <Icon name="rocket"/> and <Icon name="file-pdf"/> both work. Group order here is the order of the live reference.
 */
import { DS_ICONS } from './iconData'

/**
 * <Icon name="file-pdf" size={18} /> — design-system icons first, then the page-icon glyphs.
 * Decorative by default (aria-hidden); pass `label` for an icon that stands alone.
 */
export function Icon({ name, size = 18, label, className }: { name: string; size?: number; label?: string; className?: string }) {
  const body = DS_ICONS[name]?.[1] ?? GLYPHS[name]?.[1] ?? ''
  return (
    <svg
      className={'ds-icon' + (className ? ' ' + className : '')}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  )
}
