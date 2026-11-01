// How the two font choices become one CSS font stack. English (Latin letters, digits, common punctuation) and Persian
// (Arabic-script letters) each get exactly their own face:
//  - the English face comes first, so it wins every Latin letter; it must never claim Arabic-script letters, or the Persian
//    face would be ignored there. The bundled web faces have no Arabic letters, but the system faces do (system-ui, Times New
//    Roman, Consolas...), so those are re-declared under one name, limited to the Latin ranges below.
//  - the Persian face follows and supplies everything the English face does not have.
// No DOM in here: settings.ts applies the result.

export interface FaceDef { id: string; group: string; stack: string }

/** Latin letters, Latin extended, general punctuation and currency. Not ZWNJ/ZWJ (U+200C-200D) and no Arabic-script block. */
export const LATIN_RANGE = 'U+0000-00FF,U+0100-024F,U+0259,U+1E00-1EFF,U+2010-2027,U+2030-205E,U+20A0-20CF,U+2122,U+2190-2193,U+2212,U+2215,U+FEFF'
export const LATIN_ALIAS = 'Nevis Latin'
/** The face of English text when none is chosen: the app's own UI face (a bundled web face with no Arabic letters). */
export const LATIN_DEFAULT = "'Instrument Sans'"

/** Installed faces to try, in order, for each system choice: [regular, bold]. */
const LOCAL: Record<string, [string[], string[]]> = {
  system: [['Segoe UI', 'SF Pro Text', 'Helvetica Neue', 'Roboto', 'Ubuntu', 'Arial'], ['Segoe UI Bold', 'SF Pro Text Bold', 'Helvetica Neue Bold', 'Roboto Bold', 'Ubuntu Bold', 'Arial Bold']],
  serif: [['Georgia', 'Times New Roman'], ['Georgia Bold', 'Times New Roman Bold']],
  mono: [['Cascadia Mono', 'Consolas', 'Menlo', 'Monaco', 'Courier New'], ['Cascadia Mono Bold', 'Consolas Bold', 'Menlo Bold', 'Monaco', 'Courier New Bold']],
}

const firstFamily = (stack: string) => stack.split(',')[0].trim()
const sources = (names: string[]) => names.map((n) => `local('${n}')`).join(',')

export interface Fonts {
  /** `--font` and `--ds-font-ui`; null = the stylesheet's own default. */
  sans: string | null
  /** `--ds-font-serif`; null = the stylesheet's own default. */
  serif: string | null
  /** @font-face rules the stack needs (empty when none). */
  css: string
}

export function composeFonts(persian: FaceDef, english: FaceDef | undefined): Fonts {
  const system = english && LOCAL[english.id] && english.group === 'system'
  const latin = english ? (system ? `'${LATIN_ALIAS}'` : firstFamily(english.stack)) : LATIN_DEFAULT
  const sans = !english && persian.id === 'vazir' ? null : `${latin}, ${persian.stack}`
  const serif = english ? sans : persian.id === 'vazir' ? null : `'Newsreader', ${persian.stack}`
  let css = ''
  if (system) {
    const [regular, bold] = LOCAL[english.id]
    css = `@font-face{font-family:'${LATIN_ALIAS}';font-weight:100 599;src:${sources(regular)};unicode-range:${LATIN_RANGE}}\n@font-face{font-family:'${LATIN_ALIAS}';font-weight:600 900;src:${sources(bold)};unicode-range:${LATIN_RANGE}}`
  }
  return { sans, serif, css }
}
