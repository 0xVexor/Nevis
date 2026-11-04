import type { Page } from './repo'
import { Icon } from './design-system'
import { GLYPHS, iconNode, isGlyph, parseIcon } from './iconSet'

const TONES = ['#4f7cff', '#e24a9f', '#f59e0b', '#22b07d', '#8b5cf6', '#ef5b4f', '#0ea5c6']
const hash = (s: string) => {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}

/** The colour a page's glyph icon is drawn in (stable per page id). */
export const toneOf = (id: string) => TONES[hash(id) % TONES.length]

/** Sidebar/panel icon: an old emoji as-is, an outline glyph on a tinted tile, else a default page/folder glyph on a tile (colour derived from the id). */
export function PageIcon({ page }: { page: Pick<Page, 'id' | 'icon' | 'kind'> }) {
  // a glyph name the app does not know would draw an empty tile: show the page's default icon instead
  const icon = page.icon && isGlyph(page.icon) && !Object.hasOwn(GLYPHS, parseIcon(page.icon).name) ? undefined : page.icon
  if (icon && !isGlyph(icon)) return <span className="pg-ic emoji">{iconNode(icon, 15)}</span>
  return (
    <span className="pg-ic tile" style={{ ['--tone' as string]: (icon && isGlyph(icon) && parseIcon(icon).color) || toneOf(page.id) }}>
      {icon ? (
        iconNode(icon, 14)
      ) : page.kind === 'folder' ? (
        <Icon name="folder" size={13} />
      ) : page.kind === 'board' ? (
        <Icon name="pencil" size={13} />
      ) : page.kind === 'todo' ? (
        <Icon name="checklist" size={13} />
      ) : (
        <Icon name="file" size={13} />
      )}
    </span>
  )
}
