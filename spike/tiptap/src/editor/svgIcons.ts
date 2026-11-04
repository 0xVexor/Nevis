// Markup icons for the DOM-built toolbars (image bar, zoom viewer) that cannot use the React icon set; drawn from the same design-system glyphs.
import { DS_ICONS } from '../design-system/iconData'

const icon = (name: string, size = 16) => `<svg class="ds-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${DS_ICONS[name]?.[1] ?? ''}</svg>`

export const svgIcon = {
  close: icon('x'),
  left: icon('align-left'),
  center: icon('align-center'),
  right: icon('align-right'),
  enlarge: icon('maximize'),
  reset: icon('refresh'),
  plus: icon('plus'),
  minus: icon('minus'),
}

/** Set a button's content: markup when it starts with an <svg>, plain text otherwise. */
export const setLabel = (b: HTMLElement, label: string) => (label.startsWith('<svg') ? (b.innerHTML = label) : (b.textContent = label))
