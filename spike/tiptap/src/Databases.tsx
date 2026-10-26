import { useEffect, useMemo, useState } from 'react'
import { repo } from './store'
import type { Page } from './repo'
import { PageIcon } from './PageIcon'
import { t } from './i18n'
import * as Ic from './icons'

/** Every database in one place: the pages that are the home of a database (their rows are not listed here). */
export function Databases({ onOpen, onNew, onDelete }: { onOpen: (id: string) => void; onNew: () => void; onDelete: (id: string) => void }) {
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    window.addEventListener('data-changed', bump)
    window.addEventListener('external-change', bump)
    return () => (window.removeEventListener('data-changed', bump), window.removeEventListener('external-change', bump))
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => repo.pagesOnly().filter((p: Page) => !!p.dbHost).sort((a, b) => b.updatedAt - a.updatedAt), [tick])
  const q = query.trim().toLowerCase()
  const shown = all.filter((p) => !q || (p.title || t('Untitled database')).toLowerCase().includes(q))
  const parentName = (p: Page) => (p.parentId ? repo.get(p.parentId)?.title || t('Untitled') : t('Top level'))

  return (
    <div className="tk dw dbs">
      <header className="tk-head">
        <h1><Ic.Table size={26} />{t('Databases')}</h1>
        <p>{all.length ? t('{n} databases', { n: all.length }) : t('Databases you create appear here.')}</p>
      </header>

      <div className="dw-tools">
        <input className="dw-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search databases…')} dir="auto" />
        <button className="primary" onClick={onNew}><Ic.Plus size={15} />{t('New database')}</button>
      </div>

      {shown.length === 0 ? (
        <div className="hm-empty">
          {all.length ? t('No databases match') : t('No databases yet')}
          {!all.length && <div><button className="primary" onClick={onNew}>{t('New database')}</button></div>}
        </div>
      ) : (
        <div className="dw-grid">
          {shown.map((p) => (
            <div key={p.id} className="dw-item">
              <button className="dw-card" onClick={() => onOpen(p.id)}>
                <span className="dw-thumb dbs-thumb"><span className="dbs-ic"><PageIcon page={p} /></span><Ic.Table size={30} /></span>
                <span className="dw-meta">
                  <b dir="auto">{p.title || t('Untitled database')}</b>
                  <small dir="auto">{parentName(p)} · {new Date(p.updatedAt).toLocaleDateString()}</small>
                </span>
              </button>
              <button className="dw-del" title={t('Delete')} aria-label={t('Delete')} onClick={() => onDelete(p.id)}><Ic.Trash size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
