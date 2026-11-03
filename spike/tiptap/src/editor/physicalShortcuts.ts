import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { commandBinding, commandMatches } from '../shortcutCommands'
import { pickImages } from './image'
import { editLink } from './linkPrompt'
import { linkSelection } from './slash'

/** Execute editor commands directly using physical keys (event.code), so they work with any keyboard language; never replay synthetic keyboard events. */
export const PhysicalShortcuts = Extension.create({
  name: 'physicalShortcuts',
  priority: 10000,
  addProseMirrorPlugins() {
    const editor = this.editor
    const commands: Record<string, () => boolean> = {
      Bold: () => editor.commands.toggleBold(),
      Italic: () => editor.commands.toggleItalic(),
      Underline: () => editor.commands.toggleUnderline(),
      'Heading 1': () => editor.commands.toggleHeading({ level: 1 }),
      'Heading 2': () => editor.commands.toggleHeading({ level: 2 }),
      'Heading 3': () => editor.commands.toggleHeading({ level: 3 }),
      Link: () => (editLink(editor), true),
      'Link to page': () => linkSelection(editor.chain().focus(), editor).run(),
      'Insert image': () => (pickImages(editor), true),
      'Insert table': () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      'Align left': () => editor.chain().focus().setTextAlign('left').run(),
      Center: () => editor.chain().focus().setTextAlign('center').run(),
      'Align right': () => editor.chain().focus().setTextAlign('right').run(),
      Strikethrough: () => editor.commands.toggleStrike(),
      'Inline code': () => editor.commands.toggleCode(),
      'Bulleted list': () => editor.commands.toggleBulletList(),
      'Numbered list': () => editor.commands.toggleOrderedList(),
      Checklist: () => editor.commands.toggleTaskList(),
      Quote: () => editor.commands.toggleBlockquote(),
      'Code block': () => editor.commands.toggleCodeBlock(),
      'Line break': () => editor.commands.setHardBreak(),
      'Select all': () => editor.commands.selectAll(),
      Undo: () => editor.commands.undo(),
      Redo: () => editor.commands.redo(),
      'Line direction: left-to-right': () => editor.commands.setDirection('ltr'),
      'Line direction: right-to-left': () => editor.commands.setDirection('rtl'),
    }
    return [new Plugin({
      props: {
        handleKeyDown(_view, event) {
          if (!editor.isEditable || event.isComposing) return false
          for (const [label, run] of Object.entries(commands)) {
            if (commandMatches(event, label)) {
              run()
              event.preventDefault()
              return true
            }
          }
          // A remapped command must not continue firing at its former default.
          return Object.keys(commands).some(label => commandBinding(label)?.overridden && commandMatches(event, label, true))
        },
      },
    })]
  },
})
