// The slash menu (`/`) and the page-link picker (`[[`). Ported from the old editor's slash.ts / pageLink.ts, with Persian-aware filtering.
import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { normalizeFa } from './findNormalize'
import { insertPageLink, insertCallout, insertDrawing, insertImagePlaceholder, insertLayout, insertMathBlock, insertMathInline, insertMermaid, insertTable, insertToggle } from './insert'
import { pickAndAttach } from './attach'
import { Menu, type MenuItem } from './menu'
import { optionsOf } from './options'
import { S } from './strings'

export interface SlashItem { id: string; title: string; hint: string; keywords: string; run: (editor: Editor) => void }

/** Every block the editor can insert. `id` is stable (tests and the template page use it). */
export const SLASH_ITEMS: SlashItem[] = [
  { id: 'paragraph', title: 'متن', hint: 'یک پاراگراف ساده', keywords: 'paragraph text متن پاراگراف', run: e => void e.chain().focus().setParagraph().run() },
  { id: 'h1', title: 'تیتر ۱', hint: 'تیتر بزرگ', keywords: 'heading h1 عنوان تیتر', run: e => void e.chain().focus().setHeading({ level: 1 }).run() },
  { id: 'h2', title: 'تیتر ۲', hint: 'تیتر متوسط', keywords: 'heading h2 عنوان تیتر', run: e => void e.chain().focus().setHeading({ level: 2 }).run() },
  { id: 'h3', title: 'تیتر ۳', hint: 'تیتر کوچک', keywords: 'heading h3 عنوان تیتر', run: e => void e.chain().focus().setHeading({ level: 3 }).run() },
  { id: 'bullet', title: 'فهرست نقطه‌ای', hint: 'فهرست ساده', keywords: 'bullet list لیست نقطه فهرست', run: e => void e.chain().focus().toggleBulletList().run() },
  { id: 'ordered', title: 'فهرست شماره‌دار', hint: 'فهرست مرتب', keywords: 'numbered ordered list لیست شماره', run: e => void e.chain().focus().toggleOrderedList().run() },
  { id: 'task', title: 'فهرست کارها', hint: 'کار با تیک', keywords: 'todo task check چک لیست کار تسک', run: e => void e.chain().focus().toggleTaskList().run() },
  { id: 'quote', title: 'نقل قول', hint: 'متن نقل‌شده', keywords: 'quote blockquote نقل قول', run: e => void e.chain().focus().toggleBlockquote().run() },
  { id: 'code', title: 'کد', hint: 'بلوک کد با رنگ‌بندی', keywords: 'code block کد برنامه', run: e => void e.chain().focus().toggleCodeBlock().run() },
  { id: 'table', title: 'جدول', hint: 'جدول ۳×۳', keywords: 'table جدول', run: e => void insertTable(e) },
  { id: 'callout', title: 'کادر نکته', hint: 'کادر پررنگ برای نکته یا هشدار', keywords: 'callout note tip warning نکته هشدار کادر', run: e => void insertCallout(e) },
  { id: 'toggle', title: 'بازشو', hint: 'عنوان با محتوای پنهان', keywords: 'toggle details collapse بازشو جمع', run: e => void insertToggle(e) },
  { id: 'columns2', title: 'دو ستون', hint: 'چیدمان دو ستونه', keywords: 'columns layout two 2col ستون چیدمان', run: e => void insertLayout(e, 2) },
  { id: 'columns3', title: 'سه ستون', hint: 'چیدمان سه ستونه', keywords: 'columns layout three 3col ستون چیدمان', run: e => void insertLayout(e, 3) },
  { id: 'math', title: 'فرمول', hint: 'فرمول ریاضی (LaTeX)', keywords: 'math formula latex katex فرمول ریاضی', run: e => void insertMathBlock(e) },
  { id: 'mathInline', title: 'فرمول درون‌خطی', hint: 'فرمول میان متن', keywords: 'inline math formula فرمول', run: e => void insertMathInline(e) },
  { id: 'mermaid', title: 'نمودار', hint: 'نمودار با Mermaid', keywords: 'mermaid diagram flowchart نمودار', run: e => void insertMermaid(e) },
  { id: 'drawing', title: 'نقاشی', hint: 'بوم نقاشی', keywords: 'drawing excalidraw sketch نقاشی بوم', run: e => void insertDrawing(e) },
  { id: 'image', title: 'تصویر', hint: 'تصویر از دستگاه (یا نشانی https)', keywords: 'image picture photo تصویر عکس', run: e => void (optionsOf(e).attachments ? pickAndAttach(e, true) : insertImagePlaceholder(e)) },
  { id: 'imageUrl', title: 'تصویر از اینترنت', hint: 'تصویر با نشانی https', keywords: 'image url link web تصویر نشانی اینترنت', run: e => void insertImagePlaceholder(e) },
  { id: 'file', title: 'فایل', hint: 'پیوست کردن فایل', keywords: 'file attachment pdf upload فایل پیوست', run: e => void (optionsOf(e).attachments ? pickAndAttach(e, false) : optionsOf(e).notify?.('پیوست فایل در این‌جا فعال نیست')) },
  { id: 'pageLink', title: 'پیوند به صفحه', hint: 'مثل [[', keywords: 'link page wiki لینک صفحه پیوند', run: e => void e.chain().focus().insertContent('[[').run() },
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
      if (!it) return
      ed.chain().focus().deleteRange(range).run() // its own step: the item then works from the editor's fresh state
      it.run(ed)
    })]
  },
})

export const PageLinkSuggest = Extension.create({
  name: 'pageLinkSuggest',
  addProseMirrorPlugins() {
    const ed = this.editor
    return [suggestion(ed, 'pageLinkSuggest', '[[', q => find((optionsOf(ed).pages?.() ?? []).map(p => ({ id: p.id, title: p.title || 'بدون عنوان' })), q), (editor, range, item) => {
      editor.chain().focus().deleteRange(range).run()
      insertPageLink(editor, item.id, item.title)
    })]
  },
})
