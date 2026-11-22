// A board: a page that is one drawing (the old app's "board"): a header with the way back, the title and full screen, and the whole window
// a canvas that saves by itself. The page is an ordinary page whose body is a single `drawing` block, so search, history, export and sync
// treat it like any page; the settings mark it as a board (one register per board, like a to-do list).
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { BODY, uuidv7 } from '@nevis/schema'
import { readScene, writeScene } from '@nevis/editor'
import type { DocHandle } from '@nevis/core'
import { Button, Icon, IconButton } from './ds'
import { t } from './i18n'
import { go } from './router'
import type { SceneData } from './shell/DrawingCanvas'
import type { Workspace } from './workspace'

const Canvas = lazy(() => import('./shell/DrawingCanvas')) // the drawing library loads only when a board opens
const SAVE_DELAY = 1500
const signature = (elements: readonly { id: string; version: number }[]) => elements.map(e => e.id + ':' + e.version).join(',')
type Loaded = { status: 'empty' } | { status: 'ok'; scene: SceneData } | { status: 'unreadable' | 'missing' }

/** The board's single drawing block, made if the page has none yet. */
function drawingOf(h: DocHandle): Y.XmlElement {
  const frag = h.ydoc.getXmlFragment(BODY)
  for (const c of frag.toArray()) if ('nodeName' in c && c.nodeName === 'drawing') return c as Y.XmlElement
  let el!: Y.XmlElement
  h.ydoc.transact(() => { el = new Y.XmlElement('drawing'); el.setAttribute('blockId', uuidv7() as never); frag.insert(0, [el]) })
  return el
}

export function BoardPage({ ws, id, title }: { ws: Workspace; id: string; title: string }) {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [save, setSave] = useState<'saved' | 'saving' | 'error'>('saved')
  const [name, setName] = useState(title)
  const [full, setFull] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const doc = useRef<DocHandle | null>(null)
  const latest = useRef<SceneData | null>(null)
  const saved = useRef('')
  const timer = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => setName(title), [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true, handle: DocHandle | null = null
    setLoaded(undefined)
    void (async () => {
      const h = await ws.openDoc(id); handle = h; doc.current = h
      if (!live) return
      const el = drawingOf(h)
      const hash = String(el.getAttribute('sceneBlob') ?? ''), inline = String(el.getAttribute('scene') ?? '')
      let json = inline
      if (hash) { const b = await ws.rt.attachments.open(hash, 'application/json').catch(() => null); if (!b) { if (live) setLoaded({ status: 'missing' }); return } json = await b.text() }
      const { prepareExcalidraw } = await import('@nevis/editor'); await prepareExcalidraw()
      const L = await import('@excalidraw/excalidraw')
      const r = readScene(json, (d: unknown) => { const x = d as { elements?: unknown[]; appState?: Record<string, unknown> }; return L.restore({ elements: (x.elements ?? []) as never, appState: (x.appState ?? {}) as never, files: {} }, null, null) })
      if (!live) return
      if (r.status === 'ok') { saved.current = signature(r.scene.elements as never); setLoaded({ status: 'ok', scene: r.scene as SceneData }) }
      else if (r.status === 'empty') { saved.current = ''; setLoaded({ status: 'empty' }) }
      else setLoaded({ status: 'unreadable' })
    })().catch(() => { if (live) setLoaded({ status: 'unreadable' }) })
    return () => { live = false; if (handle) void ws.closeDoc(id); doc.current = null }
  }, [ws, id, attempt])

  const run = () => {
    queue.current = queue.current.then(async () => {
      const scene = latest.current, h = doc.current
      const sig = scene && signature(scene.elements as never) // taken before any await: edits made while saving stay unsaved
      if (!scene || !h || sig === saved.current) return setSave('saved')
      const out = writeScene({ type: 'excalidraw', version: 2, source: 'nevis', elements: (scene.elements as readonly { isDeleted?: boolean }[]).filter(e => !e.isDeleted), appState: { viewBackgroundColor: String((scene.appState as { viewBackgroundColor?: string }).viewBackgroundColor ?? '#ffffff') }, files: {} }, 64 * 1024 * 1024)
      if (!out.ok) return setSave('error')
      try {
          const ref = await ws.rt.attachments.add(new Blob([out.json], { type: 'application/json' }), 'drawing.json', 'application/json')
          const el = drawingOf(h)
        h.ydoc.transact(() => { el.setAttribute('sceneBlob', ref.blob as never); el.setAttribute('scene', '' as never) })
          await h.flush()
        saved.current = sig!
        setSave('saved')
      } catch (e) { console.error('board save', e); setSave('error') }
    })
    return queue.current
  }
  useEffect(() => {
    const flush = () => { window.clearTimeout(timer.current); timer.current = 0; void run() }
    const hidden = () => document.visibilityState === 'hidden' && flush()
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); window.clearTimeout(timer.current); timer.current = 0; void run() }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  const changed = (elements: readonly never[], appState: never, files: never) => {
    latest.current = { elements, appState, files } as SceneData
    if (signature(elements as never) === saved.current) return
    // a throttle, not a debounce: the canvas reports changes all the time, and a timer that restarts on each report would never fire
    setSave('saving')
    if (!timer.current) timer.current = window.setTimeout(() => { timer.current = 0; void run() }, SAVE_DELAY)
  }
  // real full screen (the element goes above the sidebar); a plain overlay when the browser refuses
  const toggleFull = () => {
    if (document.fullscreenElement) return void document.exitFullscreen()
    if (full) return setFull(false)
    const el = root.current
    if (!el?.requestFullscreen) return setFull(true)
    el.requestFullscreen().catch(() => setFull(true))
  }
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', sync)
    return () => { document.removeEventListener('fullscreenchange', sync); if (document.fullscreenElement === root.current) void document.exitFullscreen() }
  }, [])

  return (
    <div ref={root} className={'board' + (full ? ' full' : '')} data-testid="board">
      <div className="board-head">
        <IconButton label={t('Back to drawings')} data-testid="board-back" onClick={() => go({ name: 'drawings' })}><Icon name="arrow-left" className="ds-flip" /></IconButton>
        <input className="board-title" data-testid="board-title" dir="auto" placeholder={t('Untitled')} aria-label={t('Page title')} value={name} onChange={e => { setName(e.target.value); ws.setTitle(id, e.target.value) }} />
        <span className="board-save" data-state={save} role="status">{save === 'saving' ? t('Saving…') : save === 'error' ? t('Could not save. Your changes are still here.') : t('All changes saved')}</span>
        <IconButton label={full ? t('Exit full screen') : t('Full screen')} pressed={full} onClick={toggleFull}><Icon name={full ? 'minimize' : 'maximize'} /></IconButton>
      </div>
      <div className="board-stage" dir="ltr">
        {loaded === undefined ? <div className="board-loading">{t('Loading…')}</div>
          : loaded.status === 'missing' || loaded.status === 'unreadable' ? (
            // nothing is mounted, so nothing can be drawn or saved over the stored drawing
            <div className="board-loading" role="alert" style={{ flexDirection: 'column', gap: 'var(--ds-s3)', textAlign: 'center' }}>
              {loaded.status === 'missing' && <span>{t('The drawing is still arriving from sync…')}</span>}
              <span>{t('This drawing could not be loaded. Its file is missing or unreadable; nothing was changed.')}</span>
              <Button size="sm" onClick={() => setAttempt(n => n + 1)}>{t('Retry')}</Button>
            </div>
          ) : (
            <Suspense fallback={<div className="board-loading">{t('Loading…')}</div>}>
              <Canvas initial={loaded.status === 'ok' ? loaded.scene : null} onApi={() => undefined} onChange={changed as never} viewMode={false} />
            </Suspense>
          )}
      </div>
    </div>
  )
}
