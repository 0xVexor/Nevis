import { SLIDES_ENABLED } from './releaseFeatures'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type CSSProperties, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { getTemplates } from './templates'
import { Glyph } from './iconSet'
import { Button, Icon, Screen, useUIMotion } from './design-system'
import { t } from './i18n'
import { deckStyle } from './decks/model'
import { renderSlide } from './decks/slideRendering'
import { deckFromTemplate, deckTemplates } from './decks/templates'

/** Glyph shown for each built-in template (new pages get it as their icon). */
export const TEMPLATE_GLYPH: Record<string, string> = { lecture: 'graduation', chapter: 'book', exercise: 'target', meeting: 'users', todo: 'list' }

/** Ids of the two gallery entries that are not page templates: a whole-page drawing board and a database. */
export const BOARD_TEMPLATE = '__board'
export const DATABASE_TEMPLATE = '__database'

/** What a template writes, block by block, read from its HTML so the preview always matches the page it creates. */
type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'text' }
  | { kind: 'list'; items: string[] }
  | { kind: 'tasks'; items: { text: string; done: boolean }[] }
  | { kind: 'toggle'; text: string }
  | { kind: 'callout'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; rows: number }
  | { kind: 'math'; text: string }

const textOf = (el: Element | null | undefined) => (el?.textContent ?? '').trim()

function outline(html: string): Block[] {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
  return Array.from(body.children).map((el): Block => {
    const type = el.getAttribute('data-type')
    if (/^H[1-6]$/.test(el.tagName)) return { kind: 'heading', text: textOf(el) }
    if (type === 'taskList') return { kind: 'tasks', items: Array.from(el.children).map((li) => ({ text: textOf(li), done: li.getAttribute('data-checked') === 'true' })) }
    if (el.tagName === 'UL' || el.tagName === 'OL') return { kind: 'list', items: Array.from(el.children).map(textOf) }
    if (type === 'toggle') return { kind: 'toggle', text: textOf(el.firstElementChild) }
    if (type === 'callout') return { kind: 'callout', text: textOf(el) }
    if (type === 'math-block') return { kind: 'math', text: el.getAttribute('data-latex') ?? '' }
    if (el.tagName === 'PRE') return { kind: 'code', text: textOf(el) }
    if (el.tagName === 'TABLE') {
      const rows = Array.from(el.querySelectorAll('tr'))
      return { kind: 'table', head: Array.from(rows[0]?.children ?? []).map(textOf), rows: Math.max(0, rows.length - 1) }
    }
    return { kind: 'text' }
  })
}

interface Choice {
  id: string
  title: string
  hint: string
  icon: ReactNode
  /** the action the preview's button names */
  action: string
  /** the new page's suggested title */
  pageTitle?: string
  blocks?: Block[]
  deck?: (typeof deckTemplates)[number]
}

/** An empty line where the person will write. */
const Line = ({ width = 60 }: { width?: number }) => <span className="tpl-line" style={{ inlineSize: width + '%' }} />

function Paper({ choice }: { choice: Choice }) {
  if (choice.deck) {
    let number = 0
    const deck = deckFromTemplate(choice.deck, t, () => String(++number))
    return (
      <div className="tpl-deck-preview">
        {deck.slides.map((slide, index) => (
          <div className="tpl-deck-sheet" key={slide.id} style={{ aspectRatio: `${deck.size.width} / ${deck.size.height}`, ...deckStyle(deck, slide) } as CSSProperties}>
            <div className="deck-slide-content tiptap" dir="auto" dangerouslySetInnerHTML={{ __html: renderSlide(slide.content) }} />
            <small>{index + 1} / {deck.slides.length}</small>
          </div>
        ))}
      </div>
    )
  }
  if (choice.id === DATABASE_TEMPLATE) {
    const cols = [t('Name'), t('Status'), t('Date')]
    return (
      <div className="tpl-db" role="img" aria-label={t('A table with columns for name, status and date')}>
        {cols.map((c) => (
          <b key={c}>{c}</b>
        ))}
        {[72, 48, 64].map((w) => [
          <span key={w + 'a'}>
            <Line width={w} />
          </span>,
          <span key={w + 'b'}>
            <span className="tpl-pill" />
          </span>,
          <span key={w + 'c'}>
            <Line width={50} />
          </span>,
        ])}
      </div>
    )
  }
  if (choice.id === BOARD_TEMPLATE)
    return (
      <svg className="tpl-board" viewBox="0 0 320 180" role="img" aria-label={t('A blank whiteboard')}>
        <rect x="36" y="40" width="92" height="56" rx="10" />
        <circle cx="250" cy="118" r="34" />
        <path d="M128 68h44a24 24 0 0 1 24 24v6" />
        <path d="m188 92 8 8 8-8" />
        <path d="M70 136c22-14 44 14 66 0" />
      </svg>
    )
  return (
    <>
      <span className="tpl-paper-icon">{choice.icon}</span>
      <p className="tpl-paper-title" dir="auto" data-empty={!choice.pageTitle?.trim() || undefined}>
        {choice.pageTitle?.trim() || t('Untitled')}
      </p>
      {!choice.blocks?.length ? <p className="tpl-paper-hint">{t('Start writing, or press / for blocks')}</p> : choice.blocks.map((b, i) => <PaperBlock key={i} block={b} />)}
    </>
  )
}

function PaperBlock({ block: b }: { block: Block }) {
  switch (b.kind) {
    case 'heading':
      return (
        <h3 className="tpl-h" dir="auto">
          {b.text}
        </h3>
      )
    case 'text':
      return <Line width={70} />
    case 'list':
      return (
        <ul className="tpl-list">
          {b.items.map((x, i) => (
            <li key={i} dir="auto">
              {x || <Line width={50} />}
            </li>
          ))}
        </ul>
      )
    case 'tasks':
      return (
        <div className="tpl-tasks">
          {b.items.map((x, i) => (
            <span key={i} className="tpl-task" dir="auto">
              <span className="ds-check" aria-hidden="true" />
              {x.text || <Line width={45} />}
            </span>
          ))}
        </div>
      )
    case 'toggle':
      return (
        <span className="tpl-toggle" dir="auto">
          <Icon name="chevron-right" size={14} className="ds-flip" />
          {b.text}
        </span>
      )
    case 'callout':
      return (
        <span className="tpl-callout" dir="auto">
          <Icon name="callout" size={15} />
          {b.text || <Line width={40} />}
        </span>
      )
    case 'code':
      return (
        <pre className="tpl-code" dir="ltr">
          {b.text}
        </pre>
      )
    case 'math':
      return (
        <code className="tpl-code" dir="ltr">
          {b.text}
        </code>
      )
    case 'table':
      return (
        <div className="tpl-table" style={{ gridTemplateColumns: `repeat(${b.head.length || 2}, 1fr)` }}>
          {b.head.map((h, i) => (
            <b key={i} dir="auto">
              {h}
            </b>
          ))}
          {Array.from({ length: b.rows * b.head.length }, (_, i) => (
            <span key={i} />
          ))}
        </div>
      )
  }
}

/**
 * Templates as a page: the choices on one side, a preview of the page the chosen one creates on the other.
 * Arrow keys move through the list, Enter (or a double click) creates, Escape leaves.
 */
export function Templates({ onPick, onClose, startWithDecks = false }: { onPick: (id: string) => void; onClose: () => void; startWithDecks?: boolean }) {
  const motionOf = useUIMotion()
  const { empty, templates } = useMemo(() => {
    const empty: Choice[] = [
      { id: '', title: t('Blank page'), hint: t('Start from scratch'), icon: <Icon name="file-text" />, action: t('Create page') },
      { id: DATABASE_TEMPLATE, title: t('Database'), hint: t('Tables, views, forms and dashboards in one database.'), icon: <Icon name="database" />, action: t('Create database') },
      { id: BOARD_TEMPLATE, title: t('Drawing'), hint: t('A blank whiteboard for sketches and diagrams.'), icon: <Icon name="pencil" />, action: t('Create drawing') },
    ]
    const templates: Choice[] = getTemplates().map((tp) => ({
      id: tp.id,
      title: tp.title,
      hint: tp.desc,
      icon: <Glyph name={TEMPLATE_GLYPH[tp.id] ?? 'page'} size={18} />,
      action: t('Use template'),
      pageTitle: tp.pageTitle.replace(/[\s—–-]+$/, ''),
      blocks: outline(tp.html),
    }))
    return { empty, templates }
  }, [])
  const decks: Choice[] = (SLIDES_ENABLED ? deckTemplates : []).map((deck) => ({ id: deck.id, title: t(deck.title), hint: t(deck.hint), icon: <Icon name="layers" />, action: t('Create deck'), deck }))
  const all = [...empty, ...decks, ...templates]
  const [current, setCurrent] = useState(startWithDecks && decks.length ? decks[0].id : all[0].id)
  const chosen = all.find((c) => c.id === current) ?? all[0]
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const move = (e: ReactKeyboardEvent) => {
    const i = all.findIndex((c) => c.id === current)
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -2
    if (next === -2) return
    e.preventDefault()
    const id = all[Math.max(0, Math.min(all.length - 1, next))].id
    setCurrent(id)
    list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus()
  }

  const option = (c: Choice) => (
    <button
      key={c.id}
      type="button"
      role="option"
      data-id={c.id}
      aria-selected={c.id === current}
      tabIndex={c.id === current ? 0 : -1}
      className="tpl-option"
      onClick={() => setCurrent(c.id)}
      onDoubleClick={() => onPick(c.id)}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onPick(c.id))}
    >
      <span className="tpl-option-ic">{c.icon}</span>
      <span className="tpl-option-text">
        <b dir="auto">{c.title}</b>
        <small dir="auto">{c.hint}</small>
      </span>
    </button>
  )

  return (
    <Screen width="wide" fill title={t('Templates')} description={t('Pick a starting point. The preview shows what the new page will contain.')}>
      <div className="tpl">
        <div ref={list} className="tpl-choices" role="listbox" aria-label={t('Templates')} onKeyDown={move}>
          <div role="group" aria-labelledby="tpl-empty">
            <h2 id="tpl-empty" className="tpl-group">
              {t('Start empty')}
            </h2>
            {empty.map(option)}
          </div>
          {SLIDES_ENABLED && (<div role="group" aria-labelledby="tpl-decks">
            <h2 id="tpl-decks" className="tpl-group">
              {t('Deck templates')}
            </h2>
            {decks.map(option)}
          </div>)}
          <div role="group" aria-labelledby="tpl-ready">
            <h2 id="tpl-ready" className="tpl-group">
              {t('Ready-made pages')}
            </h2>
            {templates.map(option)}
          </div>
        </div>

        <section className="tpl-preview" aria-label={t('Preview')} aria-live="polite">
          <header className="tpl-preview-head">
            <div>
              <h2 dir="auto">{chosen.title}</h2>
              <p dir="auto">{chosen.hint}</p>
            </div>
            <Button variant="primary" onClick={() => onPick(chosen.id)}>
              {chosen.action}
            </Button>
          </header>
          <div className="tpl-stage">
            <motion.div key={chosen.id} className="tpl-paper" initial={motionOf.reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={motionOf.transition}>
              <Paper choice={chosen} />
            </motion.div>
          </div>
        </section>
      </div>
    </Screen>
  )
}
