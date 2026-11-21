import { ActionGrid, ActionTile, Icon, Row } from '../ds'
import { go } from '../router'
import { t } from '../i18n'
import type { Workspace } from '../workspace'

const hello = () => { const h = new Date().getHours(); return h < 5 ? 'شب بخیر' : h < 12 ? 'صبح بخیر' : h < 18 ? 'عصر بخیر' : 'شب بخیر' }

/** The start screen: quick actions and the newest pages (one pass over the list, so 10 000 pages cost nothing). */
export function Home({ ws, onNewPage, onNewDatabase }: { ws: Workspace; onNewPage: () => void; onNewDatabase: () => void }) {
  const recent = ws.recent(8)
  return (
    <section className="screen home" data-testid="home" dir="rtl">
      <h1>{hello()}</h1>
      <ActionGrid>
        <ActionTile data-testid="home-new-page" icon={<Icon name="file-text" />} label={t('New page')} onClick={onNewPage} />
        <ActionTile data-testid="home-new-database" icon={<Icon name="table" />} label={t('New database')} onClick={onNewDatabase} />
        <ActionTile icon={<Icon name="templates" />} label={t('Templates')} onClick={() => go({ name: 'templates' })} />
        <ActionTile icon={<Icon name="folder" />} label={t('All pages')} onClick={() => go({ name: 'all' })} />
      </ActionGrid>
      <h2>{t('Recent pages')}</h2>
      {recent.length === 0 ? <p className="small">{t('No pages yet')}</p> : (
        <ul className="plain" data-testid="recent">
          {recent.map(p => (
            <li key={p.id}><Row as="button" icon={<Icon name={p.type === 'database' ? 'table' : 'file-text'} />} text={p.title || 'بدون عنوان'} onClick={() => go({ name: 'page', id: p.id })} /></li>
          ))}
        </ul>
      )}
    </section>
  )
}
