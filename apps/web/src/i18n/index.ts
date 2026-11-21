// Interface text. Source strings are English keys (`t('Search')`), mapped to Persian; a string without an entry shows as its key, so new UI
// text can ship before it is translated. (Same convention as the old app, so the copied design system and the strings carry over.)
import { setTranslator } from '../ds/text'
import { FA_APP } from './faApp'
import { FA_NEW } from './faNew'
import { FA_SETTINGS } from './faSettings'

const FA: Record<string, string> = { ...FA_APP, ...FA_SETTINGS, ...FA_NEW }

/** t('Hello {name}', { name }): placeholders are filled AFTER translating, so user text stays untouched. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const out = FA[key] ?? key
  return vars ? out.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : out
}

export function installTranslator() { setTranslator(t) }
