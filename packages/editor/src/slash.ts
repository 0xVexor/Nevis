// The slash menu (`/`) and the page-link picker (`[[`). Ported from the old editor's slash.ts / pageLink.ts, with Persian-aware filtering.
import type { ChainedCommands, Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { normalizeFa } from './findNormalize'
import { Menu, type MenuItem } from './menu'
import { optionsOf } from './options'
import { S } from './strings'

export interface SlashItem { id: string; title: string; hint: string; keywords: string; run: (c: ChainedCommands, editor: Editor) => ChainedCommands }

/** Every block the editor can insert. `id` is stable (tests and the template page use it). */
export const SLASH_ITEMS: SlashItem[] = [
  { id: 'paragraph', title: 'متن', hint: 'یک پاراگراف ساده', keywords: 'paragraph text متن پاراگراف', run: c => c.setParagraph() },
  { id: 'h1', title: 'تیتر ۱', hint: 'تیتر بزرگ', keywords: 'heading h1 عنوان تیتر', run: c => c.setHeading({ level: 1 }) },
  { id: 'h2', title: 'تیتر ۲', hint: 'تیتر متوسط', keywords: 'heading h2 عنوان تیتر', run: c => c.setHeading({ level: 2 }) },
  { id: 'h3', title: 'تیتر ۳', hint: 'تیتر کوچک', keywords: 'heading h3 عنوان تیتر', run: c => c.setHeading({ level: 3 }) },
  { id: 'bullet', title: 'فهرست نقطه‌ای', hint: 'فهرست ساده', keywords: 'bullet list لیست نقطه فهرست', run: c => c.toggleBulletList() },
  { id: 'ordered', title: 'فهرست شماره‌دار', hint: 'فهرست مرتب', keywords: 'numbered ordered list لیست شماره', run: c => c.toggleOrderedList() },
  { id: 'task', title: 'فهرست کارها', hint: 'کار با تیک', keywords: 'todo task check چک لیست کار تسک', run: c => c.toggleTaskList() },
  { id: 'quote', title: 'نقل قول', hint: 'متن نقل‌شده', keywords: 'quote blockquote نقل قول', run: c => c.toggleBlockquote() },
  { id: 'code', title: 'کد', hint: 'بلوک کد با رنگ‌بندی', keywords: 'code block کد برنامه', run: c => c.toggleCodeBlock() },
  { id: 'table', title: 'جدول', hint: 'جدول ۳×۳', keywords: 'table جدول', run: c => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { id: 'callout', title: 'کادر نکته', hint: 'کادر پررنگ برای نکته یا هشدار', keywords: 'callout note tip warning نکته هشدار کادر', run: c => c.insertCallout() },
  { id: 'toggle', title: 'بازشو', hint: 'عنوان با محتوای پنهان', keywords: 'toggle details collapse بازشو جمع', run: c => c.insertToggle() },
  { id: 'columns2', title: 'دو ستون', hint: 'چیدمان دو ستونه', keywords: 'columns layout two 2col ستون چیدمان', run: c => c.insertLayout(2) },
  { id: 'columns3', title: 'سه ستون', hint: 'چیدمان سه ستونه', keywords: 'columns layout three 3col ستون چیدمان', run: c => c.insertLayout(3) },
  { id: 'math', title: 'فرمول', hint: 'فرمول ریاضی (LaTeX)', keywords: 'math formula latex katex فرمول ریاضی', run: c => c.insertMathBlock() },
  { id: 'mathInline', title: 'فرمول درون‌خطی', hint: 'فرمول میان متن', keywords: 'inline math formula فرمول', run: c => c.insertMathInline() },
  { id: 'mermaid', title: 'نمودار', hint: 'نمودار با Mermaid', keywords: 'mermaid diagram flowchart نمودار', run: c => c.insertMermaid() },
  { id: 'drawing', title: 'نقاشی', hint: 'بوم نقاشی', keywords: 'drawing excalidraw sketch نقاشی بوم', run: c => c.insertDrawing() },
  { id: 'image', title: 'تصویر', hint: 'تصویر با نشانی https', keywords: 'image picture photo تصویر عکس', run: c => c.insertImagePlaceholder() },
  { id: 'pageLink', title: 'پیوند به صفحه', hint: 'مثل [[', keywords: 'link page wiki لینک صفحه پیوند', run: c => c.insertContent('[[') },
]

const find = <T extends { title: string; keywords?: string }>(items: T[], query: string): T[] => {
  const q = normalizeFa(query).trim()
  return q ? items.filter(i => normalizeFa(`${i.title} ${i.keywords ?? ''}`).includes(q)) : items
}

function suggestion(editor: Editor, name: string, char: string, source: (query: string) => MenuItem[], pick: (editor: Editor, range: { from: number; to: number }, item: MenuItem) => void) {
  return Suggestion<MenuItem, MenuItem>({
    editor, char, pluginKey: new PluginKey(name), allowSpaces: char === '[[', startOfLine: false,
    allow: ({ state }) => state.selection.$from.parent.type.name !== 'codeBlock',
    items: ({ query }) => source(query).slice(0, 30),
    command: ({ editor: ed, range, props }) => pick(ed, range, props),
    // one menu per suggestion session, removed when it ends: nothing is left behind in the page (no stale menu of a closed editor)
    render: () => {
      const menu = new Menu(S.slash.empty)
      return {
        onStart: p => menu.show(p.items, p.clientRect?.() ?? null, it => p.command(it)),
        onUpdate: p => menu.show(p.items, p.clientRect?.() ?? null, it => p.command(it)),
        onKeyDown: p => menu.key(p.event),
        onExit: () => menu.destroy(),
      }
    },
  })
}

export const SlashMenu = Extension.create({
  name: 'slashMenu',
  addProseMirrorPlugins() {
    return [suggestion(this.editor, 'slash', '/', q => find(SLASH_ITEMS, q).map(i => ({ id: i.id, title: i.title, hint: i.hint })), (ed, range, item) => {
      const it = SLASH_ITEMS.find(x => x.id === item.id)
      if (it) it.run(ed.chain().focus().deleteRange(range), ed).run()
    })]
  },
})

export const PageLinkSuggest = Extension.create({
  name: 'pageLinkSuggest',
  addProseMirrorPlugins() {
    const ed = this.editor
    return [suggestion(ed, 'pageLinkSuggest', '[[', q => find((optionsOf(ed).pages?.() ?? []).map(p => ({ id: p.id, title: p.title || 'بدون عنوان' })), q), (editor, range, item) => {
      editor.chain().focus().deleteRange(range).insertPageLink(item.id, item.title).run()
    })]
  },
})
