// A Board page: the whole page is one drawing (Excalidraw), saved automatically.
// The page content is a doc holding a single `drawing` block, so files, search, history and backup treat it like any page.
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { repo, gcFiles } from './store'
import type { Page } from './repo'
import type { SaveState } from './PageView'
import { loadScene, saveScene, type SceneData } from './editor/excalidraw'
import { t } from './i18n'
import * as Ic from './icons'

const Canvas = lazy(() => import('./DrawingCanvas')) // the library loads only when a board is opened

const SAVE_DELAY = 1500
const signature = (elements: readonly any[]) => elements.map((e) => e.id + ':' + e.version).join(',')
const boardDoc = (ids: { scene: string; preview: string }) => ({ type: 'doc', content: [{ type: 'drawing', attrs: ids }] })

export function BoardView({ page, onSave, onMeta, readOnly = false }: { page: Page; onSave: (s: SaveState) => void; onMeta: () => void; readOnly?: boolean }) {
  const [initial, setInitial] = useState<SceneData | null | undefined>(undefined) // undefined = still loading
  const latest = useRef<SceneData | null>(null) // newest canvas state; read on save so the Excalidraw API is never touched after unmount
  const saved = useRef('') // signature of what is stored
  const timer = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const dirty = useRef(false) // anything saved during this visit (then old files are garbage-collected on leaving)
  const [full, setFull] = useState(false) // the board fills the whole window
  const root = useRef<HTMLDivElement>(null)
  const notify = useRef(onSave)
  notify.current = onSave

  // real full screen (the element goes to the browser's top layer, above the sidebar); a plain overlay if the browser refuses
  const toggleFull = () => {
    if (document.fullscreenElement) return void document.exitFullscreen()
    if (full) return setFull(false)
    const el = root.current
    if (!el?.requestFullscreen) return setFull(true)
    el.requestFullscreen().catch(() => setFull(true))
    window.setTimeout(() => !document.fullscreenElement && setFull(true), 500) // a webview that ignores the request still gets the overlay
  }
  useEffect(() => {
    const sync = () => document.fullscreenElement === root.current && setFull(true)
    const leave = () => !document.fullscreenElement && setFull(false)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('fullscreenchange', leave)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('fullscreenchange', leave)
      if (document.fullscreenElement === root.current) void document.exitFullscreen()
    }
  }, [])
  // the overlay covers the window: the sidebar steps aside while it is up
  useEffect(() => {
    full ? document.documentElement.setAttribute('data-board-full', '') : document.documentElement.removeAttribute('data-board-full')
    return () => document.documentElement.removeAttribute('data-board-full')
  }, [full])

  useEffect(() => {
    let live = true
    void loadScene(page.content?.content?.[0]?.attrs?.scene ?? '').then((s) => {
      if (!live) return
      saved.current = signature(s?.elements ?? [])
      setInitial(s)
    })
    return () => void (live = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id])

  const run = () => {
    queue.current = queue.current.then(async () => {
      const scene = latest.current
      if (!scene || signature(scene.elements) === saved.current) return notify.current('saved')
      saved.current = signature(scene.elements)
      try {
        const ids = await saveScene(scene)
        repo.update(page.id, { content: boardDoc(ids ?? { scene: '', preview: '' }) })
        dirty.current = true
      } catch (e) {
        console.error('board save', e)
      }
      notify.current('saved')
    })
    return queue.current
  }

  useEffect(() => {
    const flush = () => (window.clearTimeout(timer.current), void run())
    const hidden = () => document.visibilityState === 'hidden' && flush()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', hidden)
      window.clearTimeout(timer.current)
      void run().then(() => (dirty.current ? gcFiles() : undefined))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id])

  const changed = (elements: readonly any[], appState: any, files: any) => {
    latest.current = { elements, appState, files }
    if (readOnly || signature(elements) === saved.current) return
    notify.current('saving')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void run(), SAVE_DELAY)
  }

  return (
    <div ref={root} className={'board' + (full ? ' full' : '')}>
      <div className="board-head">
        <input
          className="board-title"
          readOnly={readOnly}
          dir="auto"
          placeholder={t('Untitled')}
          defaultValue={page.title}
          onChange={(e) => (repo.update(page.id, { title: e.target.value }), onMeta())}
        />
        <button className="icon-btn board-full" title={full ? t('Exit full screen') : t('Full screen')} aria-pressed={full} onClick={toggleFull}>
          {full ? <Ic.Shrink /> : <Ic.Enlarge />}
        </button>
      </div>
      <div className="board-stage" dir="ltr">
        {initial === undefined ? (
          <div className="board-loading">{t('Loading…')}</div>
        ) : (
          <Suspense fallback={<div className="board-loading">{t('Loading…')}</div>}>
            <Canvas initial={initial} onApi={() => {}} onChange={changed} viewMode={readOnly} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
