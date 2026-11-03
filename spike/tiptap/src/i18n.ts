// UI translations. Source strings in the code are English (`t('Search')`); fa.ts maps them to Persian.
// A string without a Persian entry simply shows in English, so new UI text can ship before it is translated.
import { FA_SETTINGS } from './fa-settings'
import { FA_HOME } from './fa-home'
import { getSettings, type Lang } from './settings'
import { FA as FA_APP } from './fa'
import { formatShortcutText } from './shortcuts'
import { FA_DB } from './database/ui/fa-db'
import { FA_ONBOARDING } from './fa-onboarding'
import { FA_COVERS } from './fa-covers'
import { setTranslator } from './design-system/text'

const FA: Record<string, string> = { ...FA_DB, ...FA_APP, ...FA_SETTINGS, ...FA_HOME, ...FA_ONBOARDING, ...FA_COVERS }

export type { Lang }
export type Dir = 'ltr' | 'rtl'

export const getLang = (): Lang => getSettings().lang

/** t('Hello {name}', { name }) — placeholders are filled after translating. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let out = getLang() === 'fa' ? (FA[key] ?? key) : key
  // Format source UI text before interpolation: user-provided titles and values stay untouched.
  out = formatShortcutText(out)
  if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
  return out
}

setTranslator(t)

/** BCP-47 locale for dates and numbers. */
export const locale = () => (getLang() === 'fa' ? 'fa-IR' : 'en-US')
