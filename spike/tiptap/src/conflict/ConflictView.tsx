import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Notice, SegmentedChoice, cx } from '../design-system'
import type { DocNode } from '../docNode'
import { applyChoices, choiceFor, diffConflict, type Choice, type Row, type Token } from '../documents/conflictMerge'
import { contentProblem } from '../editor/contentSafety'
import { t } from '../i18n'
import { hydrate } from '../render'
import { ago } from '../ui'
import { deviceLabel } from './labels'
import { blocksHtml, editorSchema } from './renderBlock'
import type { ConflictMarker, ConflictSideName } from './types'
import './conflict.css'

export interface ConflictViewProps {
  marker: ConflictMarker
  /** Called with the merged page content and title once the person confirms. Reject to keep the view open (the message is shown). */
  onApply: (content: unknown, title: string) => Promise<void>
  onCancel: () => void
  /** HTML of top-level blocks; defaults to the editor's own serializer (one shared instance). */
  renderBlocks?: (nodes: DocNode[]) => string
}

type Chosen = Record<string, Choice>
type Segment = { run: Row[]; row?: undefined } | { row: Row; run?: undefined }

const other = (side: ConflictSideName): ConflictSideName => (side === 'local' ? 'remote' : 'local')

/** Rendered blocks; stored images, formulas and diagrams are filled in afterwards, as in the version history. */
function Blocks({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) void hydrate(ref.current)
  }, [html])
  return <div ref={ref} dir="auto" className={cx('tiptap cf-blocks', className)} dangerouslySetInnerHTML={{ __html: html }} />
}

/** One side's text with the words that differ marked (the other side's extra words are left out). */
function Tokens({ tokens, side }: { tokens: Token[]; side: ConflictSideName }) {
  const hidden = side === 'local' ? 'ins' : 'del'
  return (
    <>
      {tokens
        .filter((k) => k.op !== hidden)
        .map((k, i) => (k.op === 'eq' ? <span key={i}>{k.text}</span> : <mark key={i} className="cf-mark">{k.text}</mark>))}
    </>
  )
}

function Card({ row, side, render }: { row: Row; side: ConflictSideName; render: (nodes: DocNode[]) => string }) {
  const nodes = row[side]
  if (row.whole) return <p className="cf-absent">{t('This page uses an older format, so one whole version has to be chosen.')}</p>
  if (row.title) {
    const text = row.title[side]
    return (
      <p className="cf-title-text" dir="auto">
        {row.tokens ? <Tokens tokens={row.tokens} side={side} /> : text || t('Untitled')}
      </p>
    )
  }
  if (nodes.length === 0) return <p className="cf-absent">{t('Not in this version')}</p>
  if (row.tokens && !row.formatOnly && row.local.length === 1 && row.remote.length === 1) {
    const heading = nodes[0].type === 'heading'
    return row.tokenKind === 'code' ? (
      <pre className="cf-code" dir="ltr">
        <Tokens tokens={row.tokens} side={side} />
      </pre>
    ) : (
      <p className={cx('cf-text', heading && 'cf-text--heading')} dir="auto">
        <Tokens tokens={row.tokens} side={side} />
      </p>
    )
  }
  return (
    <>
      <Blocks html={render(nodes)} />
      {row.formatOnly && <p className="cf-hint">{t('The text is the same; only the formatting differs.')}</p>}
    </>
  )
}

/** What happened to the block, in words. */
function statusOf(row: Row, hasBase: boolean, marker: ConflictMarker): string {
  const name = (side: ConflictSideName) => deviceLabel(marker, side)
  switch (row.kind) {
    case 'local-only':
      return t('Changed on {device}', { device: name('local') })
    case 'remote-only':
      return t('Changed on {device}', { device: name('remote') })
    case 'added':
      if (row.local.length && row.remote.length) return hasBase ? t('Added on both devices') : t('Different on each device')
      return hasBase ? t('Added on {device}', { device: name(row.by!) }) : t('Only on {device}', { device: name(row.by!) })
    case 'deleted':
      return t('Deleted on {device}', { device: name(row.by!) })
    case 'delete-vs-edit':
      return t('Edited on {edited}, deleted on {deleted}', { edited: name(other(row.by!)), deleted: name(row.by!) })
    default:
      return t('Changed on both devices')
  }
}

/** Screen-reader name of a row's choice group. */
function groupLabel(row: Row, n: number): string {
  if (row.title) return row.kind === 'both' ? t('Title: changed on both devices') : t('Title: changed on one device')
  switch (row.kind) {
    case 'local-only':
    case 'remote-only':
      return t('Block {n}: changed on one device', { n })
    case 'added':
      return row.local.length && row.remote.length ? t('Block {n}: added on both devices', { n }) : t('Block {n}: added on one device', { n })
    case 'deleted':
      return t('Block {n}: deleted on one device', { n })
    case 'delete-vs-edit':
      return t('Block {n}: edited on one device and deleted on the other', { n })
    default:
      return t('Block {n}: changed on both devices', { n })
  }
}

interface RowViewProps {
  row: Row
  n: number
  hasBase: boolean
  marker: ConflictMarker
  chosen: Choice | undefined
  render: (nodes: DocNode[]) => string
  onChoose: (choice: Choice) => void
  onActive: () => void
  register: (el: HTMLElement | null) => void
}

function RowView({ row, n, hasBase, marker, chosen, render, onChoose, onActive, register }: RowViewProps) {
  const labelId = useId()
  // a row that needs a decision has no selection until the person makes one
  const selected: Choice | null = chosen ?? (row.needsChoice ? null : choiceFor(row, {}))
  const state = chosen ? t('Your choice') : row.needsChoice ? t('Needs your choice') : t('Merged automatically')

  const move = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const group = e.currentTarget
    const rtl = getComputedStyle(group).direction === 'rtl'
    const step = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight') ? 1 : e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? -1 : 0
    if (!step) return
    e.preventDefault()
    const from = selected ? row.options.indexOf(selected) : step > 0 ? -1 : row.options.length
    const next = row.options[(from + step + row.options.length) % row.options.length]
    onChoose(next)
    queueMicrotask(() => group.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus())
  }

  const option = (choice: Choice, i: number) => {
    const picked = selected === choice
    const tab = picked || (selected === null && i === 0)
    const side = choice === 'both' ? null : choice
    return (
      <div
        key={choice}
        role="radio"
        aria-checked={picked}
        aria-labelledby={`${labelId}-${choice}`}
        tabIndex={tab ? 0 : -1}
        data-choice={choice}
        className={cx('cf-card', picked && 'is-picked', choice === 'both' && 'cf-card--both')}
        onClick={() => onChoose(choice)}
        onKeyDown={(e) => {
          if (e.key === ' ' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) (e.preventDefault(), onChoose(choice))
        }}
      >
        <div className="cf-card-head">
          <span className="cf-mark-radio" aria-hidden="true" />
          <span id={`${labelId}-${choice}`} className="cf-card-name">
            {side ? deviceLabel(marker, side) : t('Keep both')}
          </span>
          <span className="cf-card-time">{side ? ago(marker[side].savedAt) : t('One after the other')}</span>
        </div>
        {side && (
          <div className="cf-card-body">
            <Card row={row} side={side} render={render} />
          </div>
        )}
      </div>
    )
  }

  return (
    <section ref={register} className="cf-row" data-row={row.id} data-kind={row.kind} onFocus={onActive}>
      <div className="cf-row-head">
        <span className="cf-row-status">{statusOf(row, hasBase, marker)}</span>
        <span className={cx('cf-row-state', row.needsChoice && !chosen && 'is-open')}>{state}</span>
        {row.moved && <span className="cf-row-state">{t('Moved')}</span>}
      </div>
      <div role="radiogroup" aria-label={groupLabel(row, n)} className="cf-cards" onKeyDown={move}>
        {row.options.map(option)}
      </div>
    </section>
  )
}

/** Resolves a page edited on two devices in the page itself: both versions side by side, a choice per changed block, then the merged result. */
export function ConflictView({ marker, onApply, onCancel, renderBlocks }: ConflictViewProps) {
  const render = renderBlocks ?? blocksHtml
  const diff = useMemo(() => diffConflict(marker), [marker])
  const [chosen, setChosen] = useState<Chosen>({})
  const [tab, setTab] = useState<'changes' | 'result'>('changes')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const active = useRef<string | null>(null)
  const rowEls = useRef(new Map<string, HTMLElement>())
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => void (alive.current = false)
  }, [])

  const rows = useMemo(() => [diff.title, ...diff.rows], [diff])
  const differing = rows.filter((r) => r.options.length > 0)
  const review = differing.filter((r) => r.needsChoice)
  const unresolved = review.filter((r) => !chosen[r.id])
  const merged = useMemo(() => applyChoices(marker, chosen, diff), [marker, chosen, diff])
  const mergedBlocks = (merged.content as DocNode | null)?.content
  const resultHtml = useMemo(() => (tab === 'result' && Array.isArray(mergedBlocks) ? render(mergedBlocks) : ''), [tab, mergedBlocks, render])

  const segments = useMemo(() => {
    const out: Segment[] = []
    for (const row of diff.rows) {
      const last = out[out.length - 1]
      if (row.kind !== 'unchanged') out.push({ row })
      else if (last?.run) last.run.push(row)
      else out.push({ run: [row] })
    }
    return out
  }, [diff])

  const progress = differing.length === 0 ? t('The two versions are identical.') : review.length === 0 ? t('Everything was merged automatically.') : unresolved.length === 0 ? t('All changes reviewed. Ready to apply.') : t('{n} of {total} to review', { n: unresolved.length, total: review.length })

  const choose = (id: string, choice: Choice) => setChosen((c) => ({ ...c, [id]: choice }))
  const pickAll = (side: ConflictSideName) => setChosen(Object.fromEntries(differing.map((r) => [r.id, side])))

  /** Moves focus to the next or previous row in `list` (wrapping), starting from the row that last had focus. */
  const go = (list: Row[], delta: 1 | -1) => {
    if (list.length === 0) return
    const order = new Map(rows.map((r, i) => [r.id, i]))
    const at = active.current !== null ? (order.get(active.current) ?? -1) : -1
    const target = delta > 0 ? (list.find((r) => order.get(r.id)! > at) ?? list[0]) : (list.findLast((r) => order.get(r.id)! < at) ?? list[list.length - 1])
    setTab('changes')
    requestAnimationFrame(() => {
      const el = rowEls.current.get(target.id)
      el?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus()
      el?.scrollIntoView({ block: 'center' })
    })
  }

  // on arrival, land on the first block that needs a decision
  useEffect(() => go(review, 1), []) // oxlint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    if (busy) return
    if (unresolved.length) return go(unresolved, 1)
    const issue = contentProblem(merged.content, editorSchema())
    if (issue) return setError(t(issue))
    setBusy(true)
    setError(null)
    try {
      await onApply(merged.content, merged.title)
    } catch {
      if (alive.current) setError(t('Could not apply the merged page. Nothing was changed.'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const cancel = () => {
    if (busy) return
    if (Object.keys(chosen).length === 0) return onCancel()
    setAsking(true)
  }

  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') (e.preventDefault(), asking ? setAsking(false) : cancel())
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), void apply())
    else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) (e.preventDefault(), go(unresolved, e.key === 'ArrowDown' ? 1 : -1))
  }

  const blockNumber = new Map(diff.rows.map((r, i) => [r.id, i + 1]))
  const view = (row: Row) => (
    <RowView
      key={row.id}
      row={row}
      n={blockNumber.get(row.id) ?? 0}
      hasBase={diff.hasBase}
      marker={marker}
      chosen={chosen[row.id]}
      render={render}
      onChoose={(c) => choose(row.id, c)}
      onActive={() => (active.current = row.id)}
      register={(el) => void (el ? rowEls.current.set(row.id, el) : rowEls.current.delete(row.id))}
    />
  )

  const name = (side: ConflictSideName) => deviceLabel(marker, side)
  let footer: ReactNode
  if (asking)
    footer = (
      <>
        <span className="cf-footer-note" role="alert">{t('Discard your choices and keep the page as it is?')}</span>
        <Button onClick={() => setAsking(false)}>{t('Keep reviewing')}</Button>
        <Button variant="danger" onClick={onCancel}>{t('Discard choices')}</Button>
      </>
    )
  else
    footer = (
      <>
        <span className="cf-footer-note">{unresolved.length > 0 && t('Choose for the remaining {n} to apply the merged page.', { n: unresolved.length })}</span>
        <Button onClick={cancel} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || unresolved.length > 0}>
          {busy ? t('Applying…') : t('Apply merged page')}
        </Button>
      </>
    )

  return (
    <div className="cf" onKeyDown={keys}>
      <header className="cf-bar">
        <div className="cf-bar-main">
          <h2 className="cf-heading">{t('Edited on two devices')}</h2>
          <p className="cf-progress">{progress}</p>
        </div>
        <div className="cf-bar-tools">
          <Button size="sm" onClick={() => go(review, -1)} disabled={review.length === 0}>{t('Previous')}</Button>
          <Button size="sm" onClick={() => go(review, 1)} disabled={review.length === 0}>{t('Next')}</Button>
          <Button size="sm" onClick={() => pickAll('local')}>{t('Use all from {device}', { device: name('local') })}</Button>
          <Button size="sm" onClick={() => pickAll('remote')}>{t('Use all from {device}', { device: name('remote') })}</Button>
          <SegmentedChoice
            label={t('View')}
            value={tab}
            items={[
              { value: 'changes', label: t('Changes') },
              { value: 'result', label: t('Result') },
            ]}
            onChange={setTab}
          />
        </div>
      </header>
      <div className="cf-live" role="status" aria-live="polite">{progress}</div>

      <div className="cf-body">
        {tab === 'changes' ? (
          <>
            {diff.title.options.length > 0 && view(diff.title)}
            {segments.map((s) => {
              if (s.row) return view(s.row)
              const key = s.run[0].id
              const shown = open.has(key)
              return (
                <div key={key} className="cf-run">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={shown}
                    onClick={() => setOpen((o) => (o.has(key) ? new Set([...o].filter((k) => k !== key)) : new Set(o).add(key)))}
                  >
                    {s.run.length === 1 ? t('One unchanged block') : t('{n} unchanged blocks', { n: s.run.length })}
                  </Button>
                  {shown && <Blocks className="cf-run-blocks" html={render(s.run.flatMap((r) => r.local))} />}
                </div>
              )
            })}
          </>
        ) : (
          <article className="cf-result" aria-label={t('Merged page')}>
            <h1 className="cf-result-title" dir="auto">{merged.title || t('Untitled')}</h1>
            <Blocks html={resultHtml} />
          </article>
        )}
      </div>

      <footer className="cf-footer">
        {error && <Notice tone="bad" compact className="cf-error">{error}</Notice>}
        <div className="cf-footer-row">{footer}</div>
      </footer>
    </div>
  )
}
