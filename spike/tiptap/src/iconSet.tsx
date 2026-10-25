import type { ReactNode } from 'react'
import { MORE_GLYPHS } from './iconSetMore'
import { EXTRA_GLYPHS } from './iconSetExtra'

/** Outline glyphs a page can use as its icon instead of an emoji. Stored on the page as `i:<name>`. */
export const ICON_PREFIX = 'i:'

// name -> [search keywords, inner SVG markup of a 24×24 stroke icon]
export const GLYPHS: Record<string, [string, string]> = {
  home: ['home house', '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>'],
  page: ['page document file', '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'],
  book: ['book read', '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M9 7h6"/>'],
  bookmark: ['bookmark save', '<path d="M6 3h12v18l-6-4-6 4z"/>'],
  folder: ['folder files', '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'],
  star: ['star favorite', '<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z"/>'],
  heart: ['heart love', '<path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/>'],
  bolt: ['bolt zap lightning energy', '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'],
  flame: ['flame fire hot', '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/>'],
  leaf: ['leaf plant nature eco', '<path d="M5 19c0-9 5-14 15-14 0 10-5 15-14 15"/><path d="M5 19c3-4 6-6 10-8"/>'],
  sun: ['sun light day', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  moon: ['moon night dark', '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'],
  cloud: ['cloud weather', '<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>'],
  globe: ['globe world web internet', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'],
  compass: ['compass explore navigate', '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'],
  pin: ['pin map location place', '<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'],
  flag: ['flag goal milestone', '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'],
  target: ['target goal aim', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>'],
  trophy: ['trophy award win', '<path d="M8 4h8v6a4 4 0 0 1-8 0zM8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 14v4M8 21h8M9 18h6"/>'],
  rocket: ['rocket launch startup', '<path d="M5 15c-1 1-2 4-2 6 2 0 5-1 6-2M14 4c3 0 6 1 6 1s1 3 1 6l-7 7-6-6zM9 13l-3-1 3-3M11 15l1 3 3-3"/><circle cx="15" cy="9" r="1.2"/>'],
  gift: ['gift present', '<rect x="3" y="8" width="18" height="4"/><path d="M5 12v9h14v-9M12 8v13M12 8S10 3 8 4s0 4 4 4zM12 8s2-5 4-4 0 4-4 4z"/>'],
  bell: ['bell notification alert', '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>'],
  calendar: ['calendar date schedule', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
  clock: ['clock time watch', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  mail: ['mail email letter', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'],
  chat: ['chat message comment', '<path d="M4 5h16v11H9l-5 4z"/>'],
  user: ['user person profile', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  users: ['users team people group', '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6"/>'],
  briefcase: ['briefcase work job', '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V4h6v3M3 13h18"/>'],
  wallet: ['wallet money finance', '<path d="M4 7a2 2 0 0 1 2-2h12v4M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.2"/>'],
  chart: ['chart stats analytics graph', '<path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6"/>'],
  database: ['database data storage', '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'],
  code: ['code dev program', '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>'],
  terminal: ['terminal console shell', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>'],
  cpu: ['cpu chip hardware', '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'],
  bulb: ['idea bulb light', '<path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3zM10 20.5h4"/>'],
  pencil: ['pencil write edit', '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'],
  brush: ['brush paint art design', '<path d="M18 3 9 12l3 3 9-9a2 2 0 0 0-3-3zM9 12c-3 0-4 2-4 4s-1 4-2 5c4 1 8 0 9-3a3 3 0 0 0-3-6z"/>'],
  palette: ['palette color art', '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.6 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>'],
  camera: ['camera photo', '<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/>'],
  image: ['image picture photo', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/>'],
  music: ['music audio song', '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'],
  video: ['video film movie', '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'],
  game: ['game controller play', '<rect x="2" y="7" width="20" height="11" rx="4"/><path d="M7 10v5M4.5 12.5h5M15 11h.01M18 14h.01"/>'],
  coffee: ['coffee cup drink', '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h2a2 2 0 0 1 0 4h-2M7 2v3M11 2v3M15 2v3"/>'],
  cart: ['cart shop buy', '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l3 12h11l2-8H6"/>'],
  key: ['key password access', '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>'],
  lock: ['lock secure private', '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'],
  shield: ['shield security safe', '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>'],
  settings: ['settings gear config', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'],
  puzzle: ['puzzle piece plugin', '<path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z"/>'],
  graduation: ['graduation study school learn', '<path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11.5V16c3 2.5 9 2.5 12 0v-4.5M22 9v6"/>'],
  flask: ['flask science lab', '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 15h8"/>'],
  dumbbell: ['gym fitness workout', '<path d="M3 9v6M6 6v12M18 6v12M21 9v6M6 12h12"/>'],
  plane: ['plane travel flight', '<path d="M21 3 3 10l7 3 3 7zM10 13l11-10"/>'],
  tag: ['tag label price', '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>'],
  list: ['list todo tasks', '<path d="m3 6 1.5 1.5L7 5M3 13l1.5 1.5L7 12M3 20l1.5 1.5L7 19M11 6h10M11 13h10M11 20h10"/>'],
  link: ['link url chain', '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'],
}

Object.assign(GLYPHS, MORE_GLYPHS, EXTRA_GLYPHS)
export const GLYPH_NAMES = Object.keys(GLYPHS)

export const isGlyph = (icon?: string): icon is string => !!icon && icon.startsWith(ICON_PREFIX)

/** A page icon is `i:name`, or `i:name@#rrggbb` when a colour was chosen. */
export const parseIcon = (icon: string) => {
  const body = icon.startsWith(ICON_PREFIX) ? icon.slice(ICON_PREFIX.length) : icon
  const [name, color] = body.split('@')
  return { name, color: color || undefined }
}

export function Glyph({ name, size = 18, color }: { name: string; size?: number; color?: string }) {
  const g = GLYPHS[name]
  if (!g) return null
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={color ? { color } : undefined} dangerouslySetInnerHTML={{ __html: g[1] }} />
  )
}

/** A page icon as something renderable: an emoji as text, an `i:name` glyph as an SVG. */
export function iconNode(icon: string | undefined, size = 18, fallback?: ReactNode): ReactNode {
  if (!icon) return fallback ?? null
  if (!isGlyph(icon)) return icon
  const g = parseIcon(icon)
  return <Glyph name={g.name} size={size} color={g.color} />
}

/** Plain-text stand-in for places that can only show text (a glyph becomes a page emoji). */
export const plainIcon = (icon: string | undefined, fallback = '📄') => (!icon ? fallback : isGlyph(icon) ? fallback : icon)
