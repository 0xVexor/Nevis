import { useEffect, useRef, useState } from 'react'
import { Button, Icon, SaveStatus } from '../design-system'
import { BrandMark } from '../BrandMark'
import { HomeNote, type HomeNoteDraft } from '../HomeNote'
import { LandingFrame } from './Onboarding'
import { useSettings } from '../settings'
import type { DocNode } from '../docNode'
import { locale, t } from '../i18n'

const p = (): DocNode => ({ type: 'paragraph' })
const h = (text: string): DocNode => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] })
const task = (): DocNode => ({ type: 'taskItem', attrs: { checked: false }, content: [p()] })

// Three small ways in. Each fills the title and leaves a little structure, never sample text.
const IDEAS: { id: string; icon: string; label: string; content: () => DocNode[] }[] = [
  { id: 'mind', icon: 'sparkles', label: 'Today’s thoughts', content: () => [p()] },
  { id: 'week', icon: 'checklist', label: 'This week’s plan', content: () => [{ type: 'taskList', content: [task(), task(), task()] }] },
  { id: 'class', icon: 'file-book', label: 'Class notes', content: () => [h(t('Key ideas')), p(), h(t('Questions')), p()] },
]

type Status = 'idle' | 'saving' | 'saved' | 'error'
const STATUS_LABEL: Record<Status, string> = { idle: 'Saved automatically as you write', saving: 'Saving…', saved: 'Saved', error: 'Could not save. Your note is still here.' }
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

/**
 * The first page of a new workspace: one sheet like a real page, a few ways in, one tip at a time.
 * `arrive` starts on the start flow's last frame (it was left on screen before the reload).
 * On leaving, `onReveal` puts the workspace behind the sheet; the sheet then flies into `target()`, the page's row in the sidebar.
 */
export function FirstNote({ workspace, arrive, onChange, onPersist, onDirty, onReveal, target, onFinish }: {
  workspace: string
  arrive?: boolean
  onChange: (draft: HomeNoteDraft) => string
  onPersist: () => Promise<void>
  onDirty?: (id: string, dirty: boolean) => void
  onReveal?: (pageId: string | null) => void
  target?: () => Element | null
  onFinish: (pageId: string | null) => void
}) {
  const reduceSetting = useSettings().reduceMotion
  const reduce = () => reduceSetting || matchMedia('(prefers-reduced-motion: reduce)').matches
  const [arrival, setArrival] = useState<'still' | 'leaving' | 'done'>(arrive ? 'still' : 'done')
  const [phase, setPhase] = useState<'writing' | 'leaving'>('writing')
  const [starter, setStarter] = useState<{ key: string; title: string; content: DocNode }>()
  const [pageId, setPageId] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [wrote, setWrote] = useState(false)
  const [usedSlash, setUsedSlash] = useState(false)
  const [savedTip, setSavedTip] = useState(false)
  const savedOnce = useRef(false)
  const sheet = useRef<HTMLElement>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const later = (ms: number, f: () => void) => timers.current.push(setTimeout(f, ms))
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // the frame holds for a moment, then fades over the sheet as it arrives
  useEffect(() => {
    if (arrival !== 'still') return
    const fast = reduce()
    later(fast ? 0 : 380, () => setArrival('leaving'))
    later(fast ? 120 : 640, () => setArrival('done'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const started = !!pageId
  const tip = savedTip ? 'saved' : wrote && !usedSlash ? 'slash' : started && usedSlash ? 'ready' : null
  const slashTip = t('Press {key} to add a heading, a checklist or code.').split('{key}')
  const date = new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())

  const finish = async () => {
    setPhase('leaving')
    await onPersist().catch(() => undefined)
    onReveal?.(pageId)
    // let the workspace render and open the page, so its row is where it will stay
    await frame()
    await frame()
    const el = sheet.current
    const row = pageId ? target?.() : null
    if (el && !reduce()) {
      const from = el.getBoundingClientRect()
      const to = row?.getBoundingClientRect()
      const css = getComputedStyle(document.documentElement)
      const end = to && to.width
        ? `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(${to.width / from.width}, ${Math.max(to.height / from.height, 0.02)})`
        : 'scale(.96)'
      const duration = (parseFloat(css.getPropertyValue('--ds-slow')) || 300) * 1.6
      await el.animate([{ transform: 'none', opacity: 1 }, { transform: end, opacity: 0 }], { duration, easing: css.getPropertyValue('--ds-ease').trim() || 'ease', fill: 'forwards' }).finished.catch(() => undefined)
    }
    onFinish(pageId)
  }

  return (
    <>
      <div className="fn" data-phase={phase}>
        {arrival !== 'still' && (
          <main className="fn-stage">
            <p className="fn-kicker"><BrandMark size={16} />{t('Your first note in {name}', { name: workspace })}</p>
            <article
              ref={sheet}
              className="fn-sheet"
              onKeyDownCapture={(e) => {
                if (e.key === '/' && !e.ctrlKey && !e.metaKey) setUsedSlash(true)
              }}
            >
              <header className="fn-sheet-meta">
                <time>{date}</time>
                <SaveStatus state={status} label={t(STATUS_LABEL[status])} />
              </header>
              <HomeNote
                bare
                autoFocus
                starter={starter}
                onOpen={() => undefined}
                onPersist={onPersist}
                onDirty={onDirty}
                onStatus={(next) => {
                  setStatus(next)
                  if (next !== 'saved' || savedOnce.current) return
                  savedOnce.current = true
                  setSavedTip(true)
                  later(3200, () => setSavedTip(false))
                }}
                onChange={(draft) => {
                  const id = onChange(draft)
                  setPageId(id)
                  if (/[.!?؟]\s|\n|\S{2,}\s+\S{2,}\s+\S{2,}/.test(draft.text)) setWrote(true)
                  // a slash typed without a key event (paste, IME) also counts as having found the commands
                  if (draft.text.includes('/')) setUsedSlash(true)
                  return id
                }}
              />
              {/* ways to start, on one line, until the first word */}
              {!started && (
                <footer className="fn-ideas" role="group" aria-label={t('Ways to start')}>
                  <span>{t('Or begin with')}</span>
                  {IDEAS.map((idea) => (
                    <Button key={idea.id} size="sm" variant="ghost" icon={<Icon name={idea.icon} size={14} />} onClick={() => setStarter({ key: idea.id, title: t(idea.label), content: { type: 'doc', content: idea.content() } })}>
                      {t(idea.label)}
                    </Button>
                  ))}
                </footer>
              )}
            </article>
            <p className="fn-tip" role="status" key={tip ?? 'none'}>
              {tip === 'slash' && <><Icon name="command" size={16} /><span>{slashTip[0]}<kbd>/</kbd>{slashTip[1]}</span></>}
              {tip === 'saved' && <><Icon name="folder" size={16} /><span>{t('Every note is saved as a file in your workspace folder.')}</span></>}
              {tip === 'ready' && <><Icon name="arrow-right" size={16} className="ds-flip" /><span>{t('Write as much as you like, then step into your workspace.')}</span></>}
            </p>
            <div className="fn-actions">
              <Button variant={started ? 'primary' : 'ghost'} disabled={phase === 'leaving'} onClick={() => void finish()}>
                {started ? t('Go to your workspace') : t('Skip for now')}
                <Icon name="arrow-right" size={16} className="ds-flip" />
              </Button>
            </div>
          </main>
        )}
      </div>
      {arrival !== 'done' && <LandingFrame name={workspace} leaving={arrival === 'leaving'} />}
    </>
  )
}
