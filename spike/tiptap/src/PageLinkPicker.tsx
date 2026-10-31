import { useMemo, useState } from 'react'
import { repo } from './store'
import { normalizeFa } from './normalize'
import { iconNode } from './iconSet'
import * as Ic from './icons'
import { t } from './i18n'

/** Picker for "make the selected text a link to a page": search the pages, or create one named like the text. */
export function PageLinkPicker({ text, currentId, onPick }: { text: string; currentId?: string; onPick: (id: string | null) => void }) {
  const [q, setQ] = useState(text.length <= 40 ? text : '')
  const [sel, setSel] = useState(0)
  const nq = normalizeFa(q).trim()
  const pages = useMemo(
    () =>
      repo
        .pagesOnly()
        .filter((p) => p.id !== currentId && (!nq || normalizeFa(p.title).includes(nq)))
        .sort((a, b) => Number(normalizeFa(b.title).trim() === nq) - Number(normalizeFa(a.title).trim() === nq) || b.updatedAt - a.updatedAt)
        .slice(0, 8),
    [nq, currentId],
  )
  const exact = repo.pagesOnly().some((p) => normalizeFa(p.title).trim() === nq)
  const canCreate = !!q.trim() && !exact
  const count = pages.length + (canCreate ? 1 : 0)
  const choose = (i: number) => (i < pages.length ? onPick(pages[i].id) : canCreate && onPick(null))
  return (
    <div className="plp">
      <div className="plp-search">
        <Ic.Search size={15} />
        <input
          autoFocus
          dir="auto"
          value={q}
          placeholder={t('Search pages…')}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => (count ? (s + 1) % count : 0)))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => (count ? (s - 1 + count) % count : 0)))
            else if (e.key === 'Enter') (e.preventDefault(), choose(sel))
          }}
        />
      </div>
      <div className="plp-list" role="listbox">
        {pages.map((p, i) => (
          <button key={p.id} type="button" role="option" aria-selected={i === sel} className={'ds-menu-item' + (i === sel ? ' hot' : '')} onMouseMove={() => setSel(i)} onClick={() => onPick(p.id)}>
            <span className="ds-menu-ic">{iconNode(p.icon, 15, <Ic.Page size={15} />)}</span>
            <span className="ds-menu-label" dir="auto">{p.title || t('Untitled')}</span>
          </button>
        ))}
        {canCreate && (
          <button type="button" className={'ds-menu-item' + (sel === pages.length ? ' hot' : '')} onMouseMove={() => setSel(pages.length)} onClick={() => onPick(null)}>
            <span className="ds-menu-ic"><Ic.Plus size={15} /></span>
            <span className="ds-menu-label"><b>{t('Create a new page')}</b><small dir="auto">{q.trim()}</small></span>
          </button>
        )}
        {count === 0 && <div className="lang-none">{t('No page found')}</div>}
      </div>
    </div>
  )
}
