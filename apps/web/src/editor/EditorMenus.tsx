import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Icon, Popover, useMenu, type MenuItem } from '../ds'
import { t } from '../i18n'
import { commandHint } from '../shortcutCommands'
import { shortcutLabel } from '../shortcuts'
import { PageLinkPicker } from '../PageLinkPicker'
import { legacyPages } from '../shell/adapt'
import type { Workspace } from '../workspace'

/** Clipboard, formatting and page actions use the same menu as the reference app. */
export function EditorMenus({ editor, ws, id, row = false }: { editor: Editor; ws: Workspace; id: string; row?: boolean }) {
  const { open, menu } = useMenu()
  const [link, setLink] = useState<{ rect: DOMRect; from: number; to: number; text: string; doc: Editor['state']['doc'] } | null>(null)
  useEffect(() => {
    const dom = editor.view.dom
    const clipboardFailed = () => ws.notify(t('Could not access the clipboard. Use the keyboard shortcut instead.'))
    const paste = async (plain: boolean) => {
      if (!editor.isEditable) return
      try {
        editor.commands.focus()
        if (!plain) {
          const data = new DataTransfer()
          for (const item of await navigator.clipboard.read()) {
            for (const type of item.types) {
              if (type === 'text/html' || type === 'text/plain') data.setData(type, await (await item.getType(type)).text())
              else if (type.startsWith('image/')) data.items.add(new File([await item.getType(type)], 'clipboard-image', { type }))
            }
          }
          const event = new ClipboardEvent('paste', { clipboardData: data })
          if (data.getData('text/html') || data.files.length) {
            editor.view.pasteHTML(data.getData('text/html'), event)
            return
          }
          if (data.getData('text/plain')) { editor.view.pasteText(data.getData('text/plain'), event); return }
        }
        editor.view.pasteText(await navigator.clipboard.readText())
      } catch { clipboardFailed() }
    }
    const context = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea')) return
      event.preventDefault()
      const cell = (event.target as HTMLElement).closest('td, th')
      if (cell && !cell.classList.contains('selectedCell')) {
        const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (position) editor.commands.setTextSelection(position.pos)
      }
      const picked = !editor.state.selection.empty
      const rect = new DOMRect(event.clientX, event.clientY, 0, 0)
      const chain = () => editor.chain().focus()
      const clipboard = (action: 'copy' | 'cut') => { if (!document.execCommand(action)) clipboardFailed() }
      const copy: MenuItem[] = picked ? [{ label: 'Copy', icon: <Icon name="copy" />, hint: shortcutLabel(['Mod', 'C']), onSelect: () => clipboard('copy') }] : []
      open([
        ...(editor.isEditable ? [
          { label: 'Undo', icon: <Icon name="undo" />, hint: commandHint('Undo'), onSelect: () => { chain().undo().run() } },
          { label: 'Redo', icon: <Icon name="redo" />, hint: commandHint('Redo'), onSelect: () => { chain().redo().run() } },
          { kind: 'sep' as const },
          ...(picked ? [{ label: 'Cut', icon: <Icon name="scissors" />, hint: shortcutLabel(['Mod', 'X']), onSelect: () => clipboard('cut') }] : []),
          ...copy,
          { label: 'Paste', icon: <Icon name="clipboard" />, hint: shortcutLabel(['Mod', 'V']), onSelect: () => void paste(false) },
          { label: 'Paste as plain text', hint: shortcutLabel(['Mod', 'Shift', 'V']), onSelect: () => void paste(true) },
          { kind: 'sep' as const },
          ...(picked ? [{ label: 'Format', icon: <Icon name="bold" />, items: [
            { label: 'Bold', hint: commandHint('Bold'), icon: <Icon name="bold" />, onSelect: () => { chain().toggleBold().run() } },
            { label: 'Italic', hint: commandHint('Italic'), icon: <Icon name="italic" />, onSelect: () => { chain().toggleItalic().run() } },
            { label: 'Underline', hint: commandHint('Underline'), icon: <Icon name="underline" />, onSelect: () => { chain().toggleUnderline().run() } },
            { label: 'Strikethrough', hint: commandHint('Strikethrough'), icon: <Icon name="strikethrough" />, onSelect: () => { chain().toggleStrike().run() } },
            { label: 'Code', hint: commandHint('Inline code'), icon: <Icon name="code" />, onSelect: () => { chain().toggleCode().run() } },
            { label: 'Quote', hint: commandHint('Quote'), icon: <Icon name="quote" />, onSelect: () => { chain().toggleBlockquote().run() } },
          ] }] : []),
          ...(cell && editor.isActive('table') ? [{ label: 'Table', icon: <Icon name="table" />, items: [
            { label: 'Insert row above', onSelect: () => { chain().addRowBefore().run() } },
            { label: 'Insert row below', onSelect: () => { chain().addRowAfter().run() } },
            { label: 'Insert column before', onSelect: () => { chain().addColumnBefore().run() } },
            { label: 'Insert column after', onSelect: () => { chain().addColumnAfter().run() } },
            { kind: 'sep' as const },
            { label: 'Merge cells', disabled: !editor.can().mergeCells(), onSelect: () => { chain().mergeCells().run() } },
            { label: 'Split cell', disabled: !editor.can().splitCell(), onSelect: () => { chain().splitCell().run() } },
            { kind: 'sep' as const },
            { label: 'Delete row', danger: true, onSelect: () => { chain().deleteRow().run() } },
            { label: 'Delete column', danger: true, onSelect: () => { chain().deleteColumn().run() } },
          ] }] : []),
          { label: 'Move to…', hint: commandHint('Move to…'), icon: <Icon name="move" />, onSelect: () => dom.dispatchEvent(new CustomEvent('layout-move-menu', { detail: rect })) },
          { label: 'Convert $…$ to formulas', icon: <Icon name="sigma" />, onSelect: () => { editor.commands.convertFormulas() } },
        ] : copy),
        { label: 'Select all', hint: commandHint('Select all'), onSelect: () => { chain().selectAll().run() } },
        { kind: 'sep' },
        { label: 'Find in page', icon: <Icon name="search" />, hint: commandHint('Find in page'), onSelect: () => dom.dispatchEvent(new Event('nevis:find-open')) },
        ...(!row ? [
          { label: 'History', icon: <Icon name="history" />, onSelect: () => window.dispatchEvent(new Event('open-history')) },
          { label: 'Reader mode', hint: commandHint('Reader mode'), icon: <Icon name="book" />, onSelect: () => window.dispatchEvent(new Event('toggle-reader')) },
        ] : []),
        { label: 'Print / PDF', icon: <Icon name="printer" />, onSelect: () => window.print() },
      ], rect)
    }
    const pickPage = (event: Event) => {
      if (!editor.isEditable || editor.isDestroyed || !editor.isFocused) return
      const { from, to } = (event as CustomEvent<{ from: number; to: number }>).detail
      const c = editor.view.coordsAtPos(to)
      setLink({ rect: new DOMRect(c.left, c.top, 0, c.bottom - c.top), from, to, text: editor.state.doc.textBetween(from, to, ' '), doc: editor.state.doc })
    }
    dom.addEventListener('contextmenu', context)
    window.addEventListener('pick-page-link', pickPage)
    return () => { dom.removeEventListener('contextmenu', context); window.removeEventListener('pick-page-link', pickPage) }
  }, [editor, ws, open, row])
  const pick = async (target: string | null, title?: string) => {
    const selected = link
    setLink(null)
    if (!selected || editor.isDestroyed || !editor.isEditable || editor.state.doc !== selected.doc) return
    try {
      const destination = target ?? await ws.newPage('', title || selected.text)
      if (editor.isDestroyed || !editor.isEditable || editor.state.doc !== selected.doc) return
      editor.chain().focus().insertContentAt({ from: selected.from, to: selected.to }, { type: 'pageLink', attrs: { dstId: destination, label: selected.text } }).run()
    } catch { ws.notify(t('Could not complete the action. Please try again.')) }
  }
  return <>{menu}{link && <Popover anchor={link.rect} onClose={() => setLink(null)}><PageLinkPicker allPages={legacyPages(ws)} text={link.text} currentId={id} onPick={(target, title) => void pick(target, title)} /></Popover>}</>
}
