/** Interface text for the design system. The app registers its translator; without one the key is the text. */
type Translate = (key: string, vars?: Record<string, string | number>) => string

let translate: Translate = (key, vars) => (vars ? key.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : key)

export const setTranslator = (next: Translate) => {
  translate = next
}
export const t: Translate = (key, vars) => translate(key, vars)
