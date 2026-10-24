import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { kvGet, kvSet } from './db'
import { repo } from './store'
import { docToHtml, hydrate } from './render'
import { FRESH, extractCards, isDue, label, schedule, type Grade, type RawCard, type Rec } from './srs'
import { t } from './i18n'
import { Select } from './ui'

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
      if (g === 0) setQueue((q) => [...q, key]) // "again" comes back before the session ends
      setPos((p) => p + 1)
      setShown(false)
      setDone((d) => d + 1)
    },
    [key, srs],
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

  const grades: [Grade, string][] = [[0, t('Again')], [1, t('Hard')], [2, t('Good')], [3, t('Easy')]]

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal fc-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <b>{t('Flashcards')}</b>
            <small>{t('{n} to review · {m} new', { n: dueCount, m: newCount })}</small>
          </div>
          <div className="fc-tools">
            {pageId && (
              <Select value={scope} onChange={(v) => setScope(v as 'all' | 'page')} options={[{ value: 'page', label: t('This page only') }, { value: 'all', label: t('All pages') }]} />
            )}
            <button className="icon-btn" onClick={onClose} title={t('Close')}>✕</button>
          </div>
        </div>

        <div className="fc-body">
          {!srs ? null : cards.size === 0 ? (
            <div className="fc-empty">
              <p>{t('No cards yet.')}</p>
              <small>{t('Every Toggle block with a title and content becomes a card: the title is the question, the content is the answer. Add one with /toggle.')}</small>
            </div>
          ) : !card ? (
            <div className="fc-empty">
              <p>🎉 {t('All done for now!')}</p>
              <small>
                {done ? t('You reviewed {n} cards.', { n: done }) + ' ' : ''}
                {Number.isFinite(nextDue) ? t('Next card is due {when}.', { when: new Date(nextDue).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }) : ''}
              </small>
            </div>
          ) : (
            <>
              <div className="fc-meta">
                <span>{t('{n} left', { n: left })}</span>
                <button className="link" onClick={() => onOpenPage(card.pageId)} dir="auto">{card.title || t('Untitled')} ↗</button>
              </div>
              <div className="fc-card">
                <div className="fc-q" dir="auto">{card.question}</div>
                {shown ? <div className="fc-a tiptap" ref={answerRef} dangerouslySetInnerHTML={{ __html: html }} /> : null}
              </div>
              {!shown ? (
                <button className="primary fc-show" onClick={() => setShown(true)}>{t('Show answer')} <kbd>Space</kbd></button>
              ) : (
                <div className="fc-grades">
                  {grades.map(([g, name]) => (
                    <button key={g} className={'fc-g g' + g} onClick={() => rate(g)}>
                      <b>{name}</b>
                      <small>{label(rec ?? FRESH, g)} · {g + 1}</small>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
