import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { kvGet, kvSet } from './db'
import { repo } from './store'
import { docToHtml, hydrate } from './render'
import { FRESH, extractCards, isDue, label, schedule, type Grade, type RawCard, type Rec } from './srs'
import { bump, countOn, dayKey, lastDays, streak, total, type ReviewLog } from './reviewlog'
import { deviceId, loadLog } from './reviewlogStore'
import { t } from './i18n'
import { Select } from './ui'
import * as Ic from './icons'

type Store = Record<string, Rec>
const NEW_PER_SESSION = 20

/**
 * Review mode: every toggle in your pages is a card (title = question, body = answer), scheduled with spaced repetition.
 * Keys: Space/Enter show the answer, 1–4 = again / hard / good / easy.
 */
export function Flashcards({ pageId, onOpenPage, onClose }: { pageId?: string; onOpenPage: (id: string) => void; onClose: () => void }) {
  const [scope, setScope] = useState<'all' | 'page'>(pageId ? 'page' : 'all')
  const [srs, setSrs] = useState<Store | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [pos, setPos] = useState(0)
  const [shown, setShown] = useState(false)
  const [done, setDone] = useState(0)
  const answerRef = useRef<HTMLDivElement>(null)
  const [log, setLog] = useState<ReviewLog>({})
  const [stats, setStats] = useState(false)
  useEffect(() => void loadLog().then(setLog), [])

  useEffect(() => void kvGet<Store>('srs').then((s) => setSrs(s ?? {})), [])

  const cards = useMemo(() => {
    const map = new Map<string, RawCard & { title: string }>()
    for (const p of repo.pagesOnly()) {
      if (scope === 'page' && p.id !== pageId) continue
      if (typeof p.content === 'string') continue
      for (const c of extractCards(p.id, p.content)) map.set(c.key, { ...c, title: p.title })
    }
    return map
  }, [scope, pageId])

  // (re)build the session queue when the scope or the stored schedule first loads
  const started = useRef(false)
  useEffect(() => {
    if (!srs) return
    started.current = true
    const all = [...cards.keys()]
    const due = all.filter((k) => srs[k] && isDue(srs[k])).sort((a, b) => srs[a].due - srs[b].due)
    const fresh = all.filter((k) => !srs[k]).slice(0, NEW_PER_SESSION)
    setQueue([...due, ...fresh])
    setPos(0)
    setShown(false)
    setDone(0)
  }, [cards, srs === null]) // eslint-disable-line react-hooks/exhaustive-deps

  const key = queue[pos]
  const card = key ? cards.get(key) : undefined
  const html = useMemo(() => (card ? docToHtml(card.answer) : ''), [card])
  useEffect(() => {
    if (shown && answerRef.current) void hydrate(answerRef.current)
  }, [shown, html])

  const rate = useCallback(
    (g: Grade) => {
      if (!key || !srs) return
      const next = { ...srs, [key]: schedule(srs[key], g) }
      setSrs(next)
      void kvSet('srs', next)
      const nextLog = bump(log, deviceId(), dayKey(Date.now())) // counts per day and device, so devices can be merged
      setLog(nextLog)
      void kvSet('reviewlog', nextLog)
      if (g === 0) setQueue((q) => [...q, key]) // "again" comes back before the session ends
      setPos((p) => p + 1)
      setShown(false)
      setDone((d) => d + 1)
    },
    [key, srs, log],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose()
      if (!card) return
      if (!shown && (e.key === ' ' || e.key === 'Enter')) (e.preventDefault(), setShown(true))
      else if (shown && '1234'.includes(e.key) && e.key.length === 1) rate((Number(e.key) - 1) as Grade)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, shown, rate, onClose])

  const left = Math.max(0, queue.length - pos)
  const dueCount = srs ? [...cards.keys()].filter((k) => srs[k] && isDue(srs[k])).length : 0
  const newCount = srs ? [...cards.keys()].filter((k) => !srs[k]).length : 0
  const nextDue = srs ? Math.min(...[...cards.keys()].map((k) => srs[k]?.due ?? Infinity).filter((d) => d > Date.now()), Infinity) : Infinity
  const rec = key && srs ? srs[key] : undefined
  const endOfTomorrow = new Date(new Date().setHours(23, 59, 59, 999)).getTime() + 24 * 3600 * 1000
  const dueTomorrow = srs ? [...cards.keys()].filter((k) => srs[k] && srs[k].due > Date.now() && srs[k].due <= endOfTomorrow).length : 0
  const chart = lastDays(log, 14, Date.now())
  const chartMax = Math.max(1, ...chart.map((d) => d.count))

  const grades: [Grade, string][] = [[0, t('Again')], [1, t('Hard')], [2, t('Good')], [3, t('Easy')]]
  const total0 = done + left
  const pct = total0 ? Math.round((done / total0) * 100) : 0
  const tiles: [React.ReactNode, number, string][] = [
    [<Ic.Check size={18} />, countOn(log, dayKey(Date.now())), t('Reviewed today')],
    [<Ic.Flag size={18} />, streak(log, Date.now()), t('Day streak')],
    [<Ic.History size={18} />, total(log), t('Reviews in total')],
    [<Ic.Clock size={18} />, dueCount, t('Due now')],
    [<Ic.Cards size={18} />, dueTomorrow, t('Due tomorrow')],
    [<Ic.Plus size={18} />, newCount, t('New cards')],
  ]

  return (
    <div className="overlay fc-overlay" onMouseDown={onClose}>
      <div className="fc2" onMouseDown={(e) => e.stopPropagation()}>
        <header className="fc2-head">
          <span className="fc2-logo"><Ic.Cards size={20} /></span>
          <div className="fc2-title">
            <b>{t('Flashcards')}</b>
            <small>{t('{n} to review · {m} new', { n: dueCount, m: newCount })}</small>
          </div>
          <div className="fc2-prog" title={pct + '%'}><i style={{ width: pct + '%' }} /></div>
          <div className="fc-tools">
            {pageId && (
              <Select value={scope} onChange={(v) => setScope(v as 'all' | 'page')} options={[{ value: 'page', label: t('This page only') }, { value: 'all', label: t('All pages') }]} />
            )}
            <button className={'icon-btn' + (stats ? ' active' : '')} onClick={() => setStats((s) => !s)} title={t('Statistics')}><Ic.Panel /></button>
            <button className="icon-btn" onClick={onClose} title={t('Close  Esc')}><Ic.Close /></button>
          </div>
        </header>

        <div className="fc2-main">
          <section className="fc2-stage">
            {!srs ? null : cards.size === 0 ? (
              <div className="fc2-empty">
                <span className="fc2-art"><Ic.Cards size={34} /></span>
                <h3>{t('No cards yet.')}</h3>
                <p>{t('Every Toggle block with a title and content becomes a card: the title is the question, the content is the answer. Add one with /toggle.')}</p>
              </div>
            ) : !card ? (
              <div className="fc2-empty done">
                <span className="fc2-art"><Ic.Check size={34} /></span>
                <h3>{t('All done for now!')}</h3>
                <p>
                  {done ? t('You reviewed {n} cards.', { n: done }) + ' ' : ''}
                  {Number.isFinite(nextDue) ? t('Next card is due {when}.', { when: new Date(nextDue).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }) : ''}
                </p>
                <button className="primary" onClick={onClose}>{t('Close')}</button>
              </div>
            ) : (
              <>
                <div className="fc2-meta">
                  <span className="fc2-count"><b>{done + 1}</b> / {total0}</span>
                  <button className="fc2-src" onClick={() => onOpenPage(card.pageId)} dir="auto"><Ic.Page size={13} />{card.title || t('Untitled')}<Ic.Open size={12} /></button>
                </div>
                <div className={'fc2-card' + (shown ? ' flipped' : '')} key={key}>
                  <span className="fc2-tag">{t('Question')}</span>
                  <div className="fc-q" dir="auto">{card.question}</div>
                  {shown && (
                    <>
                      <span className="fc2-tag ans">{t('Answer')}</span>
                      <div className="fc-a tiptap" ref={answerRef} dangerouslySetInnerHTML={{ __html: html }} />
                    </>
                  )}
                </div>
                {!shown ? (
                  <button className="primary fc-show" onClick={() => setShown(true)}>{t('Show answer')} <kbd>Space</kbd></button>
                ) : (
                  <div className="fc-grades">
                    {grades.map(([g, name]) => (
                      <button key={g} className={'fc-g g' + g} onClick={() => rate(g)}>
                        <kbd>{g + 1}</kbd>
                        <b>{name}</b>
                        <small>{label(rec ?? FRESH, g)}</small>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {stats && srs && (
            <aside className="fc2-side">
              <h4>{t('Statistics')}</h4>
              <div className="fc2-tiles">
                {tiles.map(([ic, n, name]) => (
                  <div key={name} className="fc2-tile">
                    <span className="fc2-tile-ic">{ic}</span>
                    <b>{n}</b>
                    <small>{name}</small>
                  </div>
                ))}
              </div>
              <h4>{t('Last 14 days')}</h4>
              <div className="fc-chart">
                {chart.map((d) => (
                  <i key={d.day} title={`${d.day}: ${d.count}`} style={{ height: `${Math.max(4, (d.count / chartMax) * 100)}%`, opacity: d.count ? 1 : 0.25 }} />
                ))}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
