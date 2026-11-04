import { commandHint, commandMatches } from './shortcutCommands'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { kvGet, kvSet } from './db'
import { repo } from './store'
import { docToHtml, hydrate } from './render'
import { FRESH, extractCards, isDue, label, schedule, type Grade, type RawCard, type Rec } from './srs'
import { bump, countOn, dayKey, lastDays, streak, total, type ReviewLog } from './reviewlog'
import { deviceId, loadLog } from './reviewlogStore'
import { t, locale } from './i18n'
import { PageIcon } from './PageIcon'
import { Button, Icon, Screen, Stats, dirOf, useUIMotion } from './design-system'

type Store = Record<string, Rec>
type Card = RawCard & { title: string }
const NEW_PER_SESSION = 20
const ALL = '__all__'

/** The four answers, with the colour that names them beside the word (never colour alone). */
const GRADES: { grade: Grade; name: string; tone: string }[] = [
  { grade: 0, name: 'Again', tone: 'bad' },
  { grade: 1, name: 'Hard', tone: 'warn' },
  { grade: 2, name: 'Good', tone: 'accent' },
  { grade: 3, name: 'Easy', tone: 'ok' },
]

/**
 * Flashcards: every toggle in your pages is a card (title = question, body = answer), scheduled with spaced repetition.
 * First the decks (one per page that has cards), then the review of one deck, or of everything that is due.
 * Keys while reviewing: Space/Enter show the answer, 1–4 = again / hard / good / easy, Esc goes back.
 */
export function Flashcards({ pageId, onOpenPage, onClose }: { pageId?: string; onOpenPage: (id: string) => void; onClose: () => void }) {
  const motionOf = useUIMotion()
  const [deck, setDeck] = useState<string | null>(pageId ?? null) // null = the list of decks
  const [srs, setSrs] = useState<Store | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [pos, setPos] = useState(0)
  const [shown, setShown] = useState(false)
  const [done, setDone] = useState(0)
  const answerRef = useRef<HTMLDivElement>(null)
  const [log, setLog] = useState<ReviewLog>({})
  const [day, setDay] = useState<number | null>(null)
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

  // one deck per page that has cards; the whole vault is the "Review all" action
  const stat = useCallback(
    (keys: string[]) => {
      const due = srs ? keys.filter((k) => srs[k] && isDue(srs[k])).length : 0
      const fresh = srs ? keys.filter((k) => !srs[k]).length : 0
      return { total: keys.length, due: due + Math.min(fresh, NEW_PER_SESSION), learned: keys.length - fresh }
    },
    [srs],
  )
  const decks = useMemo(() => {
    const byPage = new Map<string, string[]>()
    for (const [k, c] of allCards) byPage.set(c.pageId, [...(byPage.get(c.pageId) ?? []), k])
    return [...byPage].map(([id, keys]) => ({ id, title: repo.get(id)?.title || t('Untitled'), ...stat(keys) })).sort((a, b) => b.due - a.due)
  }, [allCards, stat])
  const vault = useMemo(() => stat([...allCards.keys()]), [allCards, stat])

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
      if (commandMatches(e, 'End the session')) {
        e.preventDefault()
        return deck === null ? onClose() : setDeck(null)
      }
      // on the overview, Enter starts today's session unless a control has focus
      if (deck === null && commandMatches(e, 'Start review') && e.target === document.body && vault.due > 0) return setDeck(ALL)
      if (deck === null || !card || e.target instanceof HTMLInputElement) return
      if (!shown && commandMatches(e, 'Show the answer')) (e.preventDefault(), setShown(true))
      else if (shown) {
        const grade = ['Again', 'Hard', 'Good', 'Easy'].findIndex(label => commandMatches(e, label))
        if (grade >= 0) (e.preventDefault(), rate(grade as Grade))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, shown, rate, onClose, deck, vault.due])

  const num = (n: number) => n.toLocaleString(locale())
  const date = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(d + 'T12:00:00').toLocaleDateString(locale(), opts)

  /* ───── the decks ───── */
  if (deck === null) {
    const endOfTomorrow = new Date(new Date().setHours(23, 59, 59, 999)).getTime() + 24 * 3600 * 1000
    const dueTomorrow = srs ? [...allCards.keys()].filter((k) => srs[k] && srs[k].due > Date.now() && srs[k].due <= endOfTomorrow).length : 0
    const chart = lastDays(log, 14, Date.now())
    const chartMax = Math.max(1, ...chart.map((d) => d.count))
    const chartSum = chart.reduce((a, d) => a + d.count, 0)
    const picked = day === null ? null : chart[day]
    // the card the session would start with: the most overdue one, else the first new one
    const nextKey = srs
      ? ([...allCards.keys()].filter((k) => srs[k] && isDue(srs[k])).sort((a, b) => srs[a].due - srs[b].due)[0] ?? [...allCards.keys()].find((k) => !srs[k]))
      : undefined
    const next = nextKey ? allCards.get(nextKey) : undefined
    const minutes = Math.max(1, Math.round((vault.due * 8) / 60)) // about eight seconds a card
    const upcoming = srs ? Math.min(...[...allCards.keys()].map((k) => srs[k]?.due ?? Infinity).filter((d) => d > Date.now()), Infinity) : Infinity
    return (
      <Screen title={t('Flashcards')} description={t('Every toggle block is a card: its title asks, its content answers')}>
        {!srs ? null : allCards.size === 0 ? (
          <div className="ds-empty ds-empty--framed">
            <Icon name="toggle" />
            <b>{t('No cards yet')}</b>
            <span>{t('Add a toggle to any page with /toggle. Write the question as its title and the answer inside.')}</span>
          </div>
        ) : (
          <>
            {/* today's session: the deck waiting on the table, its top card already showing */}
            <section className="fc-today" aria-labelledby="fc-today">
              <div className="fc-stack" data-empty={!vault.due || undefined} aria-hidden="true">
                <span className="fc-stack-card" />
                <span className="fc-stack-card" />
                <span className="fc-stack-card fc-stack-top">
                  {vault.due > 0 && next ? (
                    <>
                      <small dir="auto">{next.title || t('Untitled')}</small>
                      <b dir="auto">{next.question}</b>
                    </>
                  ) : (
                    <Icon name="check-circle" size={28} />
                  )}
                </span>
              </div>
              <div className="fc-today-text">
                <h2 id="fc-today">
                  {vault.due === 0 ? t('You are up to date') : vault.due === 1 ? t('1 card is waiting') : t('{n} cards are waiting', { n: num(vault.due) })}
                </h2>
                <p>
                  {vault.due > 0
                    ? t('About {m} min. Cards you miss come back before the session ends.', { m: num(minutes) })
                    : Number.isFinite(upcoming)
                      ? t('Next card is due {when}.', { when: new Date(upcoming).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) })
                      : t('Nothing is scheduled yet')}
                </p>
                {vault.due > 0 && (
                  <Button variant="primary" className="fc-start" onClick={() => setDeck(ALL)}>
                    {t('Start review')}
                    <kbd className="ds-kbd">{commandHint('Start review')}</kbd>
                  </Button>
                )}
                <Stats
                  className="fc-facts"
                  label={t('Statistics')}
                  items={[
                    { label: t('reviewed today'), value: num(countOn(log, dayKey(Date.now()))) },
                    { label: t('day streak'), value: num(streak(log, Date.now())) },
                    { label: t('due tomorrow'), value: num(dueTomorrow) },
                    { label: t('reviews in total'), value: num(total(log)) },
                  ]}
                />
              </div>
            </section>

            <section className="fc-section" aria-labelledby="fc-decks">
              <h2 id="fc-decks">{t('Decks')}</h2>
              <div className="ds-list ds-list--framed">
                {decks.map((d) => {
                  const page = repo.get(d.id)
                  const pct = d.total ? Math.round((d.learned / d.total) * 100) : 0
                  return (
                    <div key={d.id} className="ds-list-row fc-deck" dir={dirOf(d.title)}>
                      <span className="fc-deck-ic">{page ? <PageIcon page={page} /> : <Icon name="cards" />}</span>
                      <span className="ds-list-main">
                        <b dir="auto">{d.title}</b>
                        <small>{t(d.total === 1 ? '1 card, {m} learned' : '{n} cards, {m} learned', { n: num(d.total), m: num(d.learned) })}</small>
                      </span>
                      <span className="ds-progress fc-meter" role="progressbar" aria-label={t('Learned')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                        <i style={{ inlineSize: pct + '%' }} />
                      </span>
                      <span className="fc-due" data-zero={!d.due || undefined}>
                        {d.due ? t('{n} due', { n: num(d.due) }) : t('Up to date')}
                      </span>
                      <Button size="sm" variant={d.due ? 'default' : 'ghost'} onClick={() => setDeck(d.id)}>
                        {t('Review')}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="fc-section" aria-labelledby="fc-days">
              <div className="fc-chart-head">
                <h2 id="fc-days">{t('Last 14 days')}</h2>
                <span aria-live="polite">
                  {picked
                    ? t('{n} reviews on {day}', { n: num(picked.count), day: date(picked.day, { weekday: 'long', month: 'short', day: 'numeric' }) })
                    : t('{n} reviews in these 14 days', { n: num(chartSum) })}
                </span>
              </div>
              <div className="fc-days" role="list" aria-label={t('Reviews per day')} onMouseLeave={() => setDay(null)}>
                {chart.map((d, i) => (
                  <span
                    key={d.day}
                    role="listitem"
                    tabIndex={0}
                    className="fc-day"
                    data-on={day === i || undefined}
                    data-today={i === chart.length - 1 || undefined}
                    style={{ '--level': d.count ? 0.25 + 0.75 * (d.count / chartMax) : 0 } as CSSProperties}
                    aria-label={t('{n} reviews on {day}', { n: num(d.count), day: date(d.day, { weekday: 'long', month: 'short', day: 'numeric' }) })}
                    onMouseEnter={() => setDay(i)}
                    onFocus={() => setDay(i)}
                    onBlur={() => setDay(null)}
                  />
                ))}
              </div>
              <div className="fc-days-axis" aria-hidden="true">
                {chart.map((d) => (
                  <span key={d.day}>{date(d.day, { weekday: 'narrow' })}</span>
                ))}
              </div>
            </section>
          </>
        )}
      </Screen>
    )
  }

  /* ───── reviewing one deck ───── */
  const left = Math.max(0, queue.length - pos)
  const sessionTotal = done + left
  const pct = sessionTotal ? Math.round((done / sessionTotal) * 100) : 0
  const rec = key && srs ? srs[key] : undefined
  const nextDue = srs ? Math.min(...[...cards.keys()].map((k) => srs[k]?.due ?? Infinity).filter((d) => d > Date.now()), Infinity) : Infinity
  const deckTitle = deck === ALL ? t('All decks') : repo.get(deck)?.title || t('Untitled')
  const rtl = document.documentElement.dir === 'rtl'

  return (
    <div className="fc-review">
      <div className="fc-top">
        <Button variant="ghost" size="sm" icon={<Icon name="arrow-left" size={16} className="ds-flip" />} onClick={() => setDeck(null)}>
          {t('Decks')}
        </Button>
        <b className="fc-top-title" dir="auto">
          {deckTitle}
        </b>
        {card && <span className="fc-top-count">{t('{n} of {m}', { n: num(done + 1), m: num(sessionTotal) })}</span>}
      </div>
      <div className="ds-progress fc-top-progress" role="progressbar" aria-label={t('Session progress')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ inlineSize: pct + '%' }} />
      </div>

      {!srs ? null : !card ? (
        <div className="ds-empty fc-done">
          <Icon name={cards.size === 0 ? 'cards' : 'check-circle'} />
          <b>{cards.size === 0 ? t('No cards yet') : t('All done for now')}</b>
          <span>
            {done ? t(done === 1 ? 'You reviewed 1 card.' : 'You reviewed {n} cards.', { n: num(done) }) + ' ' : ''}
            {Number.isFinite(nextDue) ? t('Next card is due {when}.', { when: new Date(nextDue).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) }) : ''}
          </span>
          <Button variant="primary" onClick={() => setDeck(null)}>
            {t('Back to decks')}
          </Button>
        </div>
      ) : (
        <div className="fc-stage">
          <motion.article
            key={key + ':' + done}
            className="fc-card"
            aria-live="polite"
            initial={motionOf.reduced ? false : { opacity: 0, x: rtl ? -28 : 28 }}
            animate={{ opacity: 1, x: 0 }}
            transition={motionOf.spring}
          >
            <button type="button" className="fc-source" onClick={() => onOpenPage(card.pageId)} dir="auto" title={t('Open the page')}>
              {card.title || t('Untitled')}
              <Icon name="arrow-up-right" size={13} className="ds-flip" />
            </button>
            <h2 className="fc-q" dir="auto" data-long={card.question.length > 90 || undefined}>
              {card.question}
            </h2>
            <AnimatePresence initial={false}>
              {shown && (
                <motion.div
                  key="answer"
                  className="fc-a-wrap"
                  initial={motionOf.reduced ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={motionOf.transition}
                >
                  <div className="fc-a tiptap" ref={answerRef} dangerouslySetInnerHTML={{ __html: html }} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.article>

          {!shown ? (
            <Button variant="primary" className="fc-show" onClick={() => setShown(true)}>
              {t('Show answer')}
              <kbd className="ds-kbd">{commandHint('Show the answer')}</kbd>
            </Button>
          ) : (
            <div className="fc-grades" role="group" aria-label={t('How well did you know it?')}>
              {GRADES.map(({ grade, name, tone }) => (
                <button key={grade} type="button" className="fc-grade" data-tone={tone} onClick={() => rate(grade)}>
                  <span className="fc-grade-name">
                    <i aria-hidden="true" />
                    {t(name)}
                  </span>
                  <small>{label(rec ?? FRESH, grade)}</small>
                  <kbd className="ds-kbd">{commandHint(['Again', 'Hard', 'Good', 'Easy'][grade])}</kbd>
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
