// UI translations. Source strings in the code are English (`t('Search')`); fa.ts maps them to Persian.
// A string without a Persian entry simply shows in English, so new UI text can ship before it is translated.
import { getSettings, type Lang } from './settings'
import { FA as FA_APP } from './fa'
import { FA_DB } from './database/ui/fa-db'

const FA: Record<string, string> = { ...FA_DB, ...FA_APP }

export type { Lang }
export type Dir = 'ltr' | 'rtl'

export const getLang = (): Lang => getSettings().lang

/** t('Hello {name}', { name }) — placeholders are filled after translating. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let out = getLang() === 'fa' ? (FA[key] ?? key) : key
  if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
  return out
}

/** BCP-47 locale for dates and numbers. */
export const locale = () => (getLang() === 'fa' ? 'fa-IR' : 'en-US')
