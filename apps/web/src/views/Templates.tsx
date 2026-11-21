// Templates as the old app drew them: the choices on one side (`tpl-option`), a preview of the page the chosen one creates on the other (`tpl-paper`).
// Arrow keys move through the list, Enter or a double click creates. The preview is read from the template's own ProseMirror JSON.
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { allBlocksTemplate, dailyNoteTemplate, meetingNotesTemplate, taskListTemplate } from '@nevis/editor'
import { formatDateFa } from '@nevis/core'
import { Button, Icon, Screen } from '../ds'
import { Glyph } from '../ds/iconSet'
import { go } from '../router'
import { t } from '../i18n'
import type { Workspace } from '../workspace'

const today = () => formatDateFa(new Date().toISOString().slice(0, 10))

type N = { type?: string; attrs?: Record<string, unknown>; content?: N[]; text?: string }
type Block =
  | { kind: 'heading'; text: string } | { kind: 'text' } | { kind: 'list'; items: string[] } | { kind: 'tasks'; items: { text: string }[] } | { kind: 'toggle'; text: string }
  | { kind: 'callout'; text: string } | { kind: 'code'; text: string } | { kind: 'math'; text: string } | { kind: 'table'; head: string[]; rows: number }
const textOf = (n: N | undefined): string => (!n ? '' : (n.text ?? (n.content ?? []).map(textOf).join(' '))).trim()
function outline(doc: unknown): Block[] {
  return ((doc as N)?.content ?? []).map((n): Block => {
    switch (n.type) {
      case 'heading': return { kind: 'heading', text: textOf(n) }
      case 'taskList': return { kind: 'tasks', items: (n.content ?? []).map(li => ({ text: textOf(li) })) }
      case 'bulletList': case 'orderedList': return { kind: 'list', items: (n.content ?? []).map(textOf) }
      case 'toggle': return { kind: 'toggle', text: textOf(n.content?.[0]) }
      case 'callout': return { kind: 'callout', text: textOf(n) }
      case 'mathBlock': return { kind: 'math', text: String(n.attrs?.latex ?? '') }
      case 'codeBlock': return { kind: 'code', text: textOf(n) }
      case 'table': { const rows = n.content ?? []; return { kind: 'table', head: (rows[0]?.content ?? []).map(textOf), rows: Math.max(0, rows.length - 1) } }
      default: return { kind: 'text' }
    }
  })
}

interface Choice { id: string; title: string; hint: string; icon: ReactNode; action: string; pageTitle?: string; blocks?: Block[]; make: () => { title: string; content: unknown } | null | 'database' }
const Line = ({ width }: { width: number }) => <i className="tpl-line" style={{ inlineSize: width + '%' }} />

function PaperBlock({ block: b }: { block: Block }) {
  switch (b.kind) {
    case 'heading': return <h3 className="tpl-h" dir="auto">{b.text}</h3>
    case 'text': return <Line width={70} />
    case 'list': return <ul className="tpl-list">{b.items.map((x, i) => <li key={i} dir="auto">{x || <Line width={50} />}</li>)}</ul>
    case 'tasks': return <div className="tpl-tasks">{b.items.map((x, i) => <span key={i} className="tpl-task" dir="auto"><span className="ds-check" aria-hidden="true" />{x.text || <Line width={45} />}</span>)}</div>
    case 'toggle': return <span className="tpl-toggle" dir="auto"><Icon name="chevron-right" size={14} className="ds-flip" />{b.text}</span>
    case 'callout': return <span className="tpl-callout" dir="auto"><Icon name="callout" size={15} />{b.text || <Line width={40} />}</span>
    case 'code': return <pre className="tpl-code" dir="ltr">{b.text}</pre>
    case 'math': return <code className="tpl-code" dir="ltr">{b.text}</code>
    case 'table': return <div className="tpl-table" style={{ gridTemplateColumns: `repeat(${b.head.length || 2}, 1fr)` }}>{b.head.map((h, i) => <b key={i} dir="auto">{h}</b>)}{Array.from({ length: b.rows * b.head.length }, (_, i) => <span key={i} />)}</div>
  }
}

export function Templates({ ws }: { ws: Workspace }) {
  const meeting = meetingNotesTemplate(today()), tasks = taskListTemplate(), daily = dailyNoteTemplate(today()), all = allBlocksTemplate()
  const empty: Choice[] = [
    { id: 'blank', title: t('Blank page'), hint: t('Start from scratch'), icon: <Icon name="file-text" />, action: t('Create page'), make: () => null },
    { id: 'database', title: t('Database'), hint: t('Tables, views, forms and dashboards in one database.'), icon: <Icon name="database" />, action: t('Create database'), make: () => 'database' },
  ]
  const ready: Choice[] = [
    { id: 'meeting', title: t('Meeting notes'), hint: 'دستور جلسه، تصمیم‌ها و اقدام‌ها', icon: <Glyph name="users" size={18} />, action: t('Use template'), pageTitle: 'یادداشت جلسه', blocks: outline(meeting), make: () => ({ title: 'یادداشت جلسه', content: meeting }) },
    { id: 'tasks', title: t('To-do list'), hint: 'فهرست کار با تیک', icon: <Glyph name="checklist" size={18} />, action: t('Use template'), pageTitle: 'فهرست کارها', blocks: outline(tasks), make: () => ({ title: 'فهرست کارها', content: tasks }) },
    { id: 'daily', title: t('Daily note'), hint: 'برنامه و یادداشت امروز', icon: <Glyph name="calendar" size={18} />, action: t('Use template'), pageTitle: today(), blocks: outline(daily), make: () => ({ title: today(), content: daily }) },
    { id: 'all-blocks', title: t('All blocks sample'), hint: 'یک نمونه از هر بلوک', icon: <Glyph name="templates" size={18} />, action: t('Use template'), pageTitle: 'همهٔ بلوک‌ها', blocks: outline(all), make: () => ({ title: 'همهٔ بلوک‌ها', content: all }) },
  ]
  const choices = [...empty, ...ready]
  const [current, setCurrent] = useState(choices[0]!.id)
  const chosen = choices.find(c => c.id === current) ?? choices[0]!
  const list = useRef<HTMLDivElement>(null)
  const pick = async (c: Choice) => {
    const made = c.make()
    if (made === 'database') { go({ name: 'page', id: await ws.newDatabase('') }); return }
    go({ name: 'page', id: made ? await ws.newTemplatePage(made.title, made.content) : await ws.newPage('') })
  }
  const move = (e: ReactKeyboardEvent) => {
    const i = choices.findIndex(c => c.id === current)
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1 : -2
    if (next === -2) return
    e.preventDefault()
    const id = choices[Math.max(0, Math.min(choices.length - 1, next))]!.id
    setCurrent(id)
    list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus()
  }
  const option = (c: Choice) => (
    <button key={c.id} type="button" role="option" data-id={c.id} data-testid={`template-${c.id}`} aria-selected={c.id === current} tabIndex={c.id === current ? 0 : -1} className="tpl-option"
      onClick={() => setCurrent(c.id)} onDoubleClick={() => void pick(c)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), void pick(c))}>
      <span className="tpl-option-ic">{c.icon}</span><span className="tpl-option-text"><b dir="auto">{c.title}</b><small dir="auto">{c.hint}</small></span>
    </button>
  )
  return (
    <Screen width="wide" fill title={t('Templates')} description={t('Pick a starting point. The preview shows what the new page will contain.')}>
      <div className="tpl" data-testid="templates">
        <div ref={list} className="tpl-choices" role="listbox" aria-label={t('Templates')} onKeyDown={move}>
          <div role="group" aria-labelledby="tpl-empty"><h2 id="tpl-empty" className="tpl-group">{t('Start empty')}</h2>{empty.map(option)}</div>
          <div role="group" aria-labelledby="tpl-ready"><h2 id="tpl-ready" className="tpl-group">{t('Ready-made pages')}</h2>{ready.map(option)}</div>
        </div>
        <section className="tpl-preview" aria-label={t('Preview')} aria-live="polite">
          <header className="tpl-preview-head">
            <div><h2 dir="auto">{chosen.title}</h2><p dir="auto">{chosen.hint}</p></div>
            <Button variant="primary" data-testid="tpl-use" onClick={() => void pick(chosen)}>{chosen.action}</Button>
          </header>
          <div className="tpl-stage">
            <div key={chosen.id} className="tpl-paper">
              <span className="tpl-paper-icon">{chosen.icon}</span>
              <p className="tpl-paper-title" dir="auto" data-empty={!chosen.pageTitle?.trim() || undefined}>{chosen.pageTitle?.trim() || t('Untitled')}</p>
              {!chosen.blocks?.length ? <p className="tpl-paper-hint">{t('Start writing, or press / for blocks')}</p> : chosen.blocks.map((b, i) => <PaperBlock key={i} block={b} />)}
            </div>
          </div>
        </section>
      </div>
    </Screen>
  )
}
