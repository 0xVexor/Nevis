// Feed: the body of every item as a stacked card (truncated, never modified), selected properties, comment and view counts.
// A view is counted once per person, page and day, after the card was visible for two seconds.
import { useEffect, useRef, useState } from 'react'
import type { Id } from '../model/types.ts'
import { FEED_VISIBLE_MS, feedCounts } from '../viewLogic.ts'
import { repo } from '../../store'
import { urlFor } from '../../attachments'
import { t } from '../../i18n'
import { ago } from '../../ui'
import * as Ic from '../../icons'
import { CellView, useNav } from './CellView'
import { CommentsThread } from './Comments'
import { errorText, plainTitle } from './common'
import { useViewQuery } from './useViewQuery'
import type { ViewProps } from './viewTypes'

type PM = { type?: string; text?: string; attrs?: { src?: string; level?: number }; content?: PM[] }

function preview(doc: PM | undefined, max = 420): { text: string[]; image: string | null; cut: boolean } {
  const text: string[] = []
  let image: string | null = null
  let n = 0
  let cut = false
  const walk = (node: PM) => {
    if (cut) return
    if (node.type === 'image' && !image && node.attrs?.src?.startsWith('att:')) image = node.attrs.src.slice(4)
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem') {
      const s = flat(node)
      if (s.trim()) {
        text.push(s)
        n += s.length
        if (n > max) cut = true
      }
      return
    }
    for (const c of node.content ?? []) walk(c)
  }
  const flat = (node: PM): string => node.text ?? (node.content ?? []).map(flat).join('')
  if (doc) walk(doc)
  return { text, image, cut: cut || n > max }
}

function FeedCard({ svc, id, ctl, props }: { svc: ViewProps['svc']; id: Id; ctl: ViewProps['ctl']; props: ReturnType<ViewProps['svc']['state']['props']> }) {
  const nav = useNav()
  const ref = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [img, setImg] = useState<string | null>(null)
  const row = svc.state.row(id)
  const page = repo.getRaw(id)
  const pv = preview(page?.content)
  useEffect(() => {
    let live = true
    if (pv.image) void urlFor('att:' + pv.image).then((u) => live && setImg(u))
    return () => void (live = false)
  }, [pv.image])
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let timer = 0
    const io = new IntersectionObserver(([e]) => {
      window.clearTimeout(timer)
      if (e.isIntersecting) timer = window.setTimeout(() => void svc.tryExec([{ type: 'feed.view', payload: { pageId: id, visibleMs: FEED_VISIBLE_MS + 1, zone: svc.zone } }]), FEED_VISIBLE_MS)
    }, { threshold: 0.6 })
    io.observe(el)
    return () => { io.disconnect(); window.clearTimeout(timer) }
  }, [id, svc])
  if (!row) return null
  const counts = feedCounts(svc.state, id)
  const author = row.page.recordMeta?.createdBy ? svc.state.get('principal', row.page.recordMeta.createdBy)?.displayName : null
  return (
    <article ref={ref} className="db-feed-card">
      <header>
        <button type="button" className="db-feed-title" dir="auto" onClick={() => nav.openRow(id, 'side')}>{plainTitle(row.page.title)}</button>
        <small>{author ? `${author} · ` : ''}{ago(row.page.recordMeta?.createdAt ?? row.page.updatedAt)}</small>
      </header>
      <div className="db-feed-props">{props.map((d) => <span key={d.id}><CellView svc={svc} rs={ctl.rs} row={row} def={d} compact /></span>)}</div>
      {pv.text.length > 0 && <div className="db-feed-body" dir="auto">{pv.text.slice(0, 4).map((s, i) => <p key={i}>{s}</p>)}{pv.cut && <button type="button" className="db-linkbtn" onClick={() => nav.openRow(id, 'side')}>{t('Open the page to read more')}</button>}</div>}
      {img && <img className="db-feed-img" src={img} alt="" loading="lazy" />}
      <footer>
        <span title={t('Views')}><Ic.Eye size={12} /> {counts.views}</span>
        <button type="button" className="db-linkbtn" aria-expanded={open} onClick={() => setOpen(!open)}><Ic.Quote size={12} /> {counts.comments}</button>
      </footer>
      {open && <CommentsThread svc={svc} pageId={id} propertyId={null} />}
    </article>
  )
}

export function FeedView({ svc, view, ctl }: ViewProps) {
  const cfg = view.configuration as { visibleProperties?: Id[]; counts?: boolean }
  const q = useViewQuery(svc, view, { search: ctl.search, personal: ctl.personal, want: 40 })
  const [more, setMore] = useState(20)
  useEffect(() => { void repo.ensureContent(q.rows.slice(0, more).map((r) => r.pageId)).catch(() => undefined) }, [q.rows.length, more]) // bodies load lazily
  const props = (cfg.visibleProperties ?? svc.state.props(view.sourceId!).map((p) => p.id)).map((id) => svc.state.prop(id)).filter((d): d is NonNullable<typeof d> => !!d && d.kind !== 'title' && d.kind !== 'button').slice(0, 3)
  if (q.error) return <div className="db-error-box" role="alert">{errorText(q.error.code, q.error.message)}</div>
  return (
    <div className="db-feed">
      {q.rows.slice(0, more).map((r) => <FeedCard key={r.pageId} svc={svc} id={r.pageId} ctl={ctl} props={props} />)}
      {q.rows.length > more && <button type="button" className="db-more" onClick={() => setMore(more + 20)}>{t('Load more')}</button>}
      {q.total === 0 && <div className="db-empty"><b>{t('Nothing here yet')}</b></div>}
    </div>
  )
}
