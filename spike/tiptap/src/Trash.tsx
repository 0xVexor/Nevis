import { Button, Icon, IconButton, dirOf } from './design-system'
import { iconNode } from './iconSet'
import type { Page } from './repo'
import { ago } from './ui'
import { t } from './i18n'

const DAY = 86_400_000

/** Deleted pages and folders, kept for a while. Restoring puts a page back where it was; deleting here is permanent. */
export function Trash({ items, days, onRestore, onPurge, onEmpty }: { items: Page[]; days: number; onRestore: (id: string) => void; onPurge: (page: Page) => void; onEmpty: () => void }) {
  const daysLeft = (page: Page) => Math.max(0, days - Math.floor((Date.now() - page.deletedAt!) / DAY))
  return (
    <div className="tr">
      <header className="tr-head">
        <div>
          <h1>{t('Trash')}</h1>
          <p>{t('Pages are deleted permanently after {days} days.', { days })}</p>
        </div>
        {items.length > 0 && (
          <Button variant="danger" icon={<Icon name="trash" size={16} />} onClick={onEmpty}>
            {t('Empty trash')}
          </Button>
        )}
      </header>
      {items.length === 0 ? (
        <div className="ds-empty">
          <Icon name="trash" />
          <span>{t('The trash is empty')}</span>
        </div>
      ) : (
        <div className="ds-list tr-list">
          {items.map((page) => (
            <div key={page.id} dir={dirOf(page.title)} className="ds-list-row">
              <span className="ds-list-ic">{iconNode(page.icon, 18, <Icon name={page.kind === 'folder' ? 'folder' : 'file'} />)}</span>
              <span className="ds-list-main">
                <b dir="auto">{page.title || (page.kind === 'folder' ? t('Untitled folder') : t('Untitled'))}</b>
                <small>
                  {ago(page.deletedAt!)} · {t('{n} days left', { n: daysLeft(page) })}
                </small>
              </span>
              <span className="ds-list-acts">
                <Button size="sm" variant="ghost" icon={<Icon name="undo" size={16} />} onClick={() => onRestore(page.id)}>
                  {t('Restore')}
                </Button>
                <IconButton label={t('Delete permanently')} onClick={() => onPurge(page)}>
                  <Icon name="trash" size={16} />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
