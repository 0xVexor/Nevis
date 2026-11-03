import { getSettings } from './settings'
import { SHORTCUTS, shortcutKeys } from './shortcuts'
import { chordOf, sameChord } from './shortcutBindings'

/** Shared lookup for migrated commands. Existing study IDs stay readable so saved choices survive migration. */
export function commandBinding(label: string) {
  const item = SHORTCUTS.flatMap(group => group.items).find(command => command.label === label)
  if (!item) return null
  const id = item.binding ?? 'study:' + item.label
  const override = getSettings().shortcuts[id]
  return { defaults: shortcutKeys(item), keys: override ? [override] : shortcutKeys(item), overridden: !!override }
}
export function commandMatches(event: KeyboardEvent, label: string, defaults = false) {
  const chord = chordOf(event), binding = commandBinding(label)
  return !!chord && !!binding && (defaults ? binding.defaults : binding.keys).some(keys => sameChord(keys, chord))
}

/** Editor commands that run from a physical key and follow a remapped binding (see editor/physicalShortcuts.ts). */
export const EDITOR_COMMANDS = ['Bold', 'Italic', 'Underline', 'Heading 1', 'Heading 2', 'Heading 3', 'Link', 'Link to page', 'Insert image', 'Insert table', 'Align left', 'Center', 'Align right', 'Strikethrough', 'Inline code', 'Bulleted list', 'Numbered list', 'Checklist', 'Quote', 'Code block', 'Line break', 'Select all', 'Undo', 'Redo', 'Line direction: left-to-right', 'Line direction: right-to-left'] as const
export type EditorCommand = (typeof EDITOR_COMMANDS)[number]

/** A shortcut the person can change: a named app binding or an editor command. The rest are built-in handlers with fixed keys. */
export const isRemappable = (item: { binding?: string; label: string }) => !!item.binding || (EDITOR_COMMANDS as readonly string[]).includes(item.label)
