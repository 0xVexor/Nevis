import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { normalizeFa } from '../normalize'
import { insertImageFromUrl, pickImages } from './image'
import { LANGS } from './codeBlock'
import { menuRender } from './menu'
import { looksLikeMermaid } from './mermaidText'
import { t } from '../i18n'

interface Item {
  title: string
  desc: string
  icon: string
  keywords: string
  vars?: Record<string, string> // fills {placeholders} in title/desc; values are translated too
  run: (chain: any, editor: any) => any
}

/** "Link to page": with text selected it becomes a link to the page you pick; otherwise it opens the `[[` picker. */
export function linkSelection(c: any, editor: any) {
  const { from, to, empty } = editor.state.selection
  if (!empty && editor.state.doc.textBetween(from, to, ' ').trim()) {
    window.dispatchEvent(new CustomEvent('pick-page-link', { detail: { from, to } }))
    return c
  }
  return c.insertContent('[[')
}

const ITEMS: Item[] = [
  { title: 'Text', desc: 'Write with a plain paragraph', icon: 'Aa', keywords: 'paragraph text متن پاراگراف', run: (c) => c.setParagraph() },
  { title: 'Heading 1', desc: 'Large section heading', icon: 'H1', keywords: 'heading h1 عنوان تیتر', run: (c) => c.setHeading({ level: 1 }) },
  { title: 'Heading 2', desc: 'Medium heading', icon: 'H2', keywords: 'heading h2 عنوان تیتر', run: (c) => c.setHeading({ level: 2 }) },
  { title: 'Heading 3', desc: 'Small heading', icon: 'H3', keywords: 'heading h3 عنوان تیتر', run: (c) => c.setHeading({ level: 3 }) },
  { title: 'Bulleted list', desc: 'A simple list with bullets', icon: 'i:list', keywords: 'bullet list لیست نقطه', run: (c) => c.toggleBulletList() },
  { title: 'Numbered list', desc: 'An ordered list with numbers', icon: 'i:ol', keywords: 'numbered ordered list لیست شماره', run: (c) => c.toggleOrderedList() },
  { title: 'Checklist', desc: 'Track tasks with checkboxes', icon: 'i:check', keywords: 'todo task check چک لیست کار', run: (c) => c.toggleTaskList() },
  { title: 'Link to page', desc: 'Link to another page (same as [[ — no bracket key needed)', icon: 'i:link', keywords: 'link page wiki backlink لینک صفحه پیوند', run: (c, editor) => linkSelection(c, editor) },
  { title: 'Callout', desc: 'Highlighted box for a tip or warning', icon: 'i:callout', keywords: 'callout note tip warning نکته هشدار کادر', run: (c) => c.insertContent({ type: 'callout', content: [{ type: 'paragraph' }] }) },
  { title: 'Toggle', desc: 'A collapsible section', icon: 'i:toggle', keywords: 'toggle collapse details accordion جمع باز', run: (c) => c.insertContent({ type: 'toggle', attrs: { open: true }, content: [{ type: 'paragraph' }] }) },
  { title: 'Diagram (Mermaid)', desc: 'Flowcharts, UML, sequences and more from text', icon: 'i:diagram', keywords: 'mermaid diagram flowchart uml sequence graph نمودار فلوچارت', run: (c) => c.insertContent({ type: 'mermaid', attrs: { code: '' } }) },
  { title: 'Database', desc: 'A table, board, calendar or other view of items', icon: 'i:table', keywords: 'database table board calendar list gallery پایگاه داده جدول برد تقویم', run: (c, editor) => (void import('./databaseEmbed').then((m) => m.insertDatabase(editor)), c) },
  { title: 'Drawing', desc: 'Sketch, draw shapes and arrows on a whiteboard', icon: 'i:pencil', keywords: 'drawing whiteboard sketch canvas excalidraw draw نقاشی بوم طراحی ترسیم', run: (c) => c.insertContent({ type: 'drawing' }) },
  { title: 'Formula (block)', desc: 'LaTeX math on its own line', icon: '∑', keywords: 'math latex formula equation فرمول ریاضی', run: (c) => c.insertContent({ type: 'mathBlock', attrs: { latex: '' } }) },
  { title: 'Formula (inline)', desc: 'A small formula inside a sentence, or type $x$', icon: 'x²', keywords: 'math inline latex formula فرمول ریاضی', run: (c) => c.insertContent({ type: 'mathInline', attrs: { latex: '' } }) },
  { title: 'Quote', desc: 'Highlight a sentence', icon: 'i:quote', keywords: 'quote نقل قول', run: (c) => c.toggleBlockquote() },
  { title: 'Code block', desc: 'Code with syntax highlighting', icon: 'i:code', keywords: 'code کد برنامه', run: (c) => c.toggleCodeBlock() },
  ...LANGS.map((l) => ({
    title: 'Code {name}',
    desc: 'Code block with {name} highlighting',
    vars: { name: l.name },
    icon: 'i:code',
    keywords: `code کد ${l.id} ${l.alias} ${l.name}`,
    run: (c: any) => c.setCodeBlock({ language: l.id }),
  })),
  { title: 'Icon', desc: 'An icon inside the text, in any colour', icon: 'i:star', keywords: 'icon symbol emoji glyph آیکون نماد ایموجی', run: (c) => (window.dispatchEvent(new Event('pick-inline-icon')), c) },
  { title: 'Table', desc: '3×3 table with a header row', icon: 'i:table', keywords: 'table جدول', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { title: 'Image', desc: 'Add a picture from your device', icon: 'i:image', keywords: 'image picture photo upload تصویر عکس', run: (c, ed) => (pickImages(ed), c) },
  { title: 'Image from link', desc: 'Add a picture from a web address (saved for offline use)', icon: 'i:link', keywords: 'image url link web picture photo تصویر لینک آدرس اینترنت', run: (c, ed) => (insertImageFromUrl(ed), c) },
  { title: 'Divider', desc: 'Separate sections', icon: 'i:divider', keywords: 'divider hr line خط جدا', run: (c) => c.setHorizontalRule() },
  { title: 'Right-to-left (RTL)', desc: 'Make this line right-to-left', icon: 'i:dir', keywords: 'rtl direction right to left جهت راست چین', run: (c) => c.setDirection('rtl') },
  { title: 'Left-to-right (LTR)', desc: 'Make this line left-to-right', icon: 'i:dir', keywords: 'ltr direction left to right جهت چپ چین', run: (c) => c.setDirection('ltr') },
  { title: 'Auto direction', desc: 'Detect direction from the text', icon: 'i:dir', keywords: 'auto direction خودکار جهت', run: (c) => c.setDirection('auto') },
]

const shown = (i: Item) => {
  const vars = i.vars && Object.fromEntries(Object.entries(i.vars).map(([k, v]) => [k, t(v)]))
  return { ...i, title: t(i.title, vars), desc: t(i.desc, vars) }
}

function filter(query: string, list: Item[] = ITEMS): Item[] {
  const q = normalizeFa(query).trim()
  if (!q) return list
  // match what the user sees (translated) as well as the English source and the keywords
  const inTitle = (i: Item) => Number(normalizeFa(shown(i).title).includes(q))
  return list.filter((i) => normalizeFa(`${shown(i).title} ${i.title} ${i.keywords}`).includes(q)).sort((a, b) => inTitle(b) - inTitle(a))
}

// ───────────── Ctrl+/ palette (see commandPalette.ts) ─────────────
export type CommandItem = Item
export const shownItem = shown

/** Items that put something new into the page: with a selection they go after it instead of replacing it. */
export const INSERTS = new Set(['Icon', 'Table', 'Divider', 'Image', 'Image from link', 'Formula (block)', 'Formula (inline)', 'Diagram (Mermaid)'])

/**
 * What the Ctrl+/ palette offers: everything of the slash menu, and with text selected also actions on it
 * (wrap in a callout / toggle, turn Mermaid text into a diagram) listed first.
 */
export function paletteItems(query: string, editor: any): Item[] {
  const sel = editor.state.selection
  let list = ITEMS
  if (!sel.empty) {
    const { $from, $to } = sel
    const from = $from.depth >= 1 ? $from.before(1) : $from.pos
    const to = $to.depth >= 1 ? $to.after(1) : $to.pos
    const code = editor.state.doc.textBetween(from, to, '\n', ' ').trim()
    const onSelection: Item[] = [
      { title: 'Wrap in callout', desc: 'Put the selection in a highlighted box', icon: 'i:callout', keywords: 'callout wrap note box کادر نکته', run: (c) => c.wrapIn('callout') },
      { title: 'Wrap in toggle', desc: 'Put the selection in a collapsible section', icon: 'i:toggle', keywords: 'toggle wrap collapse جمع باز', run: (c) => c.wrapIn('toggle') },
    ]
    if (looksLikeMermaid(code))
      onSelection.unshift({ title: 'Turn selection into diagram', desc: 'Draw the selected Mermaid text', icon: 'i:diagram', keywords: 'mermaid diagram convert نمودار تبدیل', run: (c) => c.insertContentAt({ from, to }, { type: 'mermaid', attrs: { code } }) })
    // the plain Callout / Toggle entries would insert empty boxes; with a selection the wrapping versions replace them
    list = [...onSelection, ...ITEMS.filter((i) => i.title !== 'Callout' && i.title !== 'Toggle')]
  }
  return filter(query, list)
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('slashSuggest'),
        // a "/" typed in code (`a / b`, paths, comments) is just a slash
        allow: ({ state }: any) => {
          const $from = state.selection.$from
          return $from.parent.type.name !== 'codeBlock' && !$from.marks().some((m: any) => m.type.name === 'code')
        },
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }: any) => filter(query),
        command: ({ editor, range, props }: any) => {
          props.run(editor.chain().focus().deleteRange(range), editor).run()
        },
        render: menuRender<Item>({ label: t('Blocks'), view: shown }),
      }),
    ]
  },
})
