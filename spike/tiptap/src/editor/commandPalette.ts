import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { menuRender } from './menu'
import { INSERTS, paletteItems, shownItem, type CommandItem } from './slash'
import { t } from '../i18n'

let closeActive: (() => void) | null = null

/**
 * Ctrl+/ — the "/" menu on demand, without typing a slash into the text.
 * It opens at the caret, you type to filter, ↑ ↓ Enter to run, Esc to close. With text selected the commands
 * work on the selection (turn it into a heading / list / code, wrap it in a callout, draw it as a diagram…).
 */
function openPalette(editor: any) {
  if (closeActive) return closeActive() // the shortcut toggles

  let query = ''
  const render = menuRender<CommandItem>({ label: () => (query ? `${t('Commands')} · ${query}` : t('Commands')), view: shownItem })()
  const caret = () => {
    const c = editor.view.coordsAtPos(editor.state.selection.head)
    return new DOMRect(c.left, c.top, 0, c.bottom - c.top)
  }
  const props = () => ({ items: paletteItems(query, editor), command: pick, clientRect: caret })

  function pick(item: CommandItem) {
    if (item.disabled) return
    close()
    const { empty, to } = editor.state.selection
    let chain = editor.chain().focus()
    if (!empty && INSERTS.has(item.title)) chain = chain.setTextSelection(to) // insert after the selection instead of replacing it
    item.run(chain, editor).run()
  }

  const onKey = (e: KeyboardEvent) => {
    // the shortcut itself closes (and must not reach the editor, which would open the menu again)
    const isShortcut = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'Slash' || e.key === '/')
    if (e.key === 'Escape' || isShortcut) return void (e.preventDefault(), e.stopPropagation(), close())
    if (/^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return // modifiers alone do nothing
    if (render.onKeyDown({ event: e })) return void (e.preventDefault(), e.stopPropagation()) // ↑ ↓ Enter Tab
    if (e.key === 'Backspace') query = query.slice(0, -1)
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) query += e.key
    else return close() // any other key (arrows left/right, Delete…) just closes the menu
    e.preventDefault()
    e.stopPropagation()
    render.onUpdate(props())
  }
  const onDown = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.slash-menu')) close()
  }

  function close() {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('mousedown', onDown, true)
    render.onExit()
    closeActive = null
  }

  render.onStart(props())
  document.addEventListener('keydown', onKey, true) // capture: the editor must not see these keys meanwhile
  document.addEventListener('mousedown', onDown, true)
  closeActive = close
}

export const CommandPalette = Extension.create({
  name: 'commandPalette',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          // by physical key (`code`), so it also works with the Persian layout where "/" is a letter
          handleKeyDown: (_view, e) => {
            if (editor.isEditable && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'Slash' || e.key === '/')) {
              e.preventDefault()
              openPalette(editor)
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})
