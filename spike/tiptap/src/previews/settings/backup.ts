import { DEFAULTS, FONTS, type Settings } from '../../settings'

export const STUDY_FORMAT = 'nevis-settings-study/1'
/** Import a preference study, never a vault backup or arbitrary app state. */
export function readStudyBackup(text: string): Partial<Settings> {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== STUDY_FORMAT || !('preferences' in value) || !value.preferences || typeof value.preferences !== 'object') throw new Error('Choose a Nevis preview preferences file.')
  const p = value.preferences as Record<string, unknown>
  const result: Partial<Settings> = {}
  const enums = { theme: ['light', 'dark', 'system'], lang: ['en', 'fa'], dir: ['auto', 'ltr', 'rtl'], sidebar: ['default', 'compact', 'icons'], pagesView: ['tree', 'compact'] } as const
  for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
    if (typeof p[key] !== 'string' || !(enums[key] as readonly string[]).includes(p[key] as string)) throw new Error('This preferences file contains invalid settings.')
  }
  result.theme = p.theme as Settings['theme']; result.lang = p.lang as Settings['lang']; result.dir = p.dir as Settings['dir']
  result.sidebar = p.sidebar as Settings['sidebar']; result.pagesView = p.pagesView as Settings['pagesView']
  for (const key of ['radius', 'fontSize', 'sideGlass', 'mainGlass', 'bgStrength'] as const) {
    const ranges = { radius: [4, 20], fontSize: [13, 22], sideGlass: [0, 100], mainGlass: [0, 100], bgStrength: [50, 200] }
    if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || (p[key] as number) < ranges[key][0] || (p[key] as number) > ranges[key][1]) throw new Error('This preferences file contains invalid settings.')
    result[key] = p[key] as number
  }
  for (const key of ['showCovers', 'showIcons', 'reduceMotion', 'cardReminders', 'compressImages', 'prereleaseUpdates'] as const) {
    if (typeof p[key] !== 'boolean') throw new Error('This preferences file contains invalid settings.')
    result[key] = p[key] as boolean
  }
  for (const key of ['accent', 'textColor'] as const) {
    if (p[key] !== null && (typeof p[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(p[key] as string))) throw new Error('This preferences file contains invalid settings.')
    result[key] = p[key] as string | null
  }
  if (!FONTS.some(f => f.id === p.font) || (p.fontEn !== null && !FONTS.some(f => f.id === p.fontEn))) throw new Error('This preferences file contains invalid settings.')
  result.font = p.font as Settings['font']; result.fontEn = p.fontEn as Settings['fontEn']
  // Background asset IDs and keybindings are intentionally outside this portable preview format.
  result.bg = DEFAULTS.bg
  return result
}
