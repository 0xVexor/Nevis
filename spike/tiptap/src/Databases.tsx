import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { repo } from './store'
import type { Page } from './repo'
import { PageIcon } from './PageIcon'
import { Button, Icon, IconButton, Screen, SearchField, dirOf, useMenu, type MenuItem } from './design-system'
import { locale, t } from './i18n'

// the preview reads the database engine, which loads only when a database is shown
const DatabasePreview = lazy(() => import('./database/ui/DatabasePreview').then((m) => ({ default: m.DatabasePreview })))

/**
 * Every database in one place (the pages that are the home of a database; their rows are not listed here): the list on one
 * side, the chosen one on the other with its views, properties and latest items, so you see what is inside before opening it.
 * Arrow keys move through the list, Enter opens.
 */
export function Databases({ onOpen, onNew, onDelete }: { onOpen: (id: string) => void; onNew: () => void; onDelete: (id: string) => void }) {
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const { open: openMenu, menu } = useMenu()
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    window.addEventListener('data-changed', bump)
    window.addEventListener('external-change', bump)
    return () => (window.removeEventListener('data-changed', bump), window.removeEventListener('external-change', bump))
  }, [])

  const all = useMemo(
    () =>
      repo
        .pagesOnly()
        .filter((p: Page) => !!p.dbHost)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [tick], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const q = query.trim().toLowerCase()
  const shown = all.filter((p) => !q || (p.title || t('Untitled database')).toLowerCase().includes(q))
  const current = shown.find((p) => p.id === picked) ?? shown[0]
  const parentName = (p: Page) => (p.parentId ? repo.get(p.parentId)?.title || t('Untitled') : t('Top level'))
  const items = (p: Page): MenuItem[] => [
    { label: 'Open', icon: <Icon name="maximize" size={16} />, onSelect: () => onOpen(p.id) },
    { kind: 'sep' },
    { label: 'Delete', icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => onDelete(p.id) },
  ]
  const move = (d: number) => {
    if (!shown.length) return
    const i = Math.max(0, shown.findIndex((p) => p.id === current?.id))
    const next = shown[Math.max(0, Math.min(shown.length - 1, i + d))]
    setPicked(next.id)
    document.querySelector<HTMLElement>(`[data-db-row="${next.id}"]`)?.focus()
  }

  return (
    <Screen
      width="wide"
      title={t('Databases')}
      description={all.length ? t('{n} databases', { n: all.length }) : t('Databases you create appear here.')}
      actions={
        <Button variant="primary" icon={<Icon name="plus" size={16} />} onClick={onNew}>
          {t('New database')}
        </Button>
      }
    >
      {all.length === 0 ? (
        <div className="ds-empty ds-empty--framed">
          <Icon name="database" />
          <b>{t('No databases yet')}</b>
          <span>{t('A database keeps items with the same properties together: tasks, books, contacts. Each item is also a page.')}</span>
          <Button variant="primary" icon={<Icon name="plus" size={16} />} onClick={onNew}>
            {t('New database')}
          </Button>
        </div>
      ) : (
        <div className="dbs">
          <div className="dbs-list">
            <SearchField value={query} onChange={setQuery} label={t('Search databases…')} placeholder={t('Search databases…')} clearLabel={t('Clear search')} onEnter={() => current && onOpen(current.id)} />
            {shown.length === 0 ? (
              <div className="ds-empty ds-empty--framed">
                <b>{t('No databases match')}</b>
              </div>
            ) : (
              <div
                className="ds-list ds-list--framed"
                role="listbox"
                aria-label={t('Databases')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), move(e.key === 'ArrowDown' ? 1 : -1))
                  else if (e.key === 'Enter' && current) (e.preventDefault(), onOpen(current.id))
                }}
              >
                {shown.map((p) => (
                  <div
                    key={p.id}
                    role="option"
                    tabIndex={p.id === current?.id ? 0 : -1}
                    aria-selected={p.id === current?.id}
                    data-db-row={p.id}
                    className="ds-list-row dbs-row"
                    dir={dirOf(p.title)}
                    onClick={() => setPicked(p.id)}
                    onDoubleClick={() => onOpen(p.id)}
                    onContextMenu={(e) => (e.preventDefault(), openMenu(items(p), e))}
                  >
                    <span className="dbs-ic">
                      <PageIcon page={p} />
                    </span>
                    <div className="ds-list-main">
                      <b dir="auto">{p.title || t('Untitled database')}</b>
                      <small dir="auto">
                        {parentName(p)} · {new Date(p.updatedAt).toLocaleDateString(locale())}
                      </small>
                    </div>
                    <IconButton className="dbs-more" label={t('More')} onClick={(e) => (e.stopPropagation(), openMenu(items(p), e.currentTarget))}>
                      <Icon name="more-horizontal" size={16} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
          </div>
          <section className="dbs-preview" aria-label={current?.title || t('Untitled database')}>
            {current && (
              <Suspense fallback={<div className="dv-loading" role="status">{t('Opening the database…')}</div>}>
                <DatabasePreview key={current.id} page={current} onOpen={(id) => onOpen(id ?? current.id)} />
              </Suspense>
            )}
          </section>
        </div>
      )}
      {menu}
    </Screen>
  )
}
