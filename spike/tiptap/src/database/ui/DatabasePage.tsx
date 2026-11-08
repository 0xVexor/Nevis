// The page of a database: its title, one line on what it holds, and the database itself. Rows open as pages through onOpenPage.
import { useEffect, useState } from 'react'
import { repo } from '../../store'
import type { Page } from '../../repo'
import { t } from '../../i18n'
import { DatabaseContainer } from './DatabaseContainer'
import { useDb } from './common'

export function DatabasePage({ page, onOpenPage, onMeta, readOnly }: { page: Page; onOpenPage: (id: string) => void; onMeta: () => void; readOnly?: boolean }) {
  const [title, setTitle] = useState(page.title)
  const svc = useDb()
  useEffect(() => setTitle(page.title), [page.id, page.title])
  const c = svc && page.dbHost ? svc.state.get('container', page.dbHost) : undefined
  const count = c && svc ? c.sourceLinks.reduce((n, l) => n + svc.state.rows(l.sourceId).filter((r) => r.page.deletedAt === null).length, 0) : null
  // .page-cols is what follows the page width (--page-w, changed with Alt + = / Alt + -), exactly like a normal page
  return (
    <div className="page-cols dv-page-cols">
      <div className="page dv-page">
        <header className="dv-page-head">
          <input
            className="dv-page-title"
            dir="auto"
            value={title}
            readOnly={readOnly}
            placeholder={t('Untitled database')}
            aria-label={t('Database title')}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title !== page.title) {
                repo.update(page.id, { title })
                onMeta()
              }
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          {count !== null && <p className="dv-page-line">{t('{n} items', { n: count })}</p>}
        </header>
        <DatabaseContainer containerId={page.dbHost!} onOpenPage={onOpenPage} />
      </div>
    </div>
  )
}
