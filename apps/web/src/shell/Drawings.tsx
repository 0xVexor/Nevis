// @ts-nocheck -- copied from the old app, where this ran as written; the new tsconfig's stricter index checks are not applied to copied code.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Button, Icon, IconButton, Screen, SearchField, dirOf, useMenu, type MenuItem } from '../ds'
import { ago } from './ago'
import { t, locale } from '../i18n'

type Filter = 'all' | 'board' | 'inline'

const DAY = 24 * 3600 * 1000

/** What one drawing of the list needs (a drawing block of a page; the page's title and last edit stand for it). */
export interface DrawingInfo { key: string; pageId: string; title: string; updatedAt: number; source: 'board' | 'inline'; preview: string; /** reads the scene (JSON text) of this drawing, for its thumbnail */ loadScene?: () => Promise<string> }
const warmDrawing = () => undefined
/** The drawing's picture, drawn from its scene when the card scrolls into view; a pencil while nothing is drawn (or while it loads). */
function Thumb({ load }: { load?: () => Promise<string> }) {
  const host = useRef<HTMLSpanElement>(null)
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const el = host.current?.parentElement // the visible box (the picture's own slot has none)
    if (!el || !load) return
    let live = true
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      io.disconnect()
      void load().then(async json => { const { drawingSvg } = await import('@nevis/editor'); return drawingSvg(json) }).then(svg => { if (live && svg && host.current) { host.current.append(svg); setDrawn(true) } }, e => console.warn('drawing thumb', e))
    })
    io.observe(el)
    return () => { live = false; io.disconnect() }
  }, [load])
  // the picture goes into an element React never puts children in; the pencil is React's, and goes when the picture is there
  return <span className={drawn ? 'dr-pic' : 'dr-blank'}>{!drawn && <Icon name="pencil" size={24} />}<span ref={host} className="dr-svg" /></span>
}

/**
 * Every drawing in one place: whole-page boards and drawing blocks inside pages. The one edited last waits on its own
 * board to be continued; the rest follow by when they were last touched. Right-click a drawing for its actions.
 */
export function Drawings({ all, onOpen, onNew, onDelete }: { all: DrawingInfo[]; onOpen: (id: string) => void; onNew: () => void; onDelete: (d: DrawingInfo) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const { open: openMenu, menu } = useMenu()
  const q = query.trim().toLowerCase()
  const shown = all.filter((d) => (filter === 'all' || d.source === filter) && (!q || (d.title || t('Untitled')).toLowerCase().includes(q)))
  const boards = 0 // a whole-page board is a page that holds one drawing: it is listed with the others
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
          <Thumb load={d.loadScene} />
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
                <Thumb load={latest.loadScene} />
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
