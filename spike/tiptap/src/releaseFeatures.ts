import features from '../release-features.json' with { type: 'json' }

// Build-time release policy. Keep storage/model support for existing decks intact.
export const APPEARANCE_PRESETS_ENABLED: boolean = features.appearancePresets
export const SLIDES_ENABLED: boolean = features.slides
export const DECK_TOOLS = new Set(['list_decks', 'read_deck', 'export_deck_pdf', 'create_deck', 'edit_deck'])
export const pageAvailableInRelease = (page: { kind?: string }) => SLIDES_ENABLED || page.kind !== 'deck'
export function requireSlides() {
  if (!SLIDES_ENABLED) throw new Error('Slides are disabled in this release.')
}
