import { GLYPHS, ICON_PREFIX } from '../iconSet'
import type { IconCatalog } from '../documents/iconHost.ts'

const COLOR = /^#[0-9a-fA-F]{6}$/

/** The page icons the app can draw, for the MCP tools: validation on write and search for list_icons. */
export function createIconCatalog(): IconCatalog {
  return {
    valid(icon) {
      if (!icon.startsWith(ICON_PREFIX)) return false
      const [name, color] = icon.slice(ICON_PREFIX.length).split('@')
      return Object.hasOwn(GLYPHS, name) && (color === undefined || COLOR.test(color))
    },
    search(query, limit) {
      const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const rank = (name: string) => (words.length === 1 && name === words[0] ? 0 : words.length === 1 && name.startsWith(words[0]) ? 1 : 2)
      const found = Object.entries(GLYPHS)
        .filter(([name, [keywords]]) => words.every((word) => name.includes(word) || keywords.toLowerCase().includes(word)))
        .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      return { icons: found.slice(0, limit).map(([name, [keywords]]) => ({ name, icon: ICON_PREFIX + name, keywords })), total: found.length }
    },
  }
}
