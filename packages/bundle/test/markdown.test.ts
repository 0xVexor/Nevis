import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PMJson } from '@nevis/schema'
import { mdFileName, toMarkdown } from '../src'

const t = (text: string, marks: string[] = []): PMJson => ({ type: 'text', text, ...(marks.length ? { marks: marks.map(type => ({ type })) } : {}) })
const p = (...c: PMJson[]): PMJson => ({ type: 'paragraph', attrs: { dir: 'auto' }, content: c })
const H = 'a'.repeat(64)

// A golden document: every block the mirror knows. The expected text is a STORED file (test/golden/all.md): a change in the converter shows
// up as a reviewed change of that file, never silently.
const golden: PMJson = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 1, dir: 'auto' }, content: [t('عنوان')] },
  p(t('متن '), t('پررنگ', ['bold']), t(' و '), t('کج', ['italic']), t(' و '), t('کد', ['code']), t(' و '), { ...t('پیوند'), marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }),
  { type: 'paragraph', attrs: { dir: 'ltr' }, content: [t('Forced left to right')] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('یک'))] }, { type: 'listItem', content: [p(t('دو'))] }] },
  { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('اول'))] }, { type: 'listItem', content: [p(t('دوم'))] }] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('انجام‌شده'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(t('مانده'))] }] },
  { type: 'blockquote', content: [p(t('نقل قول'))] },
  { type: 'callout', attrs: { icon: 'warning' }, content: [p(t('هشدار'))] },
  { type: 'toggle', content: [p(t('پرسش؟')), p(t('پاسخ'))] },
  { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const x = 1')] },
  { type: 'mathBlock', attrs: { latex: 'E=mc^2' } },
  { type: 'mermaid', attrs: { code: 'graph TD\n  A-->B' } },
  { type: 'image', attrs: { blob: H, alt: 'عکس' } },
  { type: 'file', attrs: { blob: H, name: 'گزارش.pdf' } },
  { type: 'table', attrs: { dir: 'auto' }, content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [p(t('الف'))] }, { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [p(t('ب'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p(t('۱'))] }, { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p(t('۲'))] }] }] },
  { type: 'table', attrs: { dir: 'rtl' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2, rowspan: 1 }, content: [p(t('ادغام'))] }] }] },
  { type: 'layoutGroup', content: [{ type: 'layoutColumn', content: [p(t('ستون یک'))] }, { type: 'layoutColumn', content: [p(t('ستون دو'))] }] },
  p(t('پیوند به '), { type: 'pageLink', attrs: { dstId: 'X', label: 'برچسب' } }, t(' و فرمول '), { type: 'mathInline', attrs: { latex: 'x^2' } }),
] }

describe('Markdown mirror', () => {
  it('matches the stored golden file', () => {
    const out = toMarkdown(golden, { titleOf: id => (id === 'X' ? 'صفحهٔ ایکس' : '') })
    expect(out).toBe(readFileSync(join(import.meta.dirname, 'golden', 'all.md'), 'utf8'))
  })
  it('renders rich contents as HTML in merged tables without interpreting literal text', () => {
    const cell: PMJson = { type: 'tableCell', attrs: { colspan: 2 }, content: [p(
      t('literal **x** & <tag> '), t('bold', ['bold']), t(' '), t('code', ['code']),
      { ...t('safe'), marks: [{ type: 'link', attrs: { href: 'https://example.com/?a=1&b=2' } }] },
      { ...t('unsafe'), marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
      { type: 'pageLink', attrs: { dstId: 'page-1', label: 'صفحه' } },
    ), p(t("second 'paragraph'"))] }
    const out = toMarkdown({ type: 'doc', content: [{ type: 'table', attrs: { dir: 'rtl' }, content: [{ type: 'tableRow', content: [cell] }] }] })
    expect(out).toContain('literal **x** &amp; &lt;tag&gt; <strong>bold</strong> <code>code</code>')
    expect(out).toContain('<a href="https://example.com/?a=1&amp;b=2">safe</a>unsafe')
    expect(out).toContain('<span data-type="page-link" data-dst="page-1" data-label="صفحه">صفحه</span>')
    expect(out).toContain("</p><p>second 'paragraph'</p>")
    expect(out).not.toContain('javascript:')
  })
  it('escapes a literal pipe once in a GFM table cell', () => {
    const cell: PMJson = { type: 'tableHeader', content: [p(t('a|b'))] }
    expect(toMarkdown({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell] }] }] })).toContain('| a\\|b |')
  })
  it('front matter and the file name', () => {
    const md = toMarkdown({ type: 'doc', content: [p(t('x'))] }, {}, { id: 'abc-12345678', title: 'عنوان "ویژه"', tags: ['t'], created: 1, updated: 2 })
    expect(md.startsWith('---\nid: "abc-12345678"\ntitle: "عنوان \\"ویژه\\""\nparent: ""\ntags: ["t"]\ncreated: 1\nupdated: 2\ndir: auto\n---\n<!--')).toBe(true)
    expect(mdFileName('عنوان / ویژه: ؟', '019a-0000-12345678')).toBe('عنوان-ویژه-؟--12345678.md')
    expect(mdFileName('', 'x'.repeat(10))).toBe('untitled--xxxxxxxx.md')
  })
  it('is not vacuous: a changed block changes the output', () => {
    expect(toMarkdown({ type: 'doc', content: [p(t('a'))] })).not.toBe(toMarkdown({ type: 'doc', content: [p(t('b'))] }))
  })
})
