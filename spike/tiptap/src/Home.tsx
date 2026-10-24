import { useState, type ReactNode } from 'react'
import type { Page } from './repo'
import { CoverThumb } from './Cover'
import { PageIcon } from './PageIcon'
import { MenuItem, Popover, ago } from './ui'
import * as Ic from './icons'
import { locale, t } from './i18n'

interface Props {
  pages: Page[]
  onOpen: (id: string) => void
  onNew: () => void
  onFolder: () => void
  onTable: () => void
  onCards: () => void
  onSearch: () => void
}

const greeting = () => {
  const h = new Date().getHours()
  return h < 5 ? t('Good night') : h < 12 ? t('Good morning') : h < 18 ? t('Good afternoon') : t('Good evening')
}

type Tone = 'violet' | 'blue' | 'green' | 'orange' | 'pink'

const Action = ({ icon, tone, title, hint, onClick }: { icon: ReactNode; tone: Tone; title: string; hint: string; onClick: () => void }) => (
  <button className="hm-act" onClick={onClick}>
    <span className={'hm-tile ' + tone}>{icon}</span>
    <Ic.Arrow size={15} />
    <b>{title}</b>
    <small>{hint}</small>
  </button>
)

const Box = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => (
  <section className="hm-box">
    <header>
      <span className="hm-box-ic">{icon}</span>
      <h3>{title}</h3>
    </header>
    {children}
  </section>
)

/** Landing view: greeting banner, quick actions, recent pages with covers, today's edits and favourites. */
export function Home({ pages, onOpen, onNew, onFolder, onTable, onCards, onSearch }: Props) {
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const real = pages.filter((p) => p.kind !== 'folder').sort((a, b) => b.updatedAt - a.updatedAt)
  const recent = real.slice(0, 4)
  const midnight = new Date().setHours(0, 0, 0, 0)
  const today = real.filter((p) => p.updatedAt >= midnight).slice(0, 6)
  const favs = real.filter((p) => p.favorite).slice(0, 8)
  const date = new Date().toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' })

  const row = (p: Page, meta?: string) => (
    <button key={p.id} className="hm-row" onClick={() => onOpen(p.id)}>
      <span className="hm-row-ic"><PageIcon page={p} /></span>
      <span className="hm-row-t" dir="auto">{p.title || t('Untitled')}</span>
      {meta && <span className="hm-row-m">{meta}</span>}
    </button>
  )

  return (
    <div className="hm">
      <div className="hm-bar">
        <button className="hm-search" onClick={onSearch}>
          <Ic.Search size={16} /><span>{t('Search pages…')}</span><kbd>Ctrl K</kbd>
        </button>
        <div className="hm-new">
          <button className="hm-new-main" onClick={onNew}><Ic.Plus size={16} />{t('New')}</button>
          <button className="hm-new-more" aria-label={t('More')} onClick={(e) => setMenu(e.currentTarget.parentElement!.getBoundingClientRect())}><Ic.Chevron size={14} /></button>
        </div>
      </div>
      {menu && (
        <Popover anchor={menu} align="end" onClose={() => setMenu(null)}>
          <MenuItem icon={<Ic.Page />} label={t('New page')} onClick={() => (setMenu(null), onNew())} />
          <MenuItem icon={<Ic.Folder />} label={t('New folder')} onClick={() => (setMenu(null), onFolder())} />
        </Popover>
      )}

      <div className="hm-grid">
        <div className="hm-main">
          <section className="hm-hero">
            <CoverThumb cover={{ kind: 'gradient', id: 'aurora' }} className="hm-hero-bg" />
            <div className="hm-hero-tx">
              <small>{date}</small>
              <h1>{greeting()} <span className="hm-sun"><Ic.Sun size={30} /></span></h1>
              <p>{t('{n} pages · {m} edited today', { n: real.length, m: today.length })}</p>
              <button className="hm-cta" onClick={onNew}>{t('Start a new page')}<Ic.Arrow size={15} /></button>
            </div>
          </section>

          <div className="hm-acts">
            <Action tone="violet" icon={<Ic.Page size={20} />} title={t('New page')} hint={t('Start with a blank page')} onClick={onNew} />
            <Action tone="blue" icon={<Ic.Folder size={20} />} title={t('New folder')} hint={t('Group related pages')} onClick={onFolder} />
            <Action tone="green" icon={<Ic.Table size={20} />} title={t('Pages table')} hint={t('Browse pages as a table')} onClick={onTable} />
            <Action tone="orange" icon={<Ic.Cards size={20} />} title={t('Flashcards')} hint={t('Review what you studied')} onClick={onCards} />
          </div>

          <div className="hm-sec">
            <h2><Ic.History size={18} />{t('Recent pages')}</h2>
            <button className="hm-link" onClick={onTable}>{t('View all')}<Ic.Arrow size={14} /></button>
          </div>
          {recent.length === 0 ? (
            <div className="hm-empty">{t('No pages yet')}</div>
          ) : (
            <div className="hm-cards">
              {recent.map((p) => (
                <button key={p.id} className="hm-card" onClick={() => onOpen(p.id)}>
                  <CoverThumb cover={p.cover ?? { kind: 'gradient', id: 'peachmist' }} className="hm-card-cover" />
                  <span className="hm-card-b">
                    <span className="hm-row-ic"><PageIcon page={p} /></span>
                    <span className="hm-card-t">
                      <b dir="auto">{p.title || t('Untitled')}</b>
                      <small>{t('Updated {when}', { when: ago(p.updatedAt) })}</small>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="hm-side">
          <Box icon={<Ic.Clock size={18} />} title={t('Edited today')}>
            {today.length ? today.map((p) => row(p, ago(p.updatedAt))) : <div className="hm-empty">{t('Nothing edited today')}</div>}
          </Box>
          <Box icon={<Ic.Star size={18} />} title={t('Pinned')}>
            {favs.length ? favs.map((p) => row(p)) : <div className="hm-empty">{t('Star a page to pin it here')}</div>}
          </Box>
        </aside>
      </div>
    </div>
  )
}
