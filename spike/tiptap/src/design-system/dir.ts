import { firstTextDirection } from '../textDirection'

/** Class names joined, skipping the falsy ones. */
export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

/**
 * Direction a row or card showing user text (a page title, a tag) should take: the same first-letter rule the editor uses.
 * Only an interface that is itself right-to-left lets the text decide; in an English interface the layout stays left-to-right
 * (chevron, icon, counts keep their places) and only the text inside is aligned by its own direction.
 * Undefined means: inherit the interface direction.
 */
export const dirOf = (text: string | null | undefined): 'rtl' | 'ltr' | undefined => {
  if (typeof document !== 'undefined' && document.documentElement.dir !== 'rtl') return undefined
  return firstTextDirection(text ?? '') ?? undefined
}
