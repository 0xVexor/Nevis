import { getSettings } from './settings'
import { SHORTCUTS, shortcutKeys, shortcutLabel } from './shortcuts'
import { bindingsPaused, chordOf, sameChord } from './shortcutBindings'

const COMMANDS = new Map(SHORTCUTS.flatMap(group => group.items).map(item => [item.label, item]))

/** Shared lookup for migrated commands. Existing study IDs stay readable so saved choices survive migration. */
export function commandBinding(label: string) {
  const item = COMMANDS.get(label)
  if (!item) return null
  const id = item.binding ?? 'study:' + item.label
  const override = getSettings().shortcuts?.[id]
  const defaults = shortcutKeys(item)
  return { defaults, keys: override?.length ? [override] : defaults, overridden: !!override?.length }
}
export const commandHint = (label: string) => commandBinding(label)?.keys.map(keys => shortcutLabel(keys)).join(' / ') ?? ''

export function commandMatches(event: KeyboardEvent, label: string, defaults = false) {
  if (bindingsPaused() || event.defaultPrevented) return false
  const chord = chordOf(event), binding = commandBinding(label)
  return !!chord && !!binding && (defaults ? binding.defaults : binding.keys).some(keys => sameChord(keys, chord))
}

export function matchesSidebarShortcut(event: KeyboardEvent) {
  if (event.repeat || !commandMatches(event, 'Open or close the sidebar')) return false
  const target = event.target as HTMLElement | null
  // Mod+B belongs to Bold while editing. Alt+1 can still toggle the panel from the editor.
  return !sameChord(chordOf(event) ?? [], ['Mod', 'B']) || !target?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])')
}

/** Editor commands that run from a physical key and follow a remapped binding (see editor/physicalShortcuts.ts). */
export const EDITOR_COMMANDS = ['Bold', 'Italic', 'Underline', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Link', 'Link to page', 'Insert image', 'Insert table', 'Align left', 'Center', 'Align right', 'Strikethrough', 'Inline code', 'Bulleted list', 'Numbered list', 'Checklist', 'Quote', 'Code block', 'Line break', 'Select all', 'Undo', 'Redo', 'Line direction: left-to-right', 'Line direction: right-to-left'] as const
export type EditorCommand = (typeof EDITOR_COMMANDS)[number]

/** Contexts that can reuse a key without firing in the same UI. */
export function shortcutContext(label: string) {
  if (['Leave reader mode', 'Full screen'].includes(label)) return 'app'
  if (['Next match', 'Previous match', 'Close find'].includes(label)) return 'find'
  if (label === 'Start review') return 'review-overview'
  if (['Show the answer', 'Again', 'Hard', 'Good', 'Easy', 'End the session'].includes(label)) return 'review'
  if (['Save a formula', 'New line in a block formula', 'Save a diagram', 'Cancel editing a formula or diagram'].includes(label)) return 'formula'
  if (['Indent code', 'Outdent code'].includes(label)) return 'code'
  if (['Fit graph', 'Zoom graph in', 'Zoom graph out', 'Close graph'].includes(label)) return 'graph'
  if (['Undo database edit', 'Select all database cells', 'Fill down', 'Edit database cell', 'Clear database cells'].includes(label)) return 'database'
  return 'editor'
}
