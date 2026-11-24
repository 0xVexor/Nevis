import { Button, Icon, IconButton, Screen, dirOf, useMenu } from '../ds'
import { iconNode } from '../ds/iconSet'
import type { Page } from '../shell/model'
import { ago } from '../shell/ago'
import { t } from '../i18n'

/** Deleted pages, kept until the person restores them or deletes them for good (nothing here deletes by itself). Restoring puts a page back where it was. */
export function Trash({ items, onRestore, onPurge, onEmpty }: { items: Page[]; onRestore: (id: string) => void; onPurge: (page: Page) => void; onEmpty: () => void }) {
  const { open, menu } = useMenu()
  return (
    <Screen
      title={t('Trash')}
      description={t('Deleted pages stay here until you restore them or delete them permanently.')}
      actions={
        items.length > 0 && (
          <Button variant="danger" icon={<Icon name="trash" size={16} />} onClick={onEmpty}>
            {t('Empty trash')}
          </Button>
        )
      }
    >
      {items.length === 0 ? (
        <div className="ds-empty ds-empty--framed">
          <Icon name="trash" />
          <span>{t('The trash is empty')}</span>
        </div>
      ) : (
        <div className="ds-list ds-list--framed">
          {items.map((page) => (
            <div key={page.id} dir={dirOf(page.title)} className="ds-list-row" onContextMenu={e => open([
              { label: 'Restore', icon: <Icon name="undo" size={16} />, onSelect: () => onRestore(page.id) },
              { label: 'Delete permanently', icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => onPurge(page) },
            ], e)}>
              <span className="ds-list-ic">{iconNode(page.icon, 18, <Icon name={page.kind === 'folder' ? 'folder' : 'file'} />)}</span>
              <span className="ds-list-main">
                <b dir="auto">{page.title || (page.kind === 'folder' ? t('Untitled folder') : t('Untitled'))}</b>
                <small>
                  {t('Deleted {when}', { when: ago(page.deletedAt!) })}
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
      {menu}
    </Screen>
  )
}
