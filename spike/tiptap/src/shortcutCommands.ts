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
