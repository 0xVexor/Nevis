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
import { FA_OLD } from './faOld'
import { getSettings } from '../deviceSettings'
import { formatShortcutText } from '../shortcuts'

const FA: Record<string, string> = { ...FA_APP, ...FA_SETTINGS, ...FA_HOME, ...FA_VIEWS, ...FA_COVERS, ...FA_ONBOARDING, ...FA_CONFLICTS, ...FA_NEW, ...FA_OLD }

/** t('Hello {name}', { name }): placeholders are filled AFTER translating, so user text stays untouched. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let out = getSettings().lang === 'fa' ? (FA[key] ?? key) : key // English: the source string itself
  out = formatShortcutText(out) // shortcut names inside UI text read as this platform writes them (⌥← on a Mac), before the placeholders are filled
  return vars ? out.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : out
}

export function installTranslator() { setTranslator(t) }

/** The interface language as a BCP 47 tag, for dates and numbers. */
export const locale = (): string => (getSettings().lang === 'fa' ? 'fa-IR' : 'en-US')
