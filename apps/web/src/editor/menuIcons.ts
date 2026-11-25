// Adapted from Nevis/spike/tiptap/src/editor/menuIcons.ts; persistence stays in the new core.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Icon } from '../ds/icons'

/** The menus' short names for design-system icons (the item lists keep their own names). */
const ICONS: Record<string, string> = {
  star: 'star',
  list: 'list',
  ol: 'list-ordered',
  check: 'checklist',
  link: 'link',
  callout: 'callout',
  toggle: 'toggle',
  diagram: 'diagram',
  pencil: 'pencil',
  quote: 'quote',
  code: 'code-block',
  table: 'table',
  columns: 'columns',
  image: 'image',
  divider: 'divider',
  dir: 'text-direction',
  file: 'file',
}

export const commandIconName = (name: string) => ICONS[name]

/** Menu icons are written as `i:name` in the item lists; anything else (a letter, a page emoji) is shown as text. */
export const ICON_PREFIX = 'i:'
export const iconSvg = (name: string, size = 16) => {
  const icon = ICONS[name]
  return icon ? renderToStaticMarkup(createElement(Icon, { name: icon, size })) : ''
}
