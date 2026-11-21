// The "all blocks" page: one of every block, in Persian, used as a template and as the demo page of M8a. A NEW page with a NEW id is the
// one place a document may be built from JSON (ADR-0003 §7); block ids are left empty and assigned by the identity plugin.
type J = { type: string; attrs?: Record<string, unknown>; content?: J[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }
const t = (text: string, marks?: J['marks']): J => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = (...c: (J | string)[]): J => ({ type: 'paragraph', content: c.map(x => (typeof x === 'string' ? t(x) : x)) })
const li = (s: string): J => ({ type: 'listItem', content: [p(s)] })
const cell = (s: string, header = false): J => ({ type: header ? 'tableHeader' : 'tableCell', content: [p(s)] })
const row = (...c: J[]): J => ({ type: 'tableRow', content: c })

export function allBlocksTemplate(): J {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [t('همهٔ بلوک‌ها')] },
      p('متن فارسی با ', t('پررنگ', [{ type: 'bold' }]), ' و ', t('کج', [{ type: 'italic' }]), ' و ', t('خط‌خورده', [{ type: 'strike' }]), ' و ', t('زیرخط', [{ type: 'underline' }]), ' و ', t('کد', [{ type: 'code' }]), ' و ', t('پیوند', [{ type: 'link', attrs: { href: 'https://example.com' } }]), '. English text, mixed 123 ۱۲۳.'),
      { type: 'paragraph', attrs: { dir: 'ltr' }, content: [t('A paragraph forced left-to-right.')] },
      { type: 'heading', attrs: { level: 2 }, content: [t('فهرست‌ها')] },
      { type: 'bulletList', content: [li('یک'), li('دو')] },
      { type: 'orderedList', content: [li('اول'), li('دوم')] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('انجام شده')] }, { type: 'taskItem', content: [p('هنوز نه')] }] },
      { type: 'blockquote', content: [p('نقل قول')] },
      { type: 'heading', attrs: { level: 2 }, content: [t('کادر نکته و بازشو')] },
      { type: 'callout', attrs: { icon: 'bulb' }, content: [p('این یک کادر نکته است.')] },
      { type: 'toggle', attrs: { open: true }, content: [p('عنوان بازشو'), p('محتوای پنهان‌شدنی.')] },
      { type: 'heading', attrs: { level: 2 }, content: [t('چیدمان دو ستونه')] },
      { type: 'layoutGroup', content: [{ type: 'layoutColumn', content: [p('ستون یک')] }, { type: 'layoutColumn', content: [p('ستون دو')] }] },
      { type: 'heading', attrs: { level: 2 }, content: [t('جدول')] },
      { type: 'table', attrs: { dir: 'rtl' }, content: [row(cell('الف', true), cell('ب', true)), row(cell('۱'), cell('۲'))] },
      { type: 'heading', attrs: { level: 2 }, content: [t('فرمول و نمودار')] },
      { type: 'mathBlock', attrs: { latex: 'E = mc^2 \\quad \\int_0^1 x^2\\,dx = \\tfrac{1}{3}' } },
      p('فرمول درون‌خطی: ', { type: 'mathInline', attrs: { latex: 'a^2 + b^2 = c^2' } }, ' تمام.'),
      { type: 'mermaid', attrs: { code: 'graph TD\n  A[شروع] --> B{تصمیم}\n  B -->|بله| C[ادامه]\n  B -->|خیر| D[پایان]' } },
      { type: 'heading', attrs: { level: 2 }, content: [t('کد')] },
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [t('const greet = (name: string) => `سلام ${name}`\nconsole.log(greet("Nevis"))')] },
      { type: 'heading', attrs: { level: 2 }, content: [t('نقاشی و تصویر')] },
      { type: 'drawing', attrs: { scene: JSON.stringify({ type: 'excalidraw', version: 2, source: 'nevis', elements: [], appState: { viewBackgroundColor: '#ffffff' } }) } },
      { type: 'image', attrs: { src: '', alt: 'جای تصویر' } },
    ],
  }
}
