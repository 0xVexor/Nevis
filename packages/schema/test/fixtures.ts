import type { PMJson } from '../src'

let n = 0
/** Deterministic, valid UUIDv7-shaped ids for fixtures. */
export const id = () => `01930000-0000-7000-8000-${String(++n).padStart(12, '0')}`
const t = (text: string, marks?: PMJson['marks']): PMJson => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = (content: PMJson[], dir = 'auto'): PMJson => ({ type: 'paragraph', attrs: { blockId: id(), dir }, content })

export const fixtures: Record<string, PMJson> = {
  persian: { type: 'doc', content: [p([t('سلام دنیا، این یک یادداشت فارسی است.')])] },
  mixed: { type: 'doc', content: [p([t('نسخهٔ 3 از Nevis در تاریخ ۱۴۰۵/۰۸/۳۰ منتشر شد؛ نیم‌فاصله و ZWNJ حفظ می‌شود: می‌خواهم.')])] },
  directions: { type: 'doc', content: [p([t('auto direction')], 'auto'), p([t('راست‌به‌چپ')], 'rtl'), p([t('left to right')], 'ltr')] },
  headings: { type: 'doc', content: [1, 2, 3].map(level => ({ type: 'heading', attrs: { level, blockId: id(), dir: level === 2 ? 'rtl' : 'auto' }, content: [t(`تیتر ${level}`)] })) },
  lists: {
    type: 'doc',
    content: [
      { type: 'bulletList', attrs: { blockId: id() }, content: [{ type: 'listItem', attrs: { blockId: id() }, content: [p([t('یک')]), { type: 'bulletList', attrs: { blockId: id() }, content: [{ type: 'listItem', attrs: { blockId: id() }, content: [p([t('تو در تو')])] }] }] }] },
      { type: 'orderedList', attrs: { blockId: id(), start: 3 }, content: [{ type: 'listItem', attrs: { blockId: id() }, content: [p([t('سه')])] }] },
    ],
  },
  tasks: { type: 'doc', content: [{ type: 'taskList', attrs: { blockId: id() }, content: [{ type: 'taskItem', attrs: { blockId: id(), checked: true, due: '2026-12-01' }, content: [p([t('انجام شده')])] }, { type: 'taskItem', attrs: { blockId: id(), checked: false, due: '' }, content: [p([t('هنوز نه')])] }] }] },
  quoteAndCode: { type: 'doc', content: [{ type: 'blockquote', attrs: { blockId: id() }, content: [p([t('نقل قول')])] }, { type: 'codeBlock', attrs: { blockId: id(), language: 'ts' }, content: [t('const x = 1')] }, { type: 'codeBlock', attrs: { blockId: id(), language: '' }, content: [t('plain')] }] },
  marks: { type: 'doc', content: [p([t('پررنگ', [{ type: 'bold' }]), t(' و '), t('کج', [{ type: 'italic' }]), t(' و '), t('code', [{ type: 'code' }]), t(' و '), t('پیوند', [{ type: 'link', attrs: { href: 'https://example.com', target: '', rel: '', class: '' } }])])] },
  hardBreak: { type: 'doc', content: [p([t('خط اول'), { type: 'hardBreak' }, t('خط دوم')])] },
  rtlTable: {
    type: 'doc',
    content: [
      {
        type: 'table',
        attrs: { blockId: id(), dir: 'rtl' },
        content: [
          { type: 'tableRow', attrs: { blockId: id() }, content: [{ type: 'tableHeader', attrs: { blockId: id(), colspan: 2, rowspan: 1 }, content: [p([t('عنوان ادغام‌شده')])] }] },
          { type: 'tableRow', attrs: { blockId: id() }, content: [{ type: 'tableCell', attrs: { blockId: id(), colspan: 1, rowspan: 1 }, content: [p([t('الف')])] }, { type: 'tableCell', attrs: { blockId: id(), colspan: 1, rowspan: 1 }, content: [p([t('ب')], 'ltr')] }] },
        ],
      },
    ],
  },
}
