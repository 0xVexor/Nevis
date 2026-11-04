import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { allDrawings, type DrawingInfo } from './drawingData'
import { urlFor } from './attachments'
import { warmDrawing } from './editor/excalidraw'
import { Button, Icon, IconButton, Screen, SearchField, dirOf, useMenu, type MenuItem } from './design-system'
import { ago } from './ui'
import { t, locale } from './i18n'

type Filter = 'all' | 'board' | 'inline'

const DAY = 24 * 3600 * 1000

/** The drawing's saved picture on its board; a pencil while nothing is drawn yet. */
function Thumb({ preview }: { preview: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (preview) void urlFor('att:' + preview).then((u) => live && setUrl(u))
    return () => void (live = false)
  }, [preview])
  return url ? (
    <img src={url} alt="" loading="lazy" draggable={false} />
  ) : (
    <span className="dr-blank">
      <Icon name="pencil" size={24} />
    </span>
  )
}

/**
 * Every drawing in one place: whole-page boards and drawing blocks inside pages. The one edited last waits on its own
 * board to be continued; the rest follow by when they were last touched. Right-click a drawing for its actions.
 */
export function Drawings({ onOpen, onNew, onDelete }: { onOpen: (id: string) => void; onNew: () => void; onDelete: (d: DrawingInfo) => void }) {
  const [tick, setTick] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const { open: openMenu, menu } = useMenu()
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    window.addEventListener('data-changed', bump)
    window.addEventListener('external-change', bump)
    return () => (window.removeEventListener('data-changed', bump), window.removeEventListener('external-change', bump))
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(allDrawings, [tick])
  const q = query.trim().toLowerCase()
  const shown = all.filter((d) => (filter === 'all' || d.source === filter) && (!q || (d.title || t('Untitled')).toLowerCase().includes(q)))
  const boards = all.filter((d) => d.source === 'board').length
  const num = (n: number) => n.toLocaleString(locale())

  // the last one edited is the one you are most likely to come back to; it gets the big board while nothing narrows the list
  const showLatest = !q && filter === 'all'
  const latest = showLatest ? shown[0] : undefined
  const rest = showLatest ? shown.slice(1) : shown
  const groups = (() => {
    const today = new Date().setHours(0, 0, 0, 0)
    const buckets: [string, DrawingInfo[]][] = [
      [t('Today'), []],
      [t('This week'), []],
      [t('Earlier'), []],
    ]
    for (const d of rest) buckets[d.updatedAt >= today ? 0 : d.updatedAt >= today - 6 * DAY ? 1 : 2][1].push(d)
    return buckets.filter(([, list]) => list.length)
  })()

  const name = (d: DrawingInfo) => d.title || t('Untitled')
  const actions = (d: DrawingInfo): MenuItem[] => [
    { label: d.source === 'board' ? 'Open board' : 'Open page', icon: <Icon name="arrow-up-right" size={16} />, onSelect: () => onOpen(d.pageId) },
    { kind: 'sep' },
    { label: 'Delete', icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => onDelete(d) },
  ]
  const context = (d: DrawingInfo) => (e: MouseEvent) => (e.preventDefault(), openMenu(actions(d), e))
  const where = (d: DrawingInfo) => (d.source === 'board' ? t('Board') : t('In a page'))

  const card = (d: DrawingInfo) => (
    <div key={d.key} className="dr-card" onContextMenu={context(d)}>
      <button type="button" className="dr-open" onClick={() => onOpen(d.pageId)} onPointerEnter={warmDrawing} dir={dirOf(name(d))}>
        <span className="dr-thumb">
          <Thumb preview={d.preview} />
        </span>
        <span className="dr-meta">
          <b dir="auto">{name(d)}</b>
          <small>
            <Icon name={d.source === 'board' ? 'board' : 'file-text'} size={13} />
            {where(d)}, {ago(d.updatedAt)}
          </small>
        </span>
      </button>
      <IconButton label={t('More')} className="dr-more" onClick={(e) => openMenu(actions(d), e.currentTarget)}>
        <Icon name="more-horizontal" size={16} />
      </IconButton>
    </div>
  )

  return (
    <Screen
      width="wide"
      title={t('Drawings')}
      description={all.length ? t('{n} drawings, {b} of them boards', { n: num(all.length), b: num(boards) }) : t('Boards and drawings from your pages appear here.')}
      actions={
        <Button variant="primary" icon={<Icon name="plus" size={16} />} onPointerEnter={warmDrawing} onFocus={warmDrawing} onClick={onNew}>
          {t('New board')}
        </Button>
      }
    >
      {all.length === 0 ? (
        <div className="ds-empty ds-empty--framed dr-empty">
          <Icon name="board" />
          <b>{t('No drawings yet')}</b>
          <span>{t('Start a board for sketches and diagrams, or add a drawing to any page with /drawing.')}</span>
          <Button onClick={onNew} onPointerEnter={warmDrawing}>
            {t('New board')}
          </Button>
        </div>
      ) : (
        <>
          <div className="dr-tools">
            <SearchField className="dr-search" value={query} onChange={setQuery} label={t('Search drawings')} placeholder={t('Search drawings…')} clearLabel={t('Clear')} />
            <div className="ds-seg" role="group" aria-label={t('Show')}>
              {(
                [
                  ['all', t('All')],
                  ['board', t('Boards')],
                  ['inline', t('In pages')],
                ] as const
              ).map(([f, label]) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {latest && (
            <section className="dr-latest" aria-labelledby="dr-latest" onContextMenu={context(latest)}>
              <button type="button" className="dr-latest-board" onClick={() => onOpen(latest.pageId)} onPointerEnter={warmDrawing} tabIndex={-1} aria-hidden="true">
                <Thumb preview={latest.preview} />
              </button>
              <div className="dr-latest-text">
                <small>{t('Last edited {when}', { when: ago(latest.updatedAt) })}</small>
                <h2 id="dr-latest" dir="auto">
                  {name(latest)}
                </h2>
                <p>{where(latest)}</p>
                <Button variant="primary" icon={<Icon name="pencil" size={16} />} onClick={() => onOpen(latest.pageId)} onPointerEnter={warmDrawing}>
                  {t('Continue drawing')}
                </Button>
              </div>
            </section>
          )}

          {shown.length === 0 ? (
            <div className="ds-empty ds-empty--framed">
              <Icon name="search" />
              <b>{t('No drawings match')}</b>
              <Button size="sm" onClick={() => (setQuery(''), setFilter('all'))}>
                {t('Clear filters')}
              </Button>
            </div>
          ) : (
            groups.map(([title, list]) => (
              <section key={title} className="dr-group" aria-label={title}>
                <h2>{title}</h2>
                <div className="dr-grid">{list.map(card)}</div>
              </section>
            ))
          )}
        </>
      )}
      {menu}
    </Screen>
  )
}
