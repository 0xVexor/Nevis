// Keyboard shortcuts as shown on the settings page. This is documentation of what the handlers
// in App.tsx / PageView.tsx / Flashcards.tsx / the editor extensions already do — keep it in sync with them.
// 'Mod' is Ctrl on Windows/Linux and ⌘ on macOS.

export interface Shortcut {
  label: string // English source string, translated at render time
  keys: string[][] // alternatives; each is one chord, e.g. [['Mod', 'K']]
  macKeys?: string[][]
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
      sc('Move to…', ['Mod', 'Alt', 'M']),
      sc('Snap content left', ['Mod', 'Alt', '←']),
      sc('Snap content right', ['Mod', 'Alt', '→']),
      sc('Move block up', ['Mod', 'Alt', '↑']),
      sc('Move block down', ['Mod', 'Alt', '↓']),
      sc('Add full-width text after layout', ['Mod', 'Alt', 'Enter']),
      sc('Line break', ['Shift', 'Enter']),
      sc('Select all', ['Mod', 'A']),
      sc('Undo', ['Mod', 'Z']),
      { ...sc('Redo', ['Mod', 'Y'], ['Mod', 'Shift', 'Z']), macKeys: [['Mod', 'Shift', 'Z']] },
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

/** Tauri's macOS WebView and browser previews both expose an Apple platform. */
export const isMac = () => {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /Mac|iPhone|iPad|iPod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent)
}

const MAC: Record<string, string> = {
  Mod: '⌘', Cmd: '⌘', Command: '⌘', Meta: '⌘', Ctrl: '⌃', Control: '⌃',
  Alt: '⌥', Option: '⌥', Shift: '⇧', Enter: '↵', Return: '↵', Esc: '⎋', Escape: '⎋',
  Tab: '⇥', Backspace: '⌫', Delete: '⌦', Del: '⌦',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
}
const labelFor = (key: string, mac: boolean) => mac ? (MAC[key] ?? key) : key === 'Mod' ? 'Ctrl' : key

/** One actual key; keep the single-argument API safe to pass directly to Array.map. */
export const keyLabel = (key: string) => labelFor(key, isMac())
export const shortcutLabel = (keys: readonly string[], mac = isMac()) => keys.map((key) => labelFor(key, mac)).join(mac ? '' : '+')
export const shortcutKeys = (shortcut: Shortcut) => isMac() && shortcut.macKeys ? shortcut.macKeys : shortcut.keys

// Legacy UI strings use Ctrl to mean the cross-platform Mod binding. Only match key chords,
// so ordinary phrases such as "Enter your name" and translated prose are preserved.
const CHORD = /\b(?:Ctrl|Mod|Cmd|Command|Control|Meta|Alt|Option|Shift)(?:[ +]+(?:Ctrl|Mod|Cmd|Command|Control|Meta|Alt|Option|Shift))*[ +]+(?:ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Enter|Return|Backspace|Delete|Escape|Space|Tab|Esc|Del|F\d{1,2}|[A-Z0-9./\\=←→↑↓-])(?![A-Za-z0-9])/g
export function formatShortcutText(text: string, mac = isMac()): string {
  if (!mac) return text
  const rtl = /[֐-ࣿ]/.test(text)
  const display = (value: string) => rtl ? '⁦' + value + '⁩' : value
  const family = text.replace(/\b(?:Ctrl|Mod)\+([A-Z](?:\/[A-Z])+)(?![A-Za-z0-9])/g, (_match, letters: string) => display(letters.split('/').map((key) => shortcutLabel(['Mod', key], true)).join(' / ')))
  return family.replace(CHORD, (chord) => {
    let keys = chord.trim().split(/[ +]+/).map((key) => ['Ctrl', 'Cmd', 'Command', 'Meta'].includes(key) ? 'Mod' : key === 'Option' ? 'Alt' : key)
    if (keys.length === 2 && keys[0] === 'Mod' && keys[1] === 'Y') keys = ['Mod', 'Shift', 'Z']
    return display(shortcutLabel(keys, true))
  })
}

/** Menu hints may also be one navigation key; action labels are never passed here. */
export const shortcutHint = (hint: string) => isMac() && MAC[hint] ? MAC[hint] : formatShortcutText(hint)
