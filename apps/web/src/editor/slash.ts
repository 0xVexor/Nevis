// Reference slash menu, connected to the new editor and attachment ports.
import type { ChainedCommands } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import type { Editor, Range } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { normalizeFa, SLASH_ITEMS, attachFiles, safeImageSrc, insertBlock } from '@nevis/editor'
import { alertDialog, promptDialog } from '../dialog'
export const pickImages = (editor: Editor) => SLASH_ITEMS.find(i => i.id === 'image')?.run(editor)
export async function insertImageFromUrl(editor: Editor) {
  const input = await promptDialog({ title: t('Image from the web'), message: t('Image address (URL):'), placeholder: 'https://', ltr: true })
  if (input === null || editor.isDestroyed || !editor.isEditable) return false
  const src = safeImageSrc(input.trim())
  if (!src) { await alertDialog({ title: t('This address is not allowed') }); return false }
  return insertBlock(editor, { type: 'image', attrs: { src } })
}
import { LANGS } from './languages'
import { menuRender } from './menu'
import { looksLikeMermaid } from '@nevis/editor'
import { t } from '../i18n'
import { slashPreview } from './slashPreview'


interface Item {
  title: string
  desc: string
  icon: string
  keywords: string
  disabled?: boolean
  check?: boolean
  literalTitle?: boolean
  vars?: Record<string, string> // fills {placeholders} in title/desc; values are translated too
  run: (chain: ChainedCommands, editor: Editor) => ChainedCommands
}

/** "Link to page": with text selected it becomes a link to the page you pick; otherwise it opens the `[[` picker. */
export function linkSelection(c: ChainedCommands, editor: Editor) {
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
  {
    title: 'Link to page',
    desc: 'Link to another page (same as [[ — no bracket key needed)',
    icon: 'i:link',
    keywords: 'link page wiki backlink لینک صفحه پیوند',
    run: (c, editor) => linkSelection(c, editor),
  },
  {
    title: 'Callout',
    desc: 'Highlighted box for a tip or warning',
    icon: 'i:callout',
    keywords: 'callout note tip warning نکته هشدار کادر',
    run: (c) => c.insertContent({ type: 'callout', content: [{ type: 'paragraph' }] }),
  },
  {
    title: 'Toggle',
    desc: 'A collapsible section',
    icon: 'i:toggle',
    keywords: 'toggle collapse details accordion جمع باز',
    run: (c) => c.insertContent({ type: 'toggle', attrs: { open: true }, content: [{ type: 'paragraph' }] }),
  },
  {
    title: 'Diagram (Mermaid)',
    desc: 'Flowcharts, UML, sequences and more from text',
    icon: 'i:diagram',
    keywords: 'mermaid diagram flowchart uml sequence graph نمودار فلوچارت',
    run: (c) => c.insertContent({ type: 'mermaid', attrs: { code: '' } }),
  },
  {
    title: 'Drawing',
    desc: 'Sketch, draw shapes and arrows on a whiteboard',
    icon: 'i:pencil',
    keywords: 'drawing whiteboard sketch canvas excalidraw draw نقاشی بوم طراحی ترسیم',
    run: (c) => c.insertContent({ type: 'drawing' }),
  },
  {
    title: 'Formula (block)',
    desc: 'LaTeX math on its own line',
    icon: '∑',
    keywords: 'math latex formula equation فرمول ریاضی',
    run: (c) => c.insertContent({ type: 'mathBlock', attrs: { latex: '' } }),
  },
  {
    title: 'Formula (inline)',
    desc: 'A small formula inside a sentence, or type $x$',
    icon: 'x²',
    keywords: 'math inline latex formula فرمول ریاضی',
    run: (c) => c.insertContent({ type: 'mathInline', attrs: { latex: '' } }),
  },
  { title: 'Quote', desc: 'Highlight a sentence', icon: 'i:quote', keywords: 'quote نقل قول', run: (c) => c.toggleBlockquote() },
  { title: 'Code block', desc: 'Code with syntax highlighting', icon: 'i:code', keywords: 'code کد برنامه', run: (c) => c.toggleCodeBlock() },
  ...LANGS.map((l) => ({
    title: 'Code {name}',
    desc: 'Code block with {name} highlighting',
    vars: { name: l.name },
    icon: 'i:code',
    keywords: `code کد ${l.id} ${l.alias} ${l.name}`,
    run: (c: ChainedCommands) => c.setCodeBlock({ language: l.id }),
  })),
  { title: 'Table', desc: '3×3 table with a header row', icon: 'i:table', keywords: 'table جدول', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { title: 'Image', desc: 'Add a picture from your device', icon: 'i:image', keywords: 'image picture photo upload تصویر عکس', run: (c, ed) => (pickImages(ed), c) },
  {
    title: 'Image from link',
    desc: 'Add a picture from a web address',
    icon: 'i:link',
    keywords: 'image url link web picture photo تصویر لینک آدرس اینترنت',
    run: (c, ed) => (insertImageFromUrl(ed), c),
  },
  { title: 'File', desc: 'Attach a file', icon: 'i:file', keywords: 'file attachment pdf upload فایل پیوست', run: (c, ed) => (SLASH_ITEMS.find(i => i.id === 'file')?.run(ed), c) },
  { title: 'Divider', desc: 'Separate sections', icon: 'i:divider', keywords: 'divider hr line خط جدا', run: c => c.setHorizontalRule() },
  { title: 'Two columns', desc: 'Write in two columns', icon: 'i:columns', keywords: 'columns layout two 2col ستون چیدمان دو', run: c => c.insertLayout(2) },
  { title: 'Three columns', desc: 'Write in three columns', icon: 'i:columns', keywords: 'columns layout three 3col ستون چیدمان سه', run: c => c.insertLayout(3) },
  { title: 'Right-to-left (RTL)', desc: 'Make this line right-to-left', icon: 'i:dir', keywords: 'rtl direction right to left جهت راست چین', run: (c) => c.setDirection('rtl') },
  { title: 'Left-to-right (LTR)', desc: 'Make this line left-to-right', icon: 'i:dir', keywords: 'ltr direction left to right جهت چپ چین', run: (c) => c.setDirection('ltr') },
  { title: 'Auto direction', desc: 'Detect direction from the text', icon: 'i:dir', keywords: 'auto direction خودکار جهت', run: (c) => c.setDirection('auto') },
]

const GROUPS = [
  ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Quote', 'Callout', 'Toggle', 'Divider'],
  ['Bulleted list', 'Numbered list', 'Checklist'],
  ['Link to page', 'Icon', 'Image', 'Image from link', 'Drawing', 'File'],
  ['Table', 'Database', 'Two columns', 'Three columns'],
  ['Code block', 'Diagram (Mermaid)', 'Formula (block)', 'Formula (inline)'],
  ['Right-to-left (RTL)', 'Left-to-right (LTR)', 'Auto direction'],
]
const GROUP_LABELS = ['Text', 'Lists', 'Media', 'Databases', 'Code and math', 'Text direction']
const rank = (item: Item) => {
  const group = GROUPS.findIndex(items => items.includes(item.title))
  return group < 0 ? GROUPS.length * 100 : group * 100 + GROUPS[group]!.indexOf(item.title)
}

const shown = (i: Item) => {
  const vars = i.vars && Object.fromEntries(Object.entries(i.vars).map(([k, v]) => [k, t(v)]))
  return { ...i, group: GROUP_LABELS[Math.floor(rank(i) / 100)], title: i.literalTitle ? i.title : t(i.title, vars), desc: t(i.desc, vars) }
}

function filter(query: string, list: Item[] = ITEMS): Item[] {
  const q = normalizeFa(query).trim()
  if (!q) return list.filter(i => i.title !== 'Code {name}').sort((a, b) => rank(a) - rank(b))
  // match what the user sees (translated) as well as the English source and the keywords
  const inTitle = (i: Item) => Number(normalizeFa(shown(i).title).startsWith(q))
  return list.filter(i => q.split(/\s+/).every(word => normalizeFa(`${shown(i).title} ${shown(i).desc} ${i.title} ${i.keywords}`).includes(word))).sort((a, b) => inTitle(b) - inTitle(a) || rank(a) - rank(b))
}

export const previewOf = (i: Item) => slashPreview(i.title, i.vars?.name)

// ───────────── Ctrl+/ palette (see commandPalette.ts) ─────────────
export type CommandItem = Item
export const shownItem = shown
export const editorSearchItems = () => [...ITEMS].sort((a, b) => rank(a) - rank(b)).map(item => ({ item, ...shown(item), searchOnly: item.title === 'Code {name}' }))

/** Items that put something new into the page: with a selection they go after it instead of replacing it. */
export const INSERTS = new Set(['Icon', 'Table', 'Divider', 'Image', 'Image from link', 'Formula (block)', 'Formula (inline)', 'Diagram (Mermaid)'])

/**
 * What the Ctrl+/ palette offers: everything of the slash menu, and with text selected also actions on it
 * (wrap in a callout / toggle, turn Mermaid text into a diagram) listed first.
 */
export function paletteItems(query: string, editor: Editor, extraCommands?: ExtraCommands, allowedCommands: readonly string[] | null = null): Item[] {
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
      onSelection.unshift({
        title: 'Turn selection into diagram',
        desc: 'Draw the selected Mermaid text',
        icon: 'i:diagram',
        keywords: 'mermaid diagram convert نمودار تبدیل',
        run: (c) => c.insertContentAt({ from, to }, { type: 'mermaid', attrs: { code } }),
      })
    // the plain Callout / Toggle entries would insert empty boxes; with a selection the wrapping versions replace them
    list = [...onSelection, ...ITEMS.filter((i) => i.title !== 'Callout' && i.title !== 'Toggle')]
  }
  return filter(query, [...list.filter(item => !allowedCommands || allowedCommands.includes(item.title)), ...(extraCommands?.(editor) ?? [])])
}

export type ExtraCommands = (editor: Editor) => Item[]
export const SlashCommand = Extension.create<{ allowedCommands: readonly string[] | null; extraCommands?: ExtraCommands }>({
  name: 'slashMenu',
  addOptions() {
    return { allowedCommands: null }
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('slashSuggest'),
        // a "/" typed in code (`a / b`, paths, comments) is just a slash
        allow: ({ state, editor }: { state: EditorState; editor: Editor }) => {
          const $from = state.selection.$from
          return editor.isEditable && $from.parent.type.name !== 'codeBlock' && !$from.marks().some((m) => m.type.name === 'code')
        },
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        items: ({ query, editor }) => filter(query, [
          ...ITEMS.filter(item => !this.options.allowedCommands || this.options.allowedCommands.includes(item.title)),
          ...(this.options.extraCommands?.(editor) ?? []),
        ]),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: Item }) => {
          if (props.disabled) return
          editor.chain().focus().deleteRange(range).run()
          props.run(editor.chain().focus(), editor).run()
        },
        render: menuRender<Item>({ label: t('Blocks'), view: shown, preview: previewOf }),
      }),
    ]
  },
})
