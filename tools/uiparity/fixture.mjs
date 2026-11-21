// The SAME small workspace for the old app and the new one, so a screenshot pair differs only by design, never by data.
const p = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] })
const task = (text, checked) => ({ type: 'taskItem', attrs: { checked }, content: [p(text)] })
const link = (id, text) => ({ type: 'paragraph', content: [{ type: 'text', text: 'نگاه کنید به ' }, { type: 'pageLink', attrs: { id, dstId: id, label: text } }] })

export const PAGES = [
  { key: 'shiraz', title: 'سفر به شیراز', icon: 'i:pin', favorite: true, tags: ['سفر'], status: 'doing', parent: null,
    doc: [h(1, 'سفر به شیراز'), p('برنامهٔ سه‌روزهٔ سفر. hello world ۱۲۳'), h(2, 'کارها'), { type: 'taskList', content: [task('رزرو هتل', true), task('خرید بلیت', false), task('بستن چمدان', false)] }] },
  { key: 'bazaar', title: 'بازار وکیل', icon: '', favorite: false, tags: ['سفر'], status: '', parent: 'shiraz',
    doc: [p('بازار وکیل را حتماً ببینید.'), { type: 'blockquote', content: [p('گشتی در بازار')] }] },
  { key: 'notes', title: 'Meeting notes', icon: 'i:star', favorite: true, tags: ['کار'], status: 'todo', parent: null,
    doc: [h(2, 'Agenda'), { type: 'bulletList', content: [{ type: 'listItem', content: [p('Roadmap review')] }, { type: 'listItem', content: [p('Budget')] }] }, link('__shiraz', 'سفر به شیراز')] },
  { key: 'ideas', title: 'ایده‌ها', icon: '', favorite: false, tags: [], status: 'done', parent: null,
    doc: [p('یک فهرست کوتاه از ایده‌ها'), { type: 'taskList', content: [task('نوشتن گزارش', false)] }] },
]
// `app`: 'old' keeps `id`, 'new' keeps `dstId` (the two schemas name the link target differently).
export const docOf = (page, ids, app) => {
  const doc = JSON.parse(JSON.stringify(page.doc).replaceAll('__shiraz', ids.shiraz ?? ''))
  const fix = (n) => { if (n.type === 'pageLink') n.attrs = app === 'old' ? { id: n.attrs.id, label: n.attrs.label } : { dstId: n.attrs.dstId, label: n.attrs.label }; (n.content ?? []).forEach(fix) }
  doc.forEach(fix)
  return { type: 'doc', content: doc }
}
