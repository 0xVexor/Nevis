import { Icon, Row } from '../ds'
import { iconNode } from '../ds/iconSet'
import { t } from '../i18n'
import { go } from '../router'
import { legacyPages } from '../shell/adapt'
import type { Workspace } from '../workspace'

/** Pages that link here (the old page's `pg-links` section). Found by the target's id, so a rename of this page keeps every backlink. */
export function Backlinks({ ws, id }: { ws: Workspace; id: string }) {
  const from = ws.search.backlinks(id)
  if (!from.length) return null
  const pages = new Map(legacyPages(ws).map(p => [p.id, p]))
  return (
    <section className="pg-links" aria-label={t('Backlinks')} data-testid="backlinks">
      <h2>{t('Backlinks')} <span className="ds-badge">{from.length}</span></h2>
      <div className="pg-link-list">
        {from.map(src => {
          const p = pages.get(src)
          return (
            <Row as="button" key={src} className="pg-link" data-testid="backlink" text={p?.title || t('Untitled')} icon={<span className="pg-link-ic">{iconNode(p?.icon, 16, <Icon name="page" size={16} />)}</span>} onClick={() => go({ name: 'page', id: src })}>
              <span dir="auto">{p?.title || t('Untitled')}</span>
            </Row>
          )
        })}
      </div>
    </section>
  )
}
