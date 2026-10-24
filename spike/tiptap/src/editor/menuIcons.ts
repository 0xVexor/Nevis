import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as Ic from '../icons'

const ICONS: Record<string, (p: { size?: number }) => React.JSX.Element> = {
  star: Ic.Star,
  list: Ic.List,
  ol: Ic.OrderedList,
  check: Ic.Checklist,
  link: Ic.Link,
  callout: Ic.Callout,
  toggle: Ic.Toggle,
  diagram: Ic.Diagram,
  quote: Ic.Quote,
  code: Ic.Code,
  table: Ic.Table,
  image: Ic.Image,
  divider: Ic.Divider,
  dir: Ic.Direction,
}

/** Menu icons are written as `i:name` in the item lists; anything else (a letter, a page emoji) is shown as text. */
export const ICON_PREFIX = 'i:'
export const iconSvg = (name: string, size = 16) => {
  const C = ICONS[name]
  return C ? renderToStaticMarkup(createElement(C, { size })) : ''
}
