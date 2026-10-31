import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { kvGet, kvSet } from './db'
import { repo } from './store'
import { docToHtml, hydrate } from './render'
import { FRESH, extractCards, isDue, label, schedule, type Grade, type RawCard, type Rec } from './srs'
import { bump, countOn, dayKey, lastDays, streak, total, type ReviewLog } from './reviewlog'
import { deviceId, loadLog } from './reviewlogStore'
import { t, locale } from './i18n'
import { PageIcon } from './PageIcon'
import { Icon } from './design-system'

type Store = Record<string, Rec>
type Card = RawCard & { title: string }
const NEW_PER_SESSION = 20
const ALL = '__all__'

/**
 * Flashcards: every toggle in your pages is a card (title = question, body = answer), scheduled with spaced repetition.
 * First a list of decks (one per page that has cards, plus the whole vault), then the review of one deck.
 * Keys while reviewing: Space/Enter show the answer, 1–4 = again / hard / good / easy, Esc goes back.
 */
export function Flashcards({ pageId, onOpenPage, onClose }: { pageId?: string; onOpenPage: (id: string) => void; onClose: () => void }) {
  const [deck, setDeck] = useState<string | null>(pageId ?? null) // null = the list of decks
  const [srs, setSrs] = useState<Store | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [pos, setPos] = useState(0)
  const [shown, setShown] = useState(false)
  const [done, setDone] = useState(0)
  const answerRef = useRef<HTMLDivElement>(null)
  const [log, setLog] = useState<ReviewLog>({})
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => void loadLog().then(setLog), [])
  useEffect(() => void kvGet<Store>('srs').then((s) => setSrs(s ?? {})), [])

  const allCards = useMemo(() => {
    const map = new Map<string, Card>()
    for (const p of repo.pagesOnly()) {
      if (typeof p.content === 'string') continue
      for (const c of extractCards(p.id, p.content)) map.set(c.key, { ...c, title: p.title })
    }
    return map
  }, [])
  const cards = useMemo(() => {
    if (deck === null || deck === ALL) return allCards
    return new Map([...allCards].filter(([, c]) => c.pageId === deck))
  }, [allCards, deck])

  // the decks: the whole vault, then every page that has cards
  const decks = useMemo(() => {
    const stat = (keys: string[]) => {
      const due = srs ? keys.filter((k) => srs[k] && isDue(srs[k])).length : 0
      const fresh = srs ? keys.filter((k) => !srs[k]).length : 0
      return { total: keys.length, due, fresh, learned: keys.length - fresh }
    }
    const byPage = new Map<string, string[]>()
    for (const [k, c] of allCards) byPage.set(c.pageId, [...(byPage.get(c.pageId) ?? []), k])
    return [{ id: ALL, title: t('Whole vault'), ...stat([...allCards.keys()]) }, ...[...byPage].map(([id, keys]) => ({ id, title: repo.get(id)?.title || t('Untitled'), ...stat(keys) }))]
  }, [allCards, srs])

  // (re)build the session queue when the deck changes or the stored schedule first loads
  useEffect(() => {
    if (!srs || deck === null) return
    const keys = [...cards.keys()]
    const dueKeys = keys.filter((k) => srs[k] && isDue(srs[k])).sort((a, b) => srs[a].due - srs[b].due)
    const fresh = keys.filter((k) => !srs[k]).slice(0, NEW_PER_SESSION)
    setQueue([...dueKeys, ...fresh])
    setPos(0)
    setShown(false)
    setDone(0)
  }, [cards, deck, srs === null]) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (e.key === 'Escape') return deck === null ? onClose() : setDeck(null)
      if (deck === null || !card) return
      if (!shown && (e.key === ' ' || e.key === 'Enter')) (e.preventDefault(), setShown(true))
      else if (shown && '1234'.includes(e.key) && e.key.length === 1) rate((Number(e.key) - 1) as Grade)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, shown, rate, onClose, deck])

  const num = (n: number) => n.toLocaleString(locale())
  const left = Math.max(0, queue.length - pos)
  const total0 = done + left
  const pct = total0 ? Math.round((done / total0) * 100) : 0
  const rec = key && srs ? srs[key] : undefined
  const nextDue = srs ? Math.min(...[...cards.keys()].map((k) => srs[k]?.due ?? Infinity).filter((d) => d > Date.now()), Infinity) : Infinity
  const endOfTomorrow = new Date(new Date().setHours(23, 59, 59, 999)).getTime() + 24 * 3600 * 1000
  const dueTomorrow = srs ? [...allCards.keys()].filter((k) => srs[k] && srs[k].due > Date.now() && srs[k].due <= endOfTomorrow).length : 0
  const chart = lastDays(log, 14, Date.now())
  const chartMax = Math.max(1, ...chart.map((d) => d.count))
  const grades: [Grade, string][] = [[0, t('Again')], [1, t('Hard')], [2, t('Good')], [3, t('Easy')]]
  const deckTitle = deck === null ? '' : deck === ALL ? t('Whole vault') : repo.get(deck)?.title || t('Untitled')

  /* ───── the list of decks ───── */
  if (deck === null) {
    const dueAll = decks[0]?.due ?? 0
    const tiles: [string, number, string][] = [
      ['check', countOn(log, dayKey(Date.now())), t('Reviewed today')],
      ['flame', streak(log, Date.now()), t('Day streak')],
      ['history', total(log), t('Reviews in total')],
      ['clock', dueAll, t('Due now')],
      ['calendar', dueTomorrow, t('Due tomorrow')],
    ]
    return (
      <div className="fcv">
        <header className="fcv-head">
          <h1>{t('Flashcards')}</h1>
          <p>{t('Every toggle block becomes a card. The title is the question.')}</p>
        </header>
        {!srs ? null : allCards.size === 0 ? (
          <div className="ds-empty ds-card fcv-empty">
            <b>{t('No cards yet.')}</b>
            <p>{t('Every Toggle block with a title and content becomes a card: the title is the question, the content is the answer. Add one with /toggle.')}</p>
          </div>
        ) : (
          <>
            <div className="fcv-decks">
              {decks.map((d) => {
                const page = d.id === ALL ? null : repo.get(d.id)
                return (
                  <button type="button" key={d.id} className="fcv-deck" onClick={() => setDeck(d.id)}>
                    <span className="fcv-deck-top">
                      <span className="ds-tile ds-tile--md">{page ? <PageIcon page={page} /> : <Icon name="cards" />}</span>
                      <span><b dir="auto">{d.title}</b><small>{num(d.total)} {t('cards')}</small></span>
                    </span>
                    <span className="ds-progress"><i style={{ width: (d.total ? (d.learned / d.total) * 100 : 0) + '%' }} /></span>
                    <span className="fcv-deck-foot">
                      <span><b>{num(d.due + Math.min(d.fresh, NEW_PER_SESSION))}</b> <span className="ds-muted">{t('due')}</span></span>
                      <span className="ds-btn ds-btn--primary ds-btn--sm">{t('Review')}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <section className="fcv-stats">
              <h2>{t('Statistics')}</h2>
              <div className="fcv-tiles">
                {tiles.map(([ic, n, name]) => (
                  <div key={name} className="ds-card fcv-tile">
                    <span className="ds-tile ds-tile--md"><Icon name={ic} /></span>
                    <b>{num(n)}</b>
                    <small>{name}</small>
                  </div>
                ))}
              </div>
              <h2>{t('Last 14 days')}</h2>
              <div className="ds-card fcv-chart" onMouseLeave={() => setHover(null)}>
                {chart.map((d, i) => (
                  <span key={d.day} className={'fcv-bar-col' + (hover === i ? ' on' : '') + (hover !== null && hover !== i ? ' dim' : '')} style={{ ['--i' as string]: i }} onMouseEnter={() => setHover(i)}>
                    {hover === i && (
                      <span className="fcv-tip" role="status">
                        <b>{t('{n} of {m} cards', { n: num(d.count), m: num(allCards.size) })}</b>
                        <small>{new Date(d.day + 'T12:00:00').toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric' })}</small>
                      </span>
                    )}
                    <i style={{ height: `${Math.max(4, (d.count / chartMax) * 100)}%`, opacity: d.count ? 1 : 0.25 }} />
                  </span>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    )
  }

  /* ───── reviewing one deck ───── */
  return (
    <div className="fcv fcv-review">
      <div className="fcv-bar">
        <button type="button" className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => setDeck(null)}><Icon name="arrow-left" size={15} className="ds-flip" />{t('Back')}</button>
        <span className="ds-muted fcv-title" dir="auto">{deckTitle}</span>
        {card && <span className="ds-muted fcv-count">{t('Card')} {num(done + 1)} {t('of')} {num(total0)}</span>}
        <span className="ds-progress fcv-prog"><i style={{ width: pct + '%' }} /></span>
      </div>

      {!srs ? null : !card ? (
        <div className="fcv-end">
          <span className="ds-tile ds-tile--lg"><Icon name={cards.size === 0 ? 'cards' : 'check'} size={26} /></span>
          <h2>{cards.size === 0 ? t('No cards yet.') : t('All done for now!')}</h2>
          <p>
            {done ? t('You reviewed {n} cards.', { n: done }) + ' ' : ''}
            {Number.isFinite(nextDue) ? t('Next card is due {when}.', { when: new Date(nextDue).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }) : ''}
          </p>
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => setDeck(null)}>{t('Back to decks')}</button>
        </div>
      ) : (
        <div className="fcv-stage">
          <div className="fcv-card" key={key}>
            <button type="button" className="fcv-src" onClick={() => onOpenPage(card.pageId)} dir="auto">{card.title || t('Untitled')}<Icon name="external-link" size={12} /></button>
            <div className="fcv-q" dir="auto">{card.question}</div>
            {shown && <div className="fcv-a tiptap" ref={answerRef} dangerouslySetInnerHTML={{ __html: html }} />}
          </div>
          {!shown ? (
            <button type="button" className="ds-btn ds-btn--primary fcv-show" onClick={() => setShown(true)}>{t('Show answer')}</button>
          ) : (
            <div className="fcv-grades">
              {grades.map(([g, name]) => (
                <button key={g} type="button" className={'fcv-g g' + g} onClick={() => rate(g)}>
                  <b>{name}</b>
                  <small>{label(rec ?? FRESH, g)}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
