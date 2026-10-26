// The page of a database: its title and the database itself. Rows open as pages through onOpenPage.
import { useEffect, useState } from 'react'
import { repo } from '../../store'
import type { Page } from '../../repo'
import { t } from '../../i18n'
import { DatabaseContainer } from './DatabaseContainer'

export function DatabasePage({ page, onOpenPage, onMeta, readOnly }: { page: Page; onOpenPage: (id: string) => void; onMeta: () => void; readOnly?: boolean }) {
  const [title, setTitle] = useState(page.title)
  useEffect(() => setTitle(page.title), [page.id, page.title])
  return (
    <div className="page db-page">
      <input
        className="title db-page-title" dir="auto" value={title} readOnly={readOnly} placeholder={t('Untitled database')} aria-label={t('Database title')}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (title !== page.title) { repo.update(page.id, { title }); onMeta() } }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <DatabaseContainer containerId={page.dbHost!} onOpenPage={onOpenPage} />
    </div>
  )
}
