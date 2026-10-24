// Keyboard shortcuts as shown on the settings page. This is documentation of what the handlers
// in App.tsx / PageView.tsx / Flashcards.tsx / the editor extensions already do — keep it in sync with them.
// 'Mod' is Ctrl on Windows/Linux and ⌘ on macOS.

export interface Shortcut {
  label: string // English source string, translated at render time
  keys: string[][] // alternatives; each is one chord, e.g. [['Mod', 'K']]
}
export interface ShortcutGroup {
  title: string
  items: Shortcut[]
}

const sc = (label: string, ...keys: string[][]): Shortcut => ({ label, keys })

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'App',
    items: [
      sc('Search pages and commands', ['Mod', 'K']),
      sc('Open or close the sidebar', ['Mod', '\\']),
      sc('Reader mode', ['Mod', '.']),
      sc('Leave reader mode', ['Esc']),
      sc('Wider text column', ['Alt', '=']),
      sc('Narrower text column', ['Alt', '-']),
    ],
  },
  {
    title: 'Writing',
    items: [
      sc('Open the “/” menu', ['Mod', '/']),
      sc('Bold', ['Mod', 'B']),
      sc('Italic', ['Mod', 'I']),
      sc('Underline', ['Mod', 'U']),
      sc('Strikethrough', ['Mod', 'Shift', 'S']),
      sc('Inline code', ['Mod', 'E']),
      sc('Heading 1–6', ['Mod', 'Alt', '1–6']),
      sc('Bulleted list', ['Mod', 'Shift', '8']),
      sc('Numbered list', ['Mod', 'Shift', '7']),
      sc('Checklist', ['Mod', 'Shift', '9']),
      sc('Quote', ['Mod', 'Shift', 'B']),
      sc('Code block', ['Mod', 'Alt', 'C']),
      sc('Line break', ['Shift', 'Enter']),
      sc('Select all', ['Mod', 'A']),
      sc('Undo', ['Mod', 'Z']),
      sc('Redo', ['Mod', 'Y'], ['Mod', 'Shift', 'Z']),
    ],
  },
  {
    title: 'Text direction',
    items: [
      sc('Line direction: left-to-right', ['Mod', 'Shift', '→']),
      sc('Line direction: right-to-left', ['Mod', 'Shift', '←']),
    ],
  },
  {
    title: 'Find in page',
    items: [
      sc('Find in page', ['Mod', 'F']),
      sc('Next match', ['Enter'], ['F3'], ['Mod', 'G']),
      sc('Previous match', ['Shift', 'Enter'], ['Shift', 'F3'], ['Mod', 'Shift', 'G']),
      sc('Close find', ['Esc']),
    ],
  },
  {
    title: 'Markdown by hand',
    items: [
      sc('Turn a typed marker (#, -, 1., >, [], ```, ---) into a block', ['Tab']),
      sc('Indent / outdent inside a code block', ['Tab'], ['Shift', 'Tab']),
      sc('New formula (empty line: block; selected text or elsewhere: inline)', ['Mod', 'Shift', 'M']),
      sc('Edit the selected formula', ['Enter']),
      sc('Save a formula', ['Enter']),
      sc('New line in a block formula', ['Shift', 'Enter']),
      sc('Save a diagram', ['Mod', 'Enter']),
      sc('Cancel editing a formula or diagram', ['Esc']),
    ],
  },
  {
    title: 'Flashcards',
    items: [
      sc('Show the answer', ['Space'], ['Enter']),
      sc('Rate the card: again, hard, good, easy', ['1'], ['2'], ['3'], ['4']),
      sc('End the session', ['Esc']),
    ],
  },
]

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const MAC: Record<string, string> = { Mod: '⌘', Alt: '⌥', Shift: '⇧', Enter: '↵', Esc: 'Esc', Tab: '⇥' }

/** One key as it is printed on the keyboard of this platform. */
export const keyLabel = (k: string) => (isMac() ? (MAC[k] ?? k) : k === 'Mod' ? 'Ctrl' : k)
