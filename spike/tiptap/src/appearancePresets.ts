export const appearancePresets = [
  { id: 'calm', label: 'Calm' },
  { id: 'forest-lime', label: 'Forest & Lime' },
] as const

export type AppearancePreset = (typeof appearancePresets)[number]['id']
export const deckThemes = [
  { id: 'calm-light', label: 'Calm light' },
  { id: 'calm-dark', label: 'Calm dark' },
  { id: 'forest-light', label: 'Forest & Lime' },
  { id: 'forest-dark', label: 'Forest & Lime dark' },
] as const
export type DeckTheme = (typeof deckThemes)[number]['id']

export const forestLight = { paper: '#f1f4ec', ink: '#183a30', accent: '#49621e', border: '#cad4be', callout: '#e4ebdc' }
export const forestDark = { paper: '#183a30', ink: '#f1f4ec', accent: '#c7e875', border: '#526b5f', callout: '#24483c' }

const forestCode = { paper: '#183a30', ink: '#f1f4ec', keyword: '#e1efa9', string: '#f1d28a', type: '#b0dcc4', comment: '#b3c5b9' }
const calmCode = { paper: '#202429', ink: '#e9eee9', keyword: '#d2c4ff', string: '#f1d28a', type: '#99d9ca', comment: '#b6bfc1' }
const palettes = {
  'calm-light': { paper: '#fcfcfb', ink: '#222923', accent: '#087f74', border: '#e4e7e2', callout: '#e0efeb' },
  'calm-dark': { paper: '#202429', ink: '#e9eee9', accent: '#68cbb8', border: '#535e5d', callout: '#273935' },
  'forest-light': forestLight,
  'forest-dark': forestDark,
}

export function deckThemeForAppearance(preset: AppearancePreset, dark: boolean): DeckTheme {
  if (preset === 'forest-lime') return dark ? 'forest-dark' : 'forest-light'
  return dark ? 'calm-dark' : 'calm-light'
}

export function themeColors(theme: DeckTheme) {
  return { ...palettes[theme], code: theme.startsWith('forest-') ? forestCode : calmCode }
}

export function syntaxColors(code: ReturnType<typeof themeColors>['code']): Record<string, string> {
  return {
    '--hl-kw': code.keyword,
    '--hl-str': code.string,
    '--hl-num': code.string,
    '--hl-type': code.type,
    '--hl-fn': code.type,
    '--hl-com': code.comment,
    '--hl-tag': code.type,
    '--hl-meta': code.keyword,
    '--hl-punc': code.ink,
  }
}
