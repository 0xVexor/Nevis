// The app-level shortcuts a person can change in Settings → Shortcuts. A chord is a list like ['Mod', 'K']:
// the modifiers first, the key last. Keys are matched by the physical key (event.code), so they also work
// with the Persian layout, where event.key is a Persian letter.
import { getSettings } from './settings'

export type BindingId = 'search' | 'sidebar' | 'reader' | 'widerColumn' | 'narrowerColumn' | 'find'
export type Chord = string[]

export const BINDINGS: Record<BindingId, Chord> = {
  search: ['Mod', 'K'],
  // one hand, any keyboard layout: the physical 1 key
  sidebar: ['Alt', '1'],
  reader: ['Mod', '.'],
  widerColumn: ['Alt', '='],
  narrowerColumn: ['Alt', '-'],
  find: ['Mod', 'F'],
}

const MODIFIERS = new Set(['Mod', 'Alt', 'Shift'])

const PUNCT: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Backslash: '\\',
  Slash: '/',
  Equal: '=',
  Minus: '-',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
}

/** The key of an event as a chord names it, from the physical key; null for a modifier on its own. */
export function eventKey(e: KeyboardEvent): string | null {
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit\d$/.test(c)) return c.slice(5)
  if (/^F\d{1,2}$/.test(c)) return c
  if (PUNCT[c]) return PUNCT[c]
  if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(c) || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null
  return e.key.length === 1 ? e.key.toUpperCase() : null
}

export function chordOf(e: KeyboardEvent): Chord | null {
  const key = eventKey(e)
  if (!key) return null
  return [...(e.ctrlKey || e.metaKey ? ['Mod'] : []), ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey ? ['Shift'] : []), key]
}

export const sameChord = (a: Chord, b: Chord) => a.length === b.length && a.every((k, i) => k === b[i])

export function bindingKeys(id: BindingId): Chord {
  const own = getSettings().shortcuts[id]
  return Array.isArray(own) && own.length ? own : BINDINGS[id]
}

let paused = 0
/** While a new shortcut is being recorded in Settings, no binding fires. Returns the function that resumes them. */
export function pauseBindings() {
  paused++
  let done = false
  return () => {
    if (!done) ((done = true), paused--)
  }
}

export function matches(e: KeyboardEvent, id: BindingId): boolean {
  if (paused) return false
  const chord = chordOf(e)
  return !!chord && sameChord(chord, bindingKeys(id))
}

/** A chord is usable if it cannot be typed as text: Ctrl/⌘ or Alt is held, or it is a function key. */
export const usableChord = (chord: Chord) =>
  chord.some((k) => k === 'Mod' || k === 'Alt') || (/^F\d{1,2}$/.test(chord[chord.length - 1]) && chord.every((k, i) => i === chord.length - 1 || MODIFIERS.has(k)))

/** Which other binding already uses this chord, if any. */
export const takenBy = (chord: Chord, except: BindingId): BindingId | null => (Object.keys(BINDINGS) as BindingId[]).find((id) => id !== except && sameChord(bindingKeys(id), chord)) ?? null

/** The hint text a menu or command shows for a binding, e.g. "Ctrl K". */
export const bindingHint = (id: BindingId) =>
  bindingKeys(id)
    .map((k) => (k === 'Mod' ? 'Ctrl' : k))
    .join(' ')
