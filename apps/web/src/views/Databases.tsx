// Databases and Drawings: the old app's two list screens (list on one side, the chosen item on the other), over this app's data.
import { useMemo } from 'react'
import { Icon } from '../ds'
import { go } from '../router'
import { t } from '../i18n'
import { legacyPages } from '../shell/adapt'
import { Databases as DatabaseList } from '../shell/Databases'
import { Drawings as DrawingList, type DrawingInfo } from '../shell/Drawings'
import type { Page } from '../shell/model'
import type { Workspace } from '../workspace'

export function Databases({ ws }: { ws: Workspace }) {
  const pages = useMemo(() => legacyPages(ws).filter(p => !p.deletedAt).map(p => (ws.data.databases.has(p.id) ? { ...p, dbHost: p.id } : p)), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const preview = (page: Page) => {
    const db = ws.data.databases.get(page.id)
    if (!db) return null
    const live = db.rows.filter(r => !r.trashed)
    return (
      <div className="dbs-peek" data-testid="database-preview">
        <header><h2 dir="auto">{db.title || t('Untitled database')}</h2><p>{t('{n} items', { n: live.length.toLocaleString() })}</p></header>
        <div className="dbs-props">{db.properties.map(p => <span key={p.id} className="ds-chip" dir="auto">{p.name}</span>)}</div>
        <ul className="dbs-rows">{live.slice(0, 8).map(r => <li key={r.id} dir="auto"><Icon name="file" size={14} /> {r.title || t('Untitled')}</li>)}</ul>
      </div>
    )
  }
  return (
    <div data-testid="databases" style={{ display: 'contents' }}>
      <DatabaseList pages={pages} preview={preview} onOpen={id => go({ name: 'page', id })} onNew={() => void ws.newDatabase('').then(id => go({ name: 'page', id }))} onDelete={id => void ws.trash(id)} />
    </div>
  )
}

export function Drawings({ ws }: { ws: Workspace }) {
  const all = useMemo<DrawingInfo[]>(() => {
    const titles = new Map(ws.data.pages.map(p => [p.id, p.title]))
    return ws.search.drawings().map(({ page, drawing }) => ({
      key: `${page}:${drawing.blockId}`, pageId: page, title: titles.get(page) ?? '', updatedAt: ws.search.touchedAt(page), source: (ws.search.wordsOf(page) === 0 ? 'board' : 'inline') as DrawingInfo['source'], preview: '',
    })).sort((a, b) => b.updatedAt - a.updatedAt)
  }, [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = (id: string) => go({ name: 'page', id })
  return (
    <div data-testid="drawings" style={{ display: 'contents' }}>
      <DrawingList all={all} onOpen={open} onNew={() => void ws.newTemplatePage('', { type: 'doc', content: [{ type: 'drawing' }] }).then(open)} onDelete={d => (d.source === 'board' ? void ws.trash(d.pageId) : open(d.pageId))} />
    </div>
  )
}
