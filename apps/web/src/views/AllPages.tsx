import { useEffect, useMemo, useState } from 'react'
import { formatDateFa } from '@nevis/core'
import { Button, Icon, Row, SearchField, Screen } from '../ds'
import { go } from '../router'
import { t } from '../i18n'
import type { Workspace } from '../workspace'

const SIZE = 50
const ymd = (ms: number) => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '')

/** Every page and database as a table, one screenful at a time: the whole list is never rendered (10 000 pages). */
export function AllPages({ ws, calendar }: { ws: Workspace; calendar: 'jalali' | 'gregorian' }) {
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  useEffect(() => setOffset(0), [query])
  const { rows, total } = useMemo(() => ws.pageSlice(query, offset, SIZE), [ws, ws.data, query, offset])
  const pages = Math.max(1, Math.ceil(total / SIZE))
  return (
    <Screen title={t('All pages')} width="wide"><div data-testid="all-pages" dir="rtl">
      <SearchField value={query} onChange={setQuery} label={t('Search')} placeholder={t('Search')} clearLabel={t('Clear')} />
      <table className="dstable" data-testid="all-pages-table">
        <thead><tr><th>{t('Page title')}</th><th>{t('Type')}</th><th>{t('Created')}</th></tr></thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.id} data-testid="all-pages-row">
              <td><Row as="button" icon={<Icon name={p.type === 'database' ? 'table' : 'file-text'} />} text={p.title || 'بدون عنوان'} onClick={() => go({ name: 'page', id: p.id })} /></td>
              <td>{p.type === 'database' ? t('Database') : t('Page')}</td>
              <td dir="ltr">{p.createdAt ? (calendar === 'jalali' ? formatDateFa(ymd(p.createdAt)) : ymd(p.createdAt)) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager" data-testid="pager">
        <Button size="sm" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - SIZE))}>{t('Previous')}</Button>
        <span>{Math.floor(offset / SIZE) + 1} {t('of')} {pages} ({total})</span>
        <Button size="sm" disabled={offset + SIZE >= total} onClick={() => setOffset(o => o + SIZE)}>{t('Next')}</Button>
      </div>
    </div></Screen>
  )
}
