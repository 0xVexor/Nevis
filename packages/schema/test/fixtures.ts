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

// ---- sv2 (M8a): the blocks ported from the old editor. Appended AFTER the sv1 fixtures so that their ids do not move. ----
const col = (content: PMJson[], width = 0): PMJson => ({ type: 'layoutColumn', attrs: { blockId: id(), width }, content })
const lst = (items: string[]): PMJson => ({ type: 'bulletList', attrs: { blockId: id() }, content: items.map(x => ({ type: 'listItem', attrs: { blockId: id() }, content: [p([t(x)])] })) })

export const fixturesV2: Record<string, PMJson> = {
  callout: { type: 'doc', content: [{ type: 'callout', attrs: { blockId: id(), icon: 'warning' }, content: [p([t('هشدار مهم')]), lst(['یک', 'دو'])] }, { type: 'callout', attrs: { blockId: id(), icon: 'bulb' }, content: [p([t('ایده')])] }] },
  toggle: { type: 'doc', content: [{ type: 'toggle', attrs: { blockId: id(), open: true }, content: [p([t('عنوان باز')]), p([t('درون')])] }, { type: 'toggle', attrs: { blockId: id(), open: false }, content: [p([t('عنوان بسته')]), p([t('پنهان')]), lst(['الف'])] }] },
  layout: {
    type: 'doc',
    content: [
      { type: 'layoutGroup', attrs: { blockId: id(), dir: 'rtl' }, content: [col([p([t('ستون راست')])]), col([p([t('ستون چپ')]), lst(['x'])])] },
      { type: 'layoutGroup', attrs: { blockId: id(), dir: 'auto' }, content: [col([p([t('الف')])], 20), col([p([t('ب')])], 50), col([p([t('ج')])], 30)] },
    ],
  },
  math: { type: 'doc', content: [{ type: 'mathBlock', attrs: { blockId: id(), latex: 'E = mc^2 \\frac{a}{b}' } }, p([t('و درون‌خطی '), { type: 'mathInline', attrs: { latex: 'x^2' } }, t(' تمام')])] },
  mermaid: { type: 'doc', content: [{ type: 'mermaid', attrs: { blockId: id(), code: 'graph TD\n  A[شروع] --> B[پایان]' } }] },
  drawing: { type: 'doc', content: [{ type: 'drawing', attrs: { blockId: id(), scene: '{"elements":[{"type":"rectangle","x":1,"y":2}],"appState":{}}' } }] },
  image: { type: 'doc', content: [{ type: 'image', attrs: { blockId: id(), src: '', alt: 'جای عکس', title: '', width: 0, align: '', motion: '' } }, { type: 'image', attrs: { blockId: id(), src: 'https://example.com/a.png', alt: 'عکس', title: 'عنوان', width: 400, align: 'center', motion: '' } }] },
  pageLink: { type: 'doc', content: [p([t('نگاه کنید به '), { type: 'pageLink', attrs: { dstId: '01930000-0000-7000-8000-00000000abcd', label: 'صفحهٔ دیگر' } }, t('.')])] },
  alignment: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: id(), dir: 'auto', textAlign: 'center' }, content: [t('وسط')] }, { type: 'heading', attrs: { blockId: id(), dir: 'rtl', level: 2, textAlign: 'right' }, content: [t('تیتر راست')] }, { type: 'codeBlock', attrs: { blockId: id(), language: 'ts', textAlign: 'left' }, content: [t('x')] }] },
  tableLayout: { type: 'doc', content: [{ type: 'table', attrs: { blockId: id(), dir: 'rtl', tableAlign: 'center', tableWidth: 75 }, content: [{ type: 'tableRow', attrs: { blockId: id() }, content: [{ type: 'tableCell', attrs: { blockId: id(), colspan: 1, rowspan: 1, dir: 'ltr' }, content: [p([t('a')])] }] }] }] },
  containerDir: { type: 'doc', content: [{ type: 'blockquote', attrs: { blockId: id(), dir: 'rtl' }, content: [p([t('نقل')])] }, { type: 'bulletList', attrs: { blockId: id() }, content: [{ type: 'listItem', attrs: { blockId: id(), dir: 'ltr' }, content: [p([t('item')])] }] }] },
  marksV2: { type: 'doc', content: [p([t('خط‌خورده', [{ type: 'strike' }]), t(' و '), t('زیرخط', [{ type: 'underline' }])])] },
}

// ---- sv3 (M9): attachments. Appended AFTER the sv2 fixtures so that their ids do not move. ----
const H1 = 'a'.repeat(64)
const H2 = 'b0'.repeat(32)
export const fixturesV3: Record<string, PMJson> = {
  attachments: {
    type: 'doc',
    content: [
      { type: 'image', attrs: { blockId: id(), blob: H1, mime: 'image/png', size: 2048, src: '', alt: 'عکس پیوست', title: '', width: 50, align: 'center', motion: '' } },
      { type: 'file', attrs: { blockId: id(), blob: H2, name: 'گزارش.pdf', mime: 'application/pdf', size: 1048576 } },
      { type: 'drawing', attrs: { blockId: id(), scene: '', sceneBlob: H2 } },
      p([t('متن بعد از پیوست‌ها')]),
    ],
  },
}
// SV 4: resized RTL table, including a merged cell and automatic-width cells.
export const fixturesV4: Record<string, PMJson> = {
  tableColumnWidths: { type: 'doc', content: [{ type: 'table', attrs: { blockId: id(), dir: 'rtl' }, content: [
    { type: 'tableRow', attrs: { blockId: id() }, content: [
      { type: 'tableHeader', attrs: { blockId: id(), colspan: 2, colwidthJson: '[180,260]' }, content: [p([t('سرستون ادغام‌شده')])] },
    ] },
    { type: 'tableRow', attrs: { blockId: id() }, content: [
      { type: 'tableCell', attrs: { blockId: id(), colwidthJson: '[180]' }, content: [p([t('راست')])] },
      { type: 'tableCell', attrs: { blockId: id(), colwidthJson: '[260]' }, content: [p([t('چپ')])] },
    ] },
  ] }] },
  divider: { type: 'doc', content: [p([t('بخش اول')]), { type: 'horizontalRule', attrs: { blockId: id() } }, p([t('بخش دوم')])] },
}
export const allFixtures: Record<string, PMJson> = { ...fixtures, ...fixturesV2, ...fixturesV3, ...fixturesV4 }
