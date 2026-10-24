import { useEffect, type ReactNode } from 'react'
import type { Page } from './repo'
import * as Ic from './icons'
import { PageIcon } from './PageIcon'
import { t } from './i18n'
import { printPage } from './print'

interface Props {
  open: boolean
  page: Page
  pages: Page[]
  onClose: () => void
  onOpen: (id: string) => void
  onNewSub: () => void
  onFav: () => void
  onCover: (anchor: DOMRect) => void
  onSearch: () => void
  onExport: () => void
  onSettings: () => void
}

const Row = ({ icon, label, on, onClick }: { icon: ReactNode; label: string; on?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) => (
  <button className={'pd-row' + (on ? ' on' : '')} onClick={onClick}>
    <span className="pd-ic">{icon}</span>
    <span className="pd-tx" dir="auto">{label}</span>
  </button>
)

const LIMIT = 8

/** Slide-out drawer on the side opposite the sidebar: shortcuts for the current page, its outline and where to go next. */
export function PagePanel({ open, page, pages, onClose, onOpen, onNewSub, onFav, onCover, onSearch, onExport, onSettings }: Props) {
  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.lightbox, .popover, .slash-menu') && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [open, onClose])

  const real = pages.filter((p) => p.kind !== 'folder')
  const byOrder = (a: Page, b: Page) => a.sort - b.sort
  const parent = page.parentId ? real.find((p) => p.id === page.parentId) : undefined
  const kids = real.filter((p) => p.parentId === page.id).sort(byOrder)
  const sibs = real.filter((p) => p.parentId === page.parentId && p.id !== page.id).sort(byOrder)
  const pageRow = (p: Page, up?: boolean) => <Row key={p.id} icon={up ? <Ic.Up size={16} /> : <PageIcon page={p} />} label={p.title || t('Untitled')} onClick={() => onOpen(p.id)} />
  const more = (n: number) => n > LIMIT && <div className="pd-note">{t('and {n} more', { n: n - LIMIT })}</div>

  return (
    <aside className={'page-drawer' + (open ? ' open' : '')} aria-hidden={!open} inert={!open}>
      <div className="pd-head">
        <span>{t('Page')}</span>
        <button className="icon-btn" onClick={onClose} title={t('Close  Esc')}><Ic.Close size={16} /></button>
      </div>
      <div className="pd-scroll">
        <section>
          <h4>{t('Quick actions')}</h4>
          <Row icon={<Ic.Plus />} label={t('Subpage')} onClick={onNewSub} />
          <Row icon={<Ic.Star filled={page.favorite} />} label={t('Favorite')} on={page.favorite} onClick={onFav} />
          <Row icon={<Ic.Image />} label={t('Cover')} onClick={(e) => onCover(e.currentTarget.getBoundingClientRect())} />
          <Row icon={<Ic.Search />} label={t('Search')} onClick={onSearch} />
          <Row icon={<Ic.Markdown />} label="Markdown" onClick={onExport} />
          <Row icon={<Ic.History />} label={t('History')} onClick={() => window.dispatchEvent(new Event('open-history'))} />
          <Row icon={<Ic.Print />} label={t('Print / PDF')} onClick={() => printPage(page.title)} />
          <Row icon={<Ic.Book />} label={t('Reader mode')} onClick={() => (onClose(), window.dispatchEvent(new Event('toggle-reader')))} />
          <Row icon={<Ic.Cards />} label={t('Flashcards')} onClick={() => window.dispatchEvent(new Event('open-cards'))} />
          <Row icon={<Ic.Table />} label={t('Pages table')} onClick={() => window.dispatchEvent(new Event('open-table'))} />
          <Row icon={<Ic.Settings />} label={t('Settings')} onClick={onSettings} />
        </section>

        {/* filled by PageView (it owns the editor): outline of the page's headings */}
        <div id="outline-slot" />

        <section>
          <h4>{t('Navigation')}</h4>
          {parent && (
            <>
              <div className="pd-label">{t('Parent page')}</div>
              {pageRow(parent, true)}
            </>
          )}
          {kids.length > 0 && (
            <>
              <div className="pd-label">{t('Subpages')}</div>
              {kids.slice(0, LIMIT).map((p) => pageRow(p))}
              {more(kids.length)}
            </>
          )}
          {sibs.length > 0 && (
            <>
              <div className="pd-label">{t('Siblings')}</div>
              {sibs.slice(0, LIMIT).map((p) => pageRow(p))}
              {more(sibs.length)}
            </>
          )}
          {!parent && !kids.length && !sibs.length && <div className="pd-note">{t('This page has no parent, subpages or siblings yet.')}</div>}
        </section>
      </div>
    </aside>
  )
}
