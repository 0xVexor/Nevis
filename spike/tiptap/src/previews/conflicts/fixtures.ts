import type { DocNode } from '../../docNode'
import type { Page } from '../../repo'
import type { ConflictMarker } from '../../conflict/types'

// Fake conflicts for the review page. Block ids are what the comparison matches blocks by.
type Lang = 'en' | 'fa'
const NOW = Date.now()
const MIN = 60_000

const text = (value: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text: value, ...(marks && { marks }) })
const para = (id: string, value: string): DocNode => ({ type: 'paragraph', attrs: { blockId: id }, content: [text(value)] })
const heading = (id: string, value: string, level = 2): DocNode => ({ type: 'heading', attrs: { blockId: id, level }, content: [text(value)] })
const code = (id: string, value: string): DocNode => ({ type: 'codeBlock', attrs: { blockId: id, language: 'ts' }, content: [text(value)] })
const mermaid = (id: string, source: string): DocNode => ({ type: 'mermaid', attrs: { blockId: id, code: source } })
const picture = (id: string, color: string): DocNode => ({
  type: 'image',
  attrs: { blockId: id, alt: 'Sketch', src: `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" rx="10" fill="${color}"/></svg>`)}` },
})
const table = (id: string, rows: string[][]): DocNode => ({
  type: 'table',
  attrs: { blockId: id },
  content: rows.map((row, r) => ({ type: 'tableRow', content: row.map((cell) => ({ type: r === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: [text(cell)] }] })) })),
})
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', attrs: { blockIdentityVersion: 1 }, content })

const page = (title: string, content: DocNode): Page => ({ id: 'page-1', parentId: null, title, favorite: false, sort: 0, content, updatedAt: NOW, deletedAt: null, icon: 'note' })

interface Spec {
  title: [base: string, local: string, remote: string]
  base: DocNode | null
  local: DocNode
  remote: DocNode
  kept?: 'local' | 'remote'
  kind?: ConflictMarker['kind']
  names?: [string, string]
}

function marker(id: string, spec: Spec): ConflictMarker {
  const [bt, lt, rt] = spec.title
  const [localName, remoteName] = spec.names ?? ['', '']
  return {
    format: 1,
    id,
    pageId: 'page-1',
    kind: spec.kind ?? 'edit',
    detectedAt: NOW - 2 * MIN,
    detectedBy: { deviceId: 'a', deviceName: localName },
    base: spec.base ? page(bt, spec.base) : null,
    local: { page: page(lt, spec.local), deviceId: 'a', deviceName: localName, savedAt: NOW - 14 * MIN },
    remote: { page: page(rt, spec.remote), deviceId: 'b', deviceName: remoteName, savedAt: NOW - 3 * MIN },
    kept: spec.kept ?? 'local',
  }
}

const COPY = {
  en: {
    names: ['Study laptop', 'Phone'] as [string, string],
    title: ['Trip plan', 'Trip plan (draft)', 'Trip plan 2026'],
    intro: ['We leave on Friday morning and come back on Sunday evening.', 'We leave on Friday early morning and come back on Sunday evening.', 'We leave on Friday morning and come back late on Sunday evening.'],
    filler: (n: number) => `Paragraph ${n} that nobody touched, with a few words in it.`,
    only: 'Only the phone kept this note about the museum tickets.',
    packing: 'Packing list',
    added: 'Added later: check the weather before leaving.',
    items: [['Item', 'Count'], ['Shirts', '3'], ['Socks', '5']],
    itemsEdited: [['Item', 'Count'], ['Shirts', '4'], ['Socks', '5']],
    big: (n: number) => `Block ${n} of a long page, with enough words to make a difference visible.`,
  },
  fa: {
    names: ['لپ‌تاپ درس', 'گوشی'] as [string, string],
    title: ['برنامهٔ سفر', 'برنامهٔ سفر (پیش‌نویس)', 'برنامهٔ سفر ۱۴۰۵'],
    intro: ['جمعه صبح حرکت می‌کنیم و یکشنبه عصر برمی‌گردیم.', 'جمعه صبح زود حرکت می‌کنیم و یکشنبه عصر برمی‌گردیم.', 'جمعه صبح حرکت می‌کنیم و یکشنبه آخر عصر برمی‌گردیم.'],
    filler: (n: number) => `بند ${n} که کسی به آن دست نزده و چند کلمه دارد.`,
    only: 'فقط گوشی این یادداشت دربارهٔ بلیت موزه را نگه داشته است.',
    packing: 'فهرست وسایل',
    added: 'بعداً اضافه شد: پیش از رفتن وضع هوا را بررسی کنید.',
    items: [['وسیله', 'تعداد'], ['پیراهن', '۳'], ['جوراب', '۵']],
    itemsEdited: [['وسیله', 'تعداد'], ['پیراهن', '۴'], ['جوراب', '۵']],
    big: (n: number) => `بلوک ${n} از یک صفحهٔ بلند، با کلمه‌های کافی تا تفاوت دیده شود.`,
  },
}

export interface Case {
  id: string
  label: string
  marker: ConflictMarker
}

export function cases(lang: Lang, big: boolean): Case[] {
  const c = COPY[lang]
  const t = lang === 'fa'
  const filler = [para('f1', c.filler(1)), para('f2', c.filler(2))]
  const named = { names: c.names }
  const list: Case[] = [
    {
      id: 'title',
      label: t ? 'تغییر عنوان' : 'Title changed',
      marker: marker('m-title', { ...named, title: [c.title[0], c.title[1], c.title[2]], base: doc(heading('h', c.packing), ...filler), local: doc(heading('h', c.packing), ...filler), remote: doc(heading('h', c.packing), ...filler) }),
    },
    {
      id: 'paragraph',
      label: t ? 'بند ویرایش‌شده در هر دو' : 'Paragraph edited on both',
      marker: marker('m-para', { ...named, title: [c.title[0], c.title[0], c.title[0]], base: doc(para('p', c.intro[0]), ...filler), local: doc(para('p', c.intro[1]), ...filler), remote: doc(para('p', c.intro[2]), ...filler, para('r', c.only)) }),
    },
    {
      id: 'table',
      label: t ? 'جدول در یک طرف' : 'Table changed on one side',
      marker: marker('m-table', { ...named, title: [c.title[0], c.title[0], c.title[0]], base: doc(heading('h', c.packing), table('t', c.items), ...filler), local: doc(heading('h', c.packing), table('t', c.items), ...filler), remote: doc(heading('h', c.packing), table('t', c.itemsEdited), ...filler) }),
    },
    {
      id: 'image',
      label: t ? 'تصویر اضافه شد' : 'Image added',
      marker: marker('m-image', { ...named, title: [c.title[0], c.title[0], c.title[0]], base: doc(...filler), local: doc(...filler, para('l', c.added)), remote: doc(...filler, picture('img', '#6a5cff')) }),
    },
    {
      id: 'code',
      label: t ? 'بلوک کد' : 'Code block',
      marker: marker('m-code', { ...named, title: [c.title[0], c.title[0], c.title[0]], base: doc(code('c', 'const a = 1\nconst b = 2\nconsole.log(a + b)')), local: doc(code('c', 'const a = 1\nconst b = 20\nconsole.log(a + b)')), remote: doc(code('c', 'const a = 10\nconst b = 2\nconsole.log(a + b)\nconsole.log("done")')) }),
    },
    {
      id: 'mermaid',
      label: t ? 'نمودار' : 'Mermaid diagram',
      marker: marker('m-mermaid', { ...named, title: [c.title[0], c.title[0], c.title[0]], base: doc(mermaid('d', 'graph TD; A-->B'), ...filler), local: doc(mermaid('d', 'graph TD; A-->B; B-->C'), ...filler), remote: doc(mermaid('d', 'graph TD; A-->B; A-->D'), ...filler) }),
    },
    {
      id: 'delete',
      label: t ? 'حذف در برابر ویرایش' : 'Delete versus edit',
      marker: marker('m-delete', { ...named, title: [c.title[0], c.title[0], c.title[0]], base: doc(para('p', c.intro[0]), para('q', c.only), ...filler), local: doc(para('p', c.intro[0]), ...filler), remote: doc(para('p', c.intro[0]), para('q', c.only + ' !'), ...filler) }),
    },
    {
      id: 'nobase',
      label: t ? 'بدون نسخهٔ پایه' : 'No base version',
      marker: marker('m-nobase', { ...named, title: [c.title[0], c.title[1], c.title[2]], base: null, kept: 'remote', local: doc(para('p', c.intro[1]), ...filler, para('l', c.added)), remote: doc(para('p', c.intro[2]), ...filler) }),
    },
  ]
  if (big) {
    const blocks = (edit: (i: number) => boolean) => Array.from({ length: 300 }, (_, i) => para('big' + i, c.big(i) + (edit(i) ? (t ? ' (ویرایش)' : ' (edited)') : '')))
    list.push({
      id: 'big',
      label: t ? 'صفحهٔ ۳۰۰ بلوکی' : '300-block page',
      marker: marker('m-big', { ...named, title: [c.title[0], c.title[0], c.title[0]], base: doc(...blocks(() => false)), local: doc(...blocks((i) => i % 37 === 0)), remote: doc(...blocks((i) => i % 53 === 0)) }),
    })
  }
  return list
}
