// @ts-nocheck -- copied from the old app, where this ran as written; the new tsconfig's stricter index checks are not applied to copied code.
import { useContext, useMemo, useState } from 'react'
import type { Page } from './model'
import { PageContextMenu } from './pageContextMenu'
import { PageIcon } from './PageIcon'
import { Button, Icon, IconButton, Screen, SearchField, contextMenuAnchor, dirOf, useMenu, type MenuItem } from '../ds'
import { locale, t } from '../i18n'


/**
 * Every database in one place (the pages that are the home of a database; their rows are not listed here): the list on one
 * side, the chosen one on the other with its views, properties and latest items, so you see what is inside before opening it.
 * Arrow keys move through the list, Enter opens.
 */
export function Databases({ pages, preview, onOpen, onNew, onDelete }: { pages: Page[]; preview: (page: Page) => React.ReactNode; onOpen: (id: string) => void; onNew: () => void; onDelete: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const { open: openMenu, menu } = useMenu()
  const pageMenu = useContext(PageContextMenu)
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const all = useMemo(() => pages.filter((p) => !!p.dbHost).sort((a, b) => b.updatedAt - a.updatedAt), [pages])
  const q = query.trim().toLowerCase()
  const shown = all.filter((p) => !q || (p.title || t('Untitled database')).toLowerCase().includes(q))
  const current = shown.find((p) => p.id === picked) ?? shown[0]
  const parentName = (p: Page) => (p.parentId ? byId.get(p.parentId)?.title || t('Untitled') : t('Top level'))
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
                    onContextMenu={e => pageMenu ? pageMenu(p.id, contextMenuAnchor(e)) : openMenu(items(p), e)}
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
                    <IconButton className="dbs-more" label={t('More')} onClick={e => {
                      e.stopPropagation()
                      if (pageMenu) pageMenu(p.id, e.currentTarget.getBoundingClientRect())
                      else openMenu(items(p), e.currentTarget)
                    }}>
                      <Icon name="more-horizontal" size={16} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
          </div>
          <section className="dbs-preview" aria-label={current?.title || t('Untitled database')}>
            {current && (
              preview(current)
            )}
          </section>
        </div>
      )}
      {menu}
    </Screen>
  )
}
