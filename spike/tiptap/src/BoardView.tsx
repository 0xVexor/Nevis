// A Board page: the whole page is one drawing (Excalidraw), saved automatically.
// The page content is a doc holding a single `drawing` block, so files, search, history and backup treat it like any page.
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { repo, gcFiles } from './store'
import type { Page } from './repo'
import type { SaveState } from './PageView'
import { loadScene, saveScene, type SceneData } from './editor/excalidraw'
import { t } from './i18n'
import * as Ic from './icons'
import { registerUpdateSave, trackPendingSave } from './updateSave'

const Canvas = lazy(() => import('./DrawingCanvas')) // the library loads only when a board is opened

const SAVE_DELAY = 1500
const signature = (elements: readonly any[]) => elements.map((e) => e.id + ':' + e.version).join(',')
const boardDoc = (ids: { scene: string; preview: string }) => ({ type: 'doc', content: [{ type: 'drawing', attrs: ids }] })

export function BoardView({ page, onSave, onMeta, readOnly = false }: { page: Page; onSave: (s: SaveState) => void; onMeta: () => void; readOnly?: boolean }) {
  const [initial, setInitial] = useState<SceneData | null | undefined>(undefined) // undefined = still loading
  const latest = useRef<SceneData | null>(null) // newest canvas state; read on save so the Excalidraw API is never touched after unmount
  const loadedScene = useRef<string | null>(null)
  const saved = useRef('') // signature of what is stored
  const timer = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const releaseRefresh = useRef<(() => void) | null>(null)
  const dirty = useRef(false) // anything saved during this visit (then old files are garbage-collected on leaving)
  const saveError = useRef<unknown>(null)
  const mounted = useRef(true)
  const [loadError, setLoadError] = useState(false)
  const [full, setFull] = useState(false) // the board fills the whole window
  const root = useRef<HTMLDivElement>(null)
  const notify = useRef(onSave)
  notify.current = onSave
  const notifyState = (state: SaveState) => { if (mounted.current) notify.current(state) }

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
    const incoming = page.content?.content?.[0]?.attrs?.scene ?? ''
    if (releaseRefresh.current || loadedScene.current === incoming) return
    loadedScene.current = incoming
    setInitial(undefined)
    setLoadError(false)
    latest.current = null
    void loadScene(page.content?.content?.[0]?.attrs?.scene ?? '').then((s) => {
      if (!live) return
      if (incoming && !s) { setLoadError(true); return }
      saved.current = signature(s?.elements ?? [])
      setInitial(s)
    }).catch(() => { if (live) setLoadError(true) })
    return () => void (live = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, page.content?.content?.[0]?.attrs?.scene])

  const run = () => {
    queue.current = queue.current.catch(() => {}).then(async () => {
      const scene = latest.current
      if (!scene || signature(scene.elements) === saved.current) { releaseRefresh.current?.(); releaseRefresh.current = null; return notifyState('saved') }
      try {
        const snapshot = structuredClone(scene)
        const ids = await saveScene(snapshot)
        loadedScene.current = ids?.scene ?? ''
        repo.update(page.id, { content: boardDoc(ids ?? { scene: '', preview: '' }) })
        await repo.flushed()
        saved.current = signature(snapshot.elements)
        saveError.current = null
        dirty.current = true
        if (latest.current && signature(latest.current.elements) === saved.current) { releaseRefresh.current?.(); releaseRefresh.current = null }
      } catch (e) {
        saveError.current = e
        console.error('board save', e)
        notifyState('error')
        throw e
      }
      if (!releaseRefresh.current) notifyState('saved')
    })
    return trackPendingSave(queue.current)
  }

  useEffect(() => {
    mounted.current = true
    const unregister = registerUpdateSave(async () => {
      window.clearTimeout(timer.current)
      await run()
      if (saveError.current) throw saveError.current
    })
    const flush = () => (window.clearTimeout(timer.current), void run().catch(() => {}))
    const hidden = () => document.visibilityState === 'hidden' && flush()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      mounted.current = false
      unregister()
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', hidden)
      window.clearTimeout(timer.current)
      void run().then(() => (dirty.current ? gcFiles() : undefined)).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id])

  const changed = (elements: readonly any[], appState: any, files: any) => {
    latest.current = { elements, appState, files }
    if (readOnly || signature(elements) === saved.current) return
    releaseRefresh.current ??= repo.holdRefresh()
    notifyState('saving')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void run().catch(() => {}), SAVE_DELAY)
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
        {loadError ? (
          <div className="board-loading" role="alert">{t('Drawing files are unavailable. Sync and reopen this page. Your saved drawing has been kept.')}</div>
        ) : initial === undefined ? (
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
