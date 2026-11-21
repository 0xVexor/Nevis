// Interface text. Source strings are English keys (`t('Search')`), mapped to Persian; a string without an entry shows as its key, so new UI
// text can ship before it is translated. (Same convention as the old app, so the copied design system and the strings carry over.)
import { setTranslator } from '../ds/text'
import { FA_APP } from './faApp'
import { FA_NEW } from './faNew'
import { FA_SETTINGS } from './faSettings'
import { FA_HOME } from './fa-home'
import { FA_VIEWS } from './fa-views'
import { FA_COVERS } from './fa-covers'
import { FA_ONBOARDING } from './fa-onboarding'
import { FA_CONFLICTS } from './fa-conflicts'

const FA: Record<string, string> = { ...FA_APP, ...FA_SETTINGS, ...FA_HOME, ...FA_VIEWS, ...FA_COVERS, ...FA_ONBOARDING, ...FA_CONFLICTS, ...FA_NEW }

/** t('Hello {name}', { name }): placeholders are filled AFTER translating, so user text stays untouched. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const out = FA[key] ?? key
  return vars ? out.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : out
}

export function installTranslator() { setTranslator(t) }

/** The interface language (a BCP 47 tag): Persian. */
export const locale = (): string => 'fa'
