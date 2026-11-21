import { allBlocksTemplate, dailyNoteTemplate, meetingNotesTemplate, taskListTemplate } from '@nevis/editor'
import { formatDateFa } from '@nevis/core'
import { Card, Icon } from '../ds'
import { go } from '../router'
import { t } from '../i18n'
import type { Workspace } from '../workspace'

const today = () => formatDateFa(new Date().toISOString().slice(0, 10))

interface Tpl { id: string; icon: string; title: string; hint: string; make: () => { title: string; content: unknown } | null }
const TEMPLATES: Tpl[] = [
  { id: 'blank', icon: 'file', title: 'Blank page', hint: '', make: () => null },
  { id: 'all-blocks', icon: 'templates', title: 'All blocks sample', hint: 'یک نمونه از هر بلوک', make: () => ({ title: 'همهٔ بلوک‌ها', content: allBlocksTemplate() }) },
  { id: 'meeting', icon: 'file-text', title: 'Meeting notes', hint: 'دستور جلسه، تصمیم‌ها و اقدام‌ها', make: () => ({ title: 'یادداشت جلسه', content: meetingNotesTemplate(today()) }) },
  { id: 'tasks', icon: 'checklist', title: 'Task list', hint: 'فهرست کار با تیک', make: () => ({ title: 'فهرست کارها', content: taskListTemplate() }) },
  { id: 'daily', icon: 'history', title: 'Daily note', hint: 'برنامه و یادداشت امروز', make: () => ({ title: today(), content: dailyNoteTemplate(today()) }) },
]

export function Templates({ ws }: { ws: Workspace }) {
  const use = async (tpl: Tpl) => {
    const made = tpl.make()
    const id = made ? await ws.newTemplatePage(made.title, made.content) : await ws.newPage('')
    go({ name: 'page', id })
  }
  return (
    <section className="screen" data-testid="templates" dir="rtl">
      <h1>{t('Templates')}</h1>
      <div className="cards">
        {TEMPLATES.map(tpl => (
          <Card key={tpl.id} as="button" interactive data-testid={`template-${tpl.id}`} onClick={() => void use(tpl)}>
            <Icon name={tpl.icon} size={22} /><strong>{t(tpl.title)}</strong>{tpl.hint && <span className="small">{tpl.hint}</span>}
          </Card>
        ))}
      </div>
    </section>
  )
}
