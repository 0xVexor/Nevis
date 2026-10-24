import { getLang } from './i18n'
export interface Template {
  id: string
  title: string // name of the template on the chip
  desc: string
  icon: string // page icon given to the new page
  pageTitle: string // suggested page title (only used when the page has none yet)
  html: string
}

const task = (t: string, done = false) => `<li data-type="taskItem" data-checked="${done}"><p>${t}</p></li>`
const toggle = (q: string, a: string) => `<div data-type="toggle" data-open="false"><p>${q}</p><p>${a}</p></div>`
const callout = (emoji: string, body: string) => `<div data-type="callout" data-emoji="${emoji}"><p>${body}</p></div>`

const TEMPLATES: Template[] = [
  {
    id: 'lecture',
    title: 'جلسه‌ی درس',
    desc: 'هدف، مفاهیم، کد، پرسش‌ها و کارهای بعد از کلاس',
    icon: '🎓',
    pageTitle: 'جلسه‌ی درس — ',
    html: [
      callout('🎯', '<b>هدف جلسه:</b> '),
      '<h2>مفاهیم کلیدی</h2><ul><li></li></ul>',
      '<h2>یادداشت‌ها</h2><p></p>',
      '<h2>مثال و کد</h2><pre><code class="language-java">// نمونه کد</code></pre>',
      '<h2>پرسش‌های باز</h2>' + toggle('پرسش ۱', 'پاسخ'),
      '<h2>بعد از جلسه</h2><ul data-type="taskList">' + task('مرور یادداشت‌ها') + task('حل تمرین‌ها') + '</ul>',
    ].join(''),
  },
  {
    id: 'chapter',
    title: 'خلاصه‌ی فصل',
    desc: 'چکیده، تعریف‌ها، فرمول‌ها، نکته‌های امتحانی و فلش‌کارت',
    icon: '📚',
    pageTitle: 'خلاصه‌ی فصل ',
    html: [
      callout('💡', '<b>چکیده:</b> '),
      '<h2>تعریف‌ها</h2><table dir="rtl"><tbody><tr><th>مفهوم</th><th>تعریف</th></tr><tr><td></td><td></td></tr><tr><td></td><td></td></tr></tbody></table>',
      '<h2>فرمول‌ها</h2><div data-type="math-block" data-latex="E = mc^2"></div>',
      '<h2>نکته‌های امتحانی</h2>' + callout('⚠️', 'نکته‌ی مهم'),
      '<h2>سؤال‌های مرور</h2>' + toggle('سؤال ۱', 'جواب') + toggle('سؤال ۲', 'جواب'),
    ].join(''),
  },
  {
    id: 'exercise',
    title: 'تمرین',
    desc: 'صورت مسئله، ایده، راه‌حل با کد و جمع‌بندی',
    icon: '✏️',
    pageTitle: 'تمرین ',
    html: [
      '<h2>صورت مسئله</h2><p></p>',
      '<h2>ایده و تحلیل</h2><ul><li></li></ul>',
      '<h2>راه‌حل</h2><pre><code class="language-python"># کد راه‌حل\n</code></pre>',
      '<h2>آزمون و نتیجه</h2><table dir="rtl"><tbody><tr><th>ورودی</th><th>خروجی مورد انتظار</th><th>خروجی واقعی</th></tr><tr><td></td><td></td><td></td></tr></tbody></table>',
      '<h2>جمع‌بندی</h2>' + callout('📌', 'چه چیزی یاد گرفتم؟'),
      '<ul data-type="taskList">' + task('مسئله را فهمیدم') + task('راه‌حل را آزمودم') + task('بهینه‌سازی / مرور') + '</ul>',
    ].join(''),
  },
  {
    id: 'meeting',
    title: 'یادداشت جلسه',
    desc: 'دستور جلسه، تصمیم‌ها و اقدام‌ها',
    icon: '🗓️',
    pageTitle: 'جلسه — ',
    html: [
      '<h2>دستور جلسه</h2><ul><li></li></ul>',
      '<h2>تصمیم‌ها</h2>' + callout('✅', ''),
      '<h2>اقدام‌ها</h2><ul data-type="taskList">' + task('') + '</ul>',
    ].join(''),
  },
  {
    id: 'todo',
    title: 'فهرست کارها',
    desc: 'کارهای امروز، این هفته و بعداً با چک‌باکس',
    icon: '✅',
    pageTitle: 'کارها',
    html: [
      '<h2>امروز</h2><ul data-type="taskList">' + task('') + '</ul>',
      '<h2>این هفته</h2><ul data-type="taskList">' + task('') + '</ul>',
      '<h2>بعداً</h2><ul data-type="taskList">' + task('') + '</ul>',
    ].join(''),
  },
]

/** English versions of the templates (the Persian originals above are used when the UI language is Persian). */
const EN: Record<string, Pick<Template, 'title' | 'desc' | 'pageTitle' | 'html'>> = {
  lecture: {
    title: 'Lecture',
    desc: 'Goal, key concepts, code, open questions and follow-ups',
    pageTitle: 'Lecture — ',
    html: [
      callout('🎯', '<b>Goal of the session:</b> '),
      '<h2>Key concepts</h2><ul><li></li></ul>',
      '<h2>Notes</h2><p></p>',
      '<h2>Example & code</h2><pre><code class="language-java">// sample code</code></pre>',
      '<h2>Open questions</h2>' + toggle('Question 1', 'Answer'),
      '<h2>After the session</h2><ul data-type="taskList">' + task('Review the notes') + task('Solve the exercises') + '</ul>',
    ].join(''),
  },
  chapter: {
    title: 'Chapter summary',
    desc: 'Abstract, definitions, formulas, exam tips and flashcards',
    pageTitle: 'Chapter summary ',
    html: [
      callout('💡', '<b>Abstract:</b> '),
      '<h2>Definitions</h2><table dir="ltr"><tbody><tr><th>Concept</th><th>Definition</th></tr><tr><td></td><td></td></tr><tr><td></td><td></td></tr></tbody></table>',
      '<h2>Formulas</h2><div data-type="math-block" data-latex="E = mc^2"></div>',
      '<h2>Exam tips</h2>' + callout('⚠️', 'Important point'),
      '<h2>Review questions</h2>' + toggle('Question 1', 'Answer') + toggle('Question 2', 'Answer'),
    ].join(''),
  },
  exercise: {
    title: 'Exercise',
    desc: 'Problem statement, idea, solution with code and wrap-up',
    pageTitle: 'Exercise ',
    html: [
      '<h2>Problem statement</h2><p></p>',
      '<h2>Idea & analysis</h2><ul><li></li></ul>',
      '<h2>Solution</h2><pre><code class="language-python"># solution code\n</code></pre>',
      '<h2>Tests & result</h2><table dir="ltr"><tbody><tr><th>Input</th><th>Expected output</th><th>Actual output</th></tr><tr><td></td><td></td><td></td></tr></tbody></table>',
      '<h2>Wrap-up</h2>' + callout('📌', 'What did I learn?'),
      '<ul data-type="taskList">' + task('I understood the problem') + task('I tested the solution') + task('Optimization / review') + '</ul>',
    ].join(''),
  },
  meeting: {
    title: 'Meeting notes',
    desc: 'Agenda, decisions and action items',
    pageTitle: 'Meeting — ',
    html: [
      '<h2>Agenda</h2><ul><li></li></ul>',
      '<h2>Decisions</h2>' + callout('✅', ''),
      '<h2>Action items</h2><ul data-type="taskList">' + task('') + '</ul>',
    ].join(''),
  },
  todo: {
    title: 'To-do list',
    desc: 'Tasks for today, this week and later, with checkboxes',
    pageTitle: 'To-do',
    html: [
      '<h2>Today</h2><ul data-type="taskList">' + task('') + '</ul>',
      '<h2>This week</h2><ul data-type="taskList">' + task('') + '</ul>',
      '<h2>Later</h2><ul data-type="taskList">' + task('') + '</ul>',
    ].join(''),
  },
}

export const getTemplates = (): Template[] => (getLang() === 'fa' ? TEMPLATES : TEMPLATES.map((tp) => ({ ...tp, ...EN[tp.id] })))
