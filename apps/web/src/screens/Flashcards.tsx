// Flashcards, drawn as the old app drew them (same markup and classes: fc-today, fc-section, fc-review, fc-card...). The cards are the toggle
// blocks of the pages; the schedule is a fold over the review events (packages/core/src/cards.ts), so a review on another device counts here.
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { intervalLabel, isDue, type Grade, type RawCard, type Rec } from '@nevis/core'
import { Button, Icon, Screen, Stats, dirOf, useMenu, useUIMotion } from '../ds'
import { commandHint, commandMatches } from '../shortcutCommands'
import { locale, t } from '../i18n'
import { go } from '../router'
import type { Workspace } from '../workspace'

const GRADES: { grade: Grade; name: string; tone: string }[] = [
  { grade: 0, name: 'Again', tone: 'again' }, { grade: 1, name: 'Hard', tone: 'hard' }, { grade: 2, name: 'Good', tone: 'good' }, { grade: 3, name: 'Easy', tone: 'easy' },
]
const DAY = 86_400_000
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
const ALL = 'all'
const localizedInterval = (rec: Rec | undefined, grade: Grade, now: number) => {
  const value = intervalLabel(rec, grade, now)
  const match = /^(\d+)(m|d|mo)$/.exec(value)
  if (!match) return value
  const units = { m: 'minute', d: 'day', mo: 'month' } as const
  return new Intl.NumberFormat(locale(), { style: 'unit', unit: units[match[2] as keyof typeof units], unitDisplay: 'short' }).format(Number(match[1]))
}

export function Flashcards({ ws }: { ws: Workspace }) {
  const [data, setData] = useState<{ recs: Map<string, Rec>; times: number[] } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [deck, setDeck] = useState<string | null>(null)
  const [queue, setQueue] = useState<RawCard[]>([])
  const [pos, setPos] = useState(0)
  const motionOf = useUIMotion()
  const { open: openMenu, menu } = useMenu()
  const [done, setDone] = useState(0)
  const [shown, setShown] = useState(false)
  const [rating, setRating] = useState(false)
  const ratingRef = useRef(false)
  const started = useRef(0)
  const reload = useCallback(() => ws.reviewData().then(result => { setData(result); setLoadError(false) }), [ws])
  useEffect(() => { void reload().catch(() => setLoadError(true)) }, [reload, ws.data])
  const cards = ws.search.cards()
  const titleOf = useMemo(() => new Map(ws.data.pages.map(p => [p.id, p.title])), [ws.data])
  const now = Date.now()
  const recs = data?.recs ?? new Map<string, Rec>()
  const dueOf = (list: RawCard[]) => list.filter(c => isDue(recs.get(c.id), now))
  const due = dueOf(cards)
  const num = (n: number) => n.toLocaleString(locale())

  const start = (id: string) => {
    if (ratingRef.current || !data) return
    const list = (id === ALL ? cards : cards.filter(c => c.pageId === id))
    const q = dueOf(list).sort((a, b) => (recs.get(a.id)?.due ?? 0) - (recs.get(b.id)?.due ?? 0))
    setQueue(q); setPos(0); setDone(0); setShown(false); setDeck(id); started.current = Date.now()
  }
  const card = deck !== null ? queue[pos] : undefined
  const rate = useCallback(async (grade: Grade) => {
    if (!card || ratingRef.current) return
    ratingRef.current = true
    setRating(true)
    try {
      await ws.rateCard(card.id, grade, Date.now() - started.current)
      setQueue(q => (grade === 0 ? [...q, card] : q)) // a card you missed comes back before the session ends
      setPos(p => p + 1); setDone(d => d + 1); setShown(false); started.current = Date.now()
      await reload().catch(() => ws.notify(t('Could not complete the action. Please try again.')))
    } catch {
      ws.notify(t('Could not complete the action. Please try again.'))
    } finally {
      ratingRef.current = false
      setRating(false)
    }
  }, [card, ws, reload])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, button, [contenteditable="true"], [role="dialog"]')) return
      if (deck === null) { if (due.length && commandMatches(e, 'Start review')) { e.preventDefault(); start(ALL) }; return }
      if (commandMatches(e, 'End the session')) { e.preventDefault(); if (!ratingRef.current) setDeck(null); return }
      if (!card) return
      if (!shown && commandMatches(e, 'Show the answer')) { e.preventDefault(); setShown(true) }
      else if (shown) { const grade = GRADES.find(item => commandMatches(e, item.name)); if (grade) { e.preventDefault(); void rate(grade.grade) } }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [deck, card, shown, rate, due, cards, recs])

  if (!data) return <Screen className="flashcards-screen" title={t('Flashcards')}><div className="ds-empty" role="status">{loadError ? <><span>{t('Could not complete the action. Please try again.')}</span><Button onClick={() => void reload().catch(() => setLoadError(true))}>{t('Try again')}</Button></> : t('Loading…')}</div></Screen>

  if (deck === null) {
    const decks = [...new Set(cards.map(c => c.pageId))].map(id => {
      const list = cards.filter(c => c.pageId === id)
      return { id, title: titleOf.get(id) || t('Untitled'), total: list.length, learned: list.filter(c => recs.has(c.id) && !isDue(recs.get(c.id), now)).length, due: dueOf(list).length }
    })
    const next = due[0]
    const minutes = Math.max(1, Math.round((due.length * 8) / 60))
    const endOfTomorrow = new Date(new Date().setHours(23, 59, 59, 999)).getTime() + DAY
    const dueTomorrow = cards.filter(c => { const r = recs.get(c.id); return r && r.due > now && r.due <= endOfTomorrow }).length
    const upcoming = Math.min(...cards.map(c => recs.get(c.id)?.due ?? Infinity).filter(d => d > now), Infinity)
    const times = data?.times ?? []
    const perDay = new Map<string, number>()
    for (const ms of times) perDay.set(dayKey(ms), (perDay.get(dayKey(ms)) ?? 0) + 1)
    const chart = Array.from({ length: 14 }, (_, i) => { const d = now - (13 - i) * DAY; return { day: d, count: perDay.get(dayKey(d)) ?? 0 } })
    const chartMax = Math.max(1, ...chart.map(d => d.count))
    let streak = 0
    for (let off = perDay.has(dayKey(now)) ? 0 : 1; perDay.has(dayKey(now - off * DAY)); off++) streak++
    return (
      <Screen className="flashcards-screen" title={t('Flashcards')} description={t('Every toggle block is a card: its title asks, its content answers')}>
        <div data-testid="flashcards">
          {cards.length === 0 ? (
            <div className="ds-empty ds-empty--framed" data-testid="no-cards"><Icon name="toggle" /><b>{t('No cards yet')}</b><span>{t('Add a toggle to any page with /toggle. Write the question as its title and the answer inside.')}</span></div>
          ) : (
            <>
              <section className="fc-today" aria-labelledby="fc-today">
                <div className="fc-stack" data-empty={!due.length || undefined} aria-hidden="true">
                  <span className="fc-stack-card" /><span className="fc-stack-card" />
                  <span className="fc-stack-card fc-stack-top">{due.length > 0 && next ? <><small dir="auto">{titleOf.get(next.pageId) || t('Untitled')}</small><b dir="auto">{next.question}</b></> : <Icon name="check-circle" size={28} />}</span>
                </div>
                <div className="fc-today-text">
                  <h2 id="fc-today" data-testid="fc-due">{due.length === 0 ? t('You are up to date') : due.length === 1 ? t('1 card is waiting') : t('{n} cards are waiting', { n: num(due.length) })}</h2>
                  <p>{due.length > 0 ? t('About {m} min. Cards you miss come back before the session ends.', { m: num(minutes) }) : Number.isFinite(upcoming) ? t('Next card is due {when}.', { when: new Date(upcoming).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) }) : t('Nothing is scheduled yet')}</p>
                  {due.length > 0 && <Button variant="primary" className="fc-start" data-testid="fc-start" onClick={() => start(ALL)}>{t('Start review')}<kbd className="ds-kbd">{commandHint('Start review')}</kbd></Button>}
                  <Stats className="fc-facts" label={t('Statistics')} items={[
                    { label: t('reviewed today'), value: num(perDay.get(dayKey(now)) ?? 0) }, { label: t('day streak'), value: num(streak) },
                    { label: t('due tomorrow'), value: num(dueTomorrow) }, { label: t('reviews in total'), value: num(times.length) },
                  ]} />
                </div>
              </section>
              <section className="fc-section" aria-labelledby="fc-decks">
                <h2 id="fc-decks">{t('Decks')}</h2>
                <div className="ds-list ds-list--framed">
                  {decks.map(d => {
                    const pct = d.total ? Math.round((d.learned / d.total) * 100) : 0
                    return (
                      <div key={d.id} className="ds-list-row fc-deck" dir={dirOf(d.title)} onContextMenu={e => openMenu([
                        { label: 'Review', icon: <Icon name="cards" />, disabled: !d.due, onSelect: () => start(d.id) },
                        { label: 'Open source page', icon: <Icon name="file" />, onSelect: () => go({ name: 'page', id: d.id }) },
                      ], e)}>
                        <span className="fc-deck-ic"><Icon name="cards" /></span>
                        <span className="ds-list-main"><b dir="auto">{d.title}</b><small>{t(d.total === 1 ? '1 card, {m} learned' : '{n} cards, {m} learned', { n: num(d.total), m: num(d.learned) })}</small></span>
                        <span className="ds-progress fc-meter" role="progressbar" aria-label={t('Learned')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ inlineSize: pct + '%' }} /></span>
                        <span className="fc-due" data-zero={!d.due || undefined}>{d.due ? t('{n} due', { n: num(d.due) }) : t('Up to date')}</span>
                        <button type="button" className="fc-mobile-source" aria-label={t('Open source page')} title={t('Open source page')} onClick={() => go({ name: 'page', id: d.id })}><Icon name="arrow-up-right" size={17} className="ds-flip" /><span>{t('Open page')}</span></button>
                        <Button size="sm" variant={d.due ? 'default' : 'ghost'} onClick={() => start(d.id)}>{t('Review')}</Button>
                      </div>
                    )
                  })}
                </div>
              </section>
              <section className="fc-section" aria-labelledby="fc-days">
                <div className="fc-chart-head"><h2 id="fc-days">{t('Last 14 days')}</h2><span>{t('{n} reviews in these 14 days', { n: num(chart.reduce((a, d) => a + d.count, 0)) })}</span></div>
                <div className="fc-days" role="list" aria-label={t('Reviews per day')}>
                  {chart.map((d, i) => <span key={d.day} role="listitem" className="fc-day" data-today={i === chart.length - 1 || undefined} style={{ '--level': d.count ? 0.25 + 0.75 * (d.count / chartMax) : 0 } as CSSProperties} aria-label={t('{n} reviews on {day}', { n: num(d.count), day: new Date(d.day).toLocaleDateString(locale(), { weekday: 'long', month: 'short', day: 'numeric' }) })} />)}
                </div>
              </section>
            </>
          )}
        </div>
        {menu}
      </Screen>
    )
  }

  const left = Math.max(0, queue.length - pos)
  const total = done + left
  const pct = total ? Math.round((done / total) * 100) : 0
  const rec = card ? recs.get(card.id) : undefined
  const deckTitle = deck === ALL ? t('All decks') : titleOf.get(deck) || t('Untitled')
  return (
    <div className="fc-review" data-testid="fc-review">
      <div className="fc-top">
        <Button variant="ghost" size="sm" icon={<Icon name="arrow-left" size={16} className="ds-flip" />} disabled={rating} onClick={() => setDeck(null)}>{t('Decks')}</Button>
        <b className="fc-top-title" dir="auto">{deckTitle}</b>
        {card && <span className="fc-top-count">{t('{n} of {m}', { n: num(done + 1), m: num(total) })}</span>}
      </div>
      <div className="ds-progress fc-top-progress" role="progressbar" aria-label={t('Session progress')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ inlineSize: pct + '%' }} /></div>
      {!card ? (
        <div className="ds-empty fc-done" data-testid="fc-done">
          <Icon name="check-circle" /><b>{t('All done for now')}</b>
          <span>{done ? t(done === 1 ? 'You reviewed 1 card.' : 'You reviewed {n} cards.', { n: num(done) }) : ''}</span>
              <Button variant="primary" disabled={rating} onClick={() => setDeck(null)}>{t('Back to decks')}</Button>
        </div>
      ) : (
        <div className="fc-stage">
          <motion.article key={`${pos}`} className="fc-card" aria-live="polite" initial={motionOf.reduced ? false : { opacity: 0, x: document.documentElement.dir === 'rtl' ? -28 : 28 }} animate={{ opacity: 1, x: 0 }} transition={motionOf.spring}>
            <button type="button" className="fc-source" onClick={() => go({ name: 'page', id: card.pageId })} dir="auto" title={t('Open the page')}>{titleOf.get(card.pageId) || t('Untitled')}<Icon name="arrow-up-right" size={13} className="ds-flip" /></button>
            <h2 className="fc-q" dir="auto" data-testid="fc-question" data-long={card.question.length > 90 || undefined}>{card.question}</h2>
            <AnimatePresence initial={false}>{shown && <motion.div key="answer" className="fc-a-wrap" initial={motionOf.reduced ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={motionOf.reduced ? undefined : { opacity: 0, height: 0 }} transition={motionOf.transition}><div className="fc-a tiptap" data-testid="fc-answer">{card.answer.split('\n').map((l, i) => <p key={i} dir="auto">{l}</p>)}</div></motion.div>}</AnimatePresence>
          </motion.article>
          {!shown ? (
            <Button variant="primary" className="fc-show" data-testid="fc-show" onClick={() => setShown(true)}>{t('Show answer')}<kbd className="ds-kbd">{commandHint('Show the answer')}</kbd></Button>
          ) : (
            <div className="fc-grades" role="group" aria-label={t('How well did you know it?')}>
              {GRADES.map(({ grade, name, tone }) => (
                <button key={grade} type="button" className="fc-grade" data-tone={tone} data-testid={`fc-grade-${grade}`} disabled={rating} onClick={() => void rate(grade)}>
                  <span className="fc-grade-name"><i aria-hidden="true" />{t(name)}</span><small>{localizedInterval(rec, grade, Date.now())}</small><kbd className="ds-kbd">{commandHint(['Again', 'Hard', 'Good', 'Easy'][grade]!)}</kbd>
                </button>
              ))}
            </div>
          )}
          <p className="fc-keys">{t('End the session')} <kbd className="ds-kbd">{commandHint('End the session')}</kbd></p>
        </div>
      )}
    </div>
  )
}
