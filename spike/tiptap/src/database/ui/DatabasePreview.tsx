// What a database holds, for the Databases screen: its views, its properties and the items edited last. Read-only.
import type { Page } from '../../repo'
import { PageIcon } from '../../PageIcon'
import { repo } from '../../store'
import { Button, Icon, dirOf } from '../../design-system'
import { ago } from '../../ui'
import { t } from '../../i18n'
import { KindIcon, plainTitle, useDb } from './common'
import { ViewIcon } from './viewMeta'

export function DatabasePreview({ page, onOpen }: { page: Page; onOpen: (id?: string) => void }) {
  const svc = useDb()
  const head = (
    <header className="dbs-head" dir={dirOf(page.title)}>
      <span className="dbs-head-ic">
        <PageIcon page={page} />
      </span>
      <h2 dir="auto">{page.title || t('Untitled database')}</h2>
      <Button variant="primary" icon={<Icon name="arrow-up-right" size={16} className="ds-flip" />} onClick={() => onOpen()}>
        {t('Open database')}
      </Button>
    </header>
  )
  if (!svc) return head
  const c = page.dbHost ? svc.state.get('container', page.dbHost) : undefined
  if (!c) return head
  const views = svc.state.viewsOf(c.id).filter((v) => v.parentDashboardId === null)
  const sources = c.sourceLinks.map((l) => svc.state.get('source', l.sourceId)).filter((s): s is NonNullable<typeof s> => !!s && s.deletedAt === null)
  const props = sources.flatMap((s) => svc.state.props(s.id))
  const rows = sources.flatMap((s) => svc.state.rows(s.id)).filter((r) => r.page.deletedAt === null)
  const latest = [...rows].sort((a, b) => b.page.updatedAt - a.page.updatedAt).slice(0, 6)
  return (
    <>
      {head}
      <p className="dbs-line">
        {t('{n} items', { n: rows.length })} · {t('{n} views', { n: views.length })} · {t('{n} properties', { n: props.length })}
        {sources.length > 1 && <> · {t('{n} data sources', { n: sources.length })}</>}
      </p>
      <h3 className="dv-section-head">{t('Views')}</h3>
      <div className="dbs-chips">
        {views.map((v) => (
          <span key={v.id} className="dbs-chip" title={v.name}>
            <ViewIcon type={v.type} size={15} />
            <span dir="auto">{v.name}</span>
          </span>
        ))}
      </div>
      <h3 className="dv-section-head">{t('Properties')}</h3>
      <div className="dbs-chips">
        {props.map((p) => (
          <span key={p.id} className="dbs-chip" title={p.name}>
            <KindIcon kind={p.kind} size={14} />
            <span dir="auto">{p.name}</span>
          </span>
        ))}
      </div>
      <h3 className="dv-section-head">{t('Edited last')}</h3>
      {latest.length === 0 ? (
        <div className="ds-empty ds-empty--framed dbs-empty">
          <span>{t('No items yet. Open the database to add the first one.')}</span>
        </div>
      ) : (
        <div className="ds-list ds-list--framed">
          {latest.map((r) => (
            <button key={r.page.id} type="button" className="ds-list-row" dir={dirOf(r.page.title)} onClick={() => onOpen(r.page.id)}>
              <PageIcon page={repo.getRaw(r.page.id) ?? { id: r.page.id, icon: undefined, kind: undefined }} />
              <span className="ds-list-main">
                <b dir="auto">{plainTitle(r.page.title)}</b>
              </span>
              <small className="ds-muted">{ago(r.page.updatedAt)}</small>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
