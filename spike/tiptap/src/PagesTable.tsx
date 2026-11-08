import { useEffect, useMemo, useState } from 'react'
import type { Page, PageStatus } from './repo'
import { normalizeFa } from './normalize'
import { STATUS, allTags, wordCount } from './meta'
import { ago } from './ui'
import { iconNode } from './iconSet'
import { Button, ChipButton, Dropdown, Icon, Screen, SearchField, Tag, useMenu, type MenuItem } from './design-system'
import { PageStatusChip } from './PageStatusChip'
import { t, locale } from './i18n'

type SortKey = 'title' | 'path' | 'status' | 'updatedAt' | 'words'
type StatusFilter = '' | PageStatus | 'none'

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
  const [status, setStatus] = useState<StatusFilter>('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'updatedAt', dir: -1 })

  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const real = useMemo(() => pages.filter((p) => p.kind !== 'folder'), [pages])
  const pathOf = (p: Page) => {
    const parts: string[] = []
    for (let c = p.parentId ? byId.get(p.parentId) : undefined; c; c = c.parentId ? byId.get(c.parentId) : undefined) parts.unshift(c.title || '…')
    return parts.join(' / ')
  }
  /** A deep path shows its last two folders, the ones that say where the page is; the whole path is in the tooltip. */
  const shortPath = (path: string) => {
    const parts = path.split(' / ')
    return parts.length > 2 ? '… / ' + parts.slice(-2).join(' / ') : path
  }
  const tagList = useMemo(() => allTags(real), [real])
  const { open: openMenu, menu } = useMenu()
  const toggleTag = (tag: string) => setTags((s) => (s.some((x) => normalizeFa(x) === normalizeFa(tag)) ? s.filter((x) => normalizeFa(x) !== normalizeFa(tag)) : [...s, tag]))
  const SHOWN_TAGS = 2
  const isOn = (tag: string) => tags.some((x) => normalizeFa(x) === normalizeFa(tag))
  /** Tags as a menu: picking one filters the table by it (a check mark shows the tags already filtering). */
  const tagMenu = (list: string[]): MenuItem[] => list.map((tag) => ({ label: '#' + tag, raw: true, checked: isOn(tag), onSelect: () => toggleTag(tag) }))
  // the filter row shows the most used tags (and any already picked); the rest wait in a menu, so a big vault stays one row or two
  const used = useMemo(() => {
    const count = new Map<string, number>()
    for (const p of real) for (const tag of p.tags ?? []) count.set(tag, (count.get(tag) ?? 0) + 1)
    return [...tagList].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0))
  }, [real, tagList])
  const chipTags = used.filter((tag, i) => i < 10 || isOn(tag))
  const moreTags = used.filter((tag) => !chipTags.includes(tag))

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
      const x = val(a),
        y = val(b)
      return (typeof x === 'string' ? x.localeCompare(String(y), 'fa') : (x as number) - (y as number)) * sort.dir
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, q, tags, status, sort])

  const filtered = q.trim() !== '' || tags.length > 0 || status !== ''
  const clear = () => (setQ(''), setTags([]), setStatus(''))
  const open = (id: string) => (onOpen(id), onClose())

  /** A column heading that sorts: a real button, with the order announced on the header cell. */
  const head = (key: SortKey, label: string, className?: string) => (
    <th className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="pt-sort" data-on={sort.key === key || undefined} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
        {label}
        <Icon name={sort.key === key && sort.dir === -1 ? 'arrow-down' : 'arrow-up'} size={13} />
      </button>
    </th>
  )

  return (
    <Screen width="wide" title={t('All pages')} description={filtered ? t('{n} of {total} pages', { n: rows.length, total: real.length }) : t('{n} pages', { n: real.length })}>
      <div className="pt-filters">
        <SearchField className="pt-search" value={q} onChange={setQ} label={t('Filter pages')} placeholder={t('Filter by title, tag or path…')} clearLabel={t('Clear')} autoFocus />
        <Dropdown<StatusFilter>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'All statuses' },
            { value: 'none', label: 'No status' },
            ...(Object.keys(STATUS) as PageStatus[]).map((s) => ({ value: s, label: STATUS[s].label })),
          ]}
        />
        {filtered && (
          <Button variant="ghost" icon={<Icon name="x" size={15} />} onClick={clear}>
            {t('Clear filters')}
          </Button>
        )}
      </div>
      {tagList.length > 0 && (
        <div className="pt-tags" role="group" aria-label={t('Filter by tag')}>
          {chipTags.map((tag) => (
            <ChipButton key={tag} aria-pressed={isOn(tag)} icon={<Icon name="hash" size={13} />} onClick={() => toggleTag(tag)}>
              <span dir="auto">{tag}</span>
            </ChipButton>
          ))}
          {moreTags.length > 0 && (
            <ChipButton aria-haspopup="menu" onClick={(e) => openMenu(tagMenu(moreTags), e.currentTarget)}>
              {t('{n} more', { n: moreTags.length })}
              <Icon name="chevron-down" size={14} />
            </ChipButton>
          )}
        </div>
      )}

      <div className="ds-table-wrap pt-wrap">
        <table className="ds-table pt">
          <thead>
            <tr>
              {head('title', t('Page'))}
              {head('path', t('Path'), 'pt-col-path')}
              <th className="pt-col-tags">{t('Tags')}</th>
              {head('status', t('Status'))}
              {head('words', t('Words'), 'pt-num pt-col-words')}
              {head('updatedAt', t('Updated'), 'pt-num')}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="pt-none">
                  <div className="ds-empty">
                    <Icon name="search" />
                    <b>{t('No pages match these filters')}</b>
                    <Button size="sm" onClick={clear}>
                      {t('Clear filters')}
                    </Button>
                  </div>
                </td>
              </tr>
            )}
            {rows.map(({ p, path, words }) => (
              <tr key={p.id} onClick={() => open(p.id)}>
                <td>
                  <button type="button" className="pt-title" onClick={(e) => (e.stopPropagation(), open(p.id))}>
                    <span className="pt-ic">{iconNode(p.icon, 16, <Icon name="file-text" size={16} />)}</span>
                    <span dir="auto">{p.title || t('Untitled')}</span>
                  </button>
                </td>
                <td className="pt-path pt-col-path" dir="auto" title={path || undefined}>
                  {path ? shortPath(path) : '—'}
                </td>
                <td className="pt-col-tags" onClick={(e) => e.stopPropagation()}>
                  <span className="pt-tag-list">
                    {(p.tags ?? []).slice(0, SHOWN_TAGS).map((tag) => (
                      <Tag key={tag} label={tag} onOpen={() => toggleTag(tag)} openLabel={t('Show pages with this tag')} />
                    ))}
                    {(p.tags?.length ?? 0) > SHOWN_TAGS && (
                      <ChipButton
                        className="pt-tag-more"
                        aria-haspopup="menu"
                        aria-label={t('{n} more tags', { n: p.tags!.length - SHOWN_TAGS })}
                        title={p.tags!.slice(SHOWN_TAGS).join(', ')}
                        onClick={(e) => openMenu(tagMenu(p.tags!.slice(SHOWN_TAGS)), e.currentTarget)}
                      >
                        +{(p.tags!.length - SHOWN_TAGS).toLocaleString(locale())}
                      </ChipButton>
                    )}
                  </span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <PageStatusChip status={p.status} onChange={(s) => onStatus(p.id, s)} />
                </td>
                <td className="pt-num pt-col-words">{words.toLocaleString(locale())}</td>
                <td className="pt-num">{ago(p.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {menu}
    </Screen>
  )
}
