import { t } from '../i18n'
import { Screen } from '../ds'
import { useState } from 'react'
import { go } from '../router'
import type { Workspace } from '../workspace'

/** Every task of every page (derived from the `taskItem`s). Read-only here: a task is changed in its page. */
export function Tasks({ ws }: { ws: Workspace }) {
  const [show, setShow] = useState<'open' | 'done' | 'all'>('open')
  const titles = new Map(ws.data.pages.map(p => [p.id, p.title || t('Untitled')]))
  const all = ws.search.tasks()
  const list = all.filter(t => show === 'all' || (show === 'open') === !t.task.checked).sort((a, b) => (a.task.due || '9') < (b.task.due || '9') ? -1 : 1)
  return (
    <Screen title={t('Tasks')} width="narrow"><div data-testid="tasks" dir="rtl">
      <div role="group" aria-label={t('Show')}>
        {([['open', t('Open')], ['done', t('Done')], ['all', t('All')]] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={show === v} onClick={() => setShow(v)}>{l}</button>)}
      </div>
      {!list.length ? <p data-testid="tasks-empty">{t('No tasks.')}</p> : (
        <ul data-testid="task-list">
          {list.map((t, i) => (
            <li key={`${t.page}-${t.task.blockId}-${i}`} data-testid="task-row">
              <input type="checkbox" checked={t.task.checked} readOnly aria-label={t.task.text} /> {t.task.text || '—'}{t.task.due && <small> · {t.task.due}</small>} · <a href={`#/page/${t.page}`} onClick={e => { e.preventDefault(); go({ name: 'page', id: t.page }) }}>{titles.get(t.page)}</a>
            </li>
          ))}
        </ul>
      )}
    </div></Screen>
  )
}
