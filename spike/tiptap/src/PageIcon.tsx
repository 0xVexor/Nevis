import type { Page } from './repo'
import * as Ic from './icons'
import { iconNode } from './iconSet'

const TONES = ['#4f7cff', '#e24a9f', '#f59e0b', '#22b07d', '#8b5cf6', '#ef5b4f', '#0ea5c6']
const hash = (s: string) => {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}

/** Sidebar/panel icon: the page's emoji, else a small outline glyph on a tinted tile (colour derived from the id, like the mockups). */
export function PageIcon({ page }: { page: Pick<Page, 'id' | 'icon' | 'kind'> }) {
  if (page.icon) return <span className="pg-ic emoji">{iconNode(page.icon, 15)}</span>
  const tone = TONES[hash(page.id) % TONES.length]
  return (
    <span className="pg-ic tile" style={{ ['--tone' as string]: tone }}>
      {page.kind === 'folder' ? <Ic.Folder size={13} /> : <Ic.Page size={13} />}
    </span>
  )
}
