import { useEffect, type MouseEvent } from 'react'
import type { Page } from './repo'
import { ActionGrid, ActionTile, Facts, Icon, IconButton, Row, useMenu } from './design-system'
import { PageIcon } from './PageIcon'
import { ago } from './ui'
import { repo } from './store'
import { t } from './i18n'
import { printPage } from './print'

interface Props {
  open: boolean
  page: Page
  pages: Page[]
  onClose: () => void
  onOpen: (id: string) => void
  onNewSub: () => void
  onCover: (anchor: DOMRect) => void
  onExport: () => void
}

const LIMIT = 8

// the words of a page, for its length and reading time
const textOf = (node: unknown): string => {
  const n = node as { text?: string; content?: unknown[] } | null
  if (!n || typeof n !== 'object') return ''
  return n.text ?? (n.content ?? []).map(textOf).join(' ')
}

/**
 * The page's side panel, opposite the sidebar: the page itself (name, length, reading time, last edit), what can be done with it
 * (a grid of actions), its outline, and where to go next. Things the app offers everywhere (search, favourite, settings) stay in
 * the top bar and the sidebar.
 */
export function PagePanel({ open, page, pages, onClose, onOpen, onNewSub, onCover, onExport }: Props) {
  const { open: openMenu, menu } = useMenu()
  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.lightbox, .ds-pop, .slash-menu') && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [open, onClose])

  const real = pages.filter((p) => p.kind !== 'folder')
  const byOrder = (a: Page, b: Page) => a.sort - b.sort
  const parent = page.parentId ? real.find((p) => p.id === page.parentId) : undefined
  const kids = real.filter((p) => p.parentId === page.id).sort(byOrder)
  const sibs = real.filter((p) => p.parentId === page.parentId && p.id !== page.id).sort(byOrder)
  const words = open ? textOf(repo.get(page.id)?.content ?? page.content).trim().split(/\s+/).filter(Boolean).length : 0
  const pageRow = (p: Page, up?: boolean) => (
    <Row
      key={p.id}
      as="button"
      className="pp-row"
      icon={<span className="pp-ic">{up ? <Icon name="arrow-up" size={16} /> : <PageIcon page={p} />}</span>}
      text={p.title || t('Untitled')}
      onClick={() => onOpen(p.id)}
      onContextMenu={(e: MouseEvent<HTMLElement>) => {
        e.preventDefault()
        openMenu([{ label: 'Open page', icon: <Icon name="arrow-right" className="ds-flip" />, onSelect: () => onOpen(p.id) }], e)
      }}
    />
  )
  const more = (n: number) => n > LIMIT && <p className="pp-note">{t('and {n} more', { n: n - LIMIT })}</p>

  return (
    <aside className={'page-drawer' + (open ? ' open' : '')} aria-label={t('Page')} aria-hidden={!open} inert={!open}>
      <header className="pp-head">
        <span className="pp-page-ic">
          <PageIcon page={page} />
        </span>
        <h3 dir="auto">{page.title || t('Untitled')}</h3>
        <IconButton label={t('Close  Esc')} onClick={onClose}>
          <Icon name="x" size={16} />
        </IconButton>
      </header>
      <div className="pp-scroll">
        <Facts
          className="pp-facts"
          items={[
            [t('Words'), words.toLocaleString()],
            [t('Reading time'), t('{n} min read', { n: Math.max(1, Math.round(words / 200)) })],
            [t('Subpages'), kids.length.toLocaleString()],
            [t('Last edited'), ago(page.updatedAt)],
          ]}
        />

        <section className="pp-section">
          <h4>{t('Actions')}</h4>
          <ActionGrid>
            <ActionTile icon={<Icon name="plus" />} label={t('Subpage')} onClick={onNewSub} />
            <ActionTile icon={<Icon name="image" />} label={t('Cover')} onClick={(e) => onCover(e.currentTarget.getBoundingClientRect())} />
            <ActionTile icon={<Icon name="history" />} label={t('History')} onClick={() => window.dispatchEvent(new Event('open-history'))} />
            <ActionTile icon={<Icon name="book" />} label={t('Reader mode')} onClick={() => (onClose(), window.dispatchEvent(new Event('toggle-reader')))} />
            <ActionTile icon={<Icon name="file-text" />} label="Markdown" onClick={onExport} />
            <ActionTile icon={<Icon name="printer" />} label={t('Print / PDF')} onClick={() => printPage(page.title)} />
          </ActionGrid>
        </section>

        {/* filled by PageView (it owns the editor): outline of the page's headings */}
        <div id="outline-slot" className="pp-section" />

        <section className="pp-section">
          <h4>{t('Navigation')}</h4>
          {parent && (
            <>
              <h5>{t('Parent page')}</h5>
              {pageRow(parent, true)}
            </>
          )}
          <h5 className="pp-subhead">
            {t('Subpages')}
            <IconButton label={t('Subpage')} onClick={onNewSub}>
              <Icon name="plus" size={14} />
            </IconButton>
          </h5>
          {kids.slice(0, LIMIT).map((p) => pageRow(p))}
          {more(kids.length)}
          {kids.length === 0 && <p className="pp-note">{t('No subpages yet.')}</p>}
          {sibs.length > 0 && (
            <>
              <h5>{t('Siblings')}</h5>
              {sibs.slice(0, LIMIT).map((p) => pageRow(p))}
              {more(sibs.length)}
            </>
          )}
        </section>
      </div>
      {menu}
    </aside>
  )
}
