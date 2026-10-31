import { useEffect, useMemo, useState } from 'react'
import type { Page, PageStatus } from './repo'
import { normalizeFa } from './normalize'
import { STATUS, allTags, wordCount } from './meta'
import { ago, Select } from './ui'
import { iconNode } from './iconSet'
import * as Ic from './icons'
import { t, locale } from './i18n'

type SortKey = 'title' | 'path' | 'status' | 'updatedAt' | 'words'

const ORDER: Record<string, number> = { todo: 1, doing: 2, done: 3 }

/** Every page as a table: filter by text, tag and status; sort by any column; change the status in place. */
export function PagesTable({ pages, onOpen, onStatus, onClose }: { pages: Page[]; onOpen: (id: string) => void; onStatus: (id: string, s: PageStatus | undefined) => void; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const [q, setQ] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [status, setStatus] = useState<'' | PageStatus | 'none'>('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'updatedAt', dir: -1 })

  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const real = useMemo(() => pages.filter((p) => p.kind !== 'folder'), [pages])
  const pathOf = (p: Page) => {
    const parts: string[] = []
    for (let c = p.parentId ? byId.get(p.parentId) : undefined; c; c = c.parentId ? byId.get(c.parentId) : undefined) parts.unshift(c.title || '…')
    return parts.join(' / ')
  }
  const tagList = useMemo(() => allTags(real), [real])

  const rows = useMemo(() => {
    const words = normalizeFa(q).split(/\s+/).filter(Boolean)
    const list = real
      .filter((p) => !words.length || words.every((w) => normalizeFa(`${p.title} ${(p.tags ?? []).join(' ')} ${pathOf(p)}`).includes(w)))
      .filter((p) => tags.every((t) => (p.tags ?? []).some((x) => normalizeFa(x) === normalizeFa(t))))
      .filter((p) => (status === '' ? true : status === 'none' ? !p.status : p.status === status))
      .map((p) => ({ p, path: pathOf(p), words: wordCount(p.content) }))
    const val = (r: (typeof list)[number]) =>
      sort.key === 'title' ? r.p.title : sort.key === 'path' ? r.path : sort.key === 'status' ? (r.p.status ? ORDER[r.p.status] : 9) : sort.key === 'words' ? r.words : r.p.updatedAt
    return list.sort((a, b) => {
      const x = val(a), y = val(b)
      return (typeof x === 'string' ? x.localeCompare(String(y), 'fa') : (x as number) - (y as number)) * sort.dir
    })
  }, [real, q, tags, status, sort])

  const head = (key: SortKey, label: string) => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))} className={sort.key === key ? 'sorted' : ''}>
      {label}
      {sort.key === key && <span className={'sort-arrow ' + (sort.dir === 1 ? 'asc' : 'desc')}><Ic.Chevron size={11} /></span>}
    </th>
  )

  return (
    <div className="ptv">
      <header className="ptv-head">
        <h1>{t('Pages table')}</h1>
        <p>{t('{n} of {total} pages', { n: rows.length, total: real.length })}</p>
      </header>
      <div className="pt-filters">
        <div className="pt-search"><Ic.Search size={15} /><input autoFocus dir="auto" placeholder={t('Filter by title, tag or path…')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Select
          value={status}
          onChange={(v) => setStatus(v as any)}
          options={[
            { value: '', label: t('All statuses') },
            { value: 'none', label: t('No status') },
            ...(Object.keys(STATUS) as PageStatus[]).map((s) => ({ value: s, label: t(STATUS[s].label), color: STATUS[s].color })),
          ]}
        />
      </div>
      {tagList.length > 0 && (
        <div className="pt-tags">
          {tagList.map((t) => {
            const on = tags.some((x) => normalizeFa(x) === normalizeFa(t))
            return (
              <button key={t} className={'tag-chip' + (on ? ' on' : '')} onClick={() => setTags((s) => (on ? s.filter((x) => normalizeFa(x) !== normalizeFa(t)) : [...s, t]))}>
                {t}
              </button>
            )
          })}
        </div>
      )}
      <div className="ds-table-wrap pt-scroll">
    <table className="ds-table pt">
            <thead>
              <tr>{head('title', t('Page'))}{head('path', t('Path'))}<th>{t('Tags')}</th>{head('status', t('Status'))}{head('words', t('Words'))}{head('updatedAt', t('Updated'))}</tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="modal-empty">{t('No pages match this filter')}</td></tr>}
              {rows.map(({ p, path, words }) => (
                <tr key={p.id} onClick={() => (onOpen(p.id), onClose())}>
                  <td className="pt-title" dir="auto"><span className="ic">{iconNode(p.icon, 15, <Ic.Page size={15} />)}</span>{p.title || t('Untitled')}</td>
                  <td className="pt-path" dir="auto">{path || '—'}</td>
                  <td>{(p.tags ?? []).map((t) => <span key={t} className="tag-chip static">{t}</span>)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Select
                      className={'status-sel' + (p.status ? ' has' : '')}
                      style={p.status ? { ['--st' as any]: STATUS[p.status].color } : undefined}
                      value={p.status ?? ''}
                      onChange={(v) => onStatus(p.id, (v || undefined) as PageStatus | undefined)}
                      options={[{ value: '', label: '—' }, ...(Object.keys(STATUS) as PageStatus[]).map((s) => ({ value: s, label: t(STATUS[s].label), color: STATUS[s].color }))]}
                    />
                  </td>
                  <td className="num">{words.toLocaleString(locale())}</td>
                  <td className="num">{ago(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  </div>
  )
}
