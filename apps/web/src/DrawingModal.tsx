import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { prepareExcalidraw, readScene, writeScene } from '@nevis/editor'
import { Button } from './ds'
import { t } from './i18n'
import type { SceneData } from './shell/DrawingCanvas'

const DrawingCanvas = lazy(() => import('./shell/DrawingCanvas'))

function DrawingEditor({ initial, max, notify, close }: { initial: SceneData | null; max: number; notify: (message: string) => void; close: (scene: string | null) => void }) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { root.current?.focus() }, [])
  const done = () => {
    if (!api.current || saving) return
    setSaving(true)
    const out = writeScene({ type: 'excalidraw', version: 2, source: 'nevis', elements: api.current.getSceneElementsIncludingDeleted().filter(e => !e.isDeleted), appState: { viewBackgroundColor: api.current.getAppState().viewBackgroundColor }, files: api.current.getFiles() }, max)
    if (out.ok) close(out.json)
    else { notify(t('The drawing could not be saved. Please try again.')); setSaving(false) }
  }
  return <div ref={root} className="drawing-modal" role="dialog" aria-modal="true" aria-label={t('Drawing')} tabIndex={-1}
    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done() } }}>
    <div className="drawing-bar"><strong>{t('Drawing')}</strong><span className="drawing-hint">{t('Ctrl+Enter save')}</span>
      <Button size="sm" onClick={() => close(null)}>{t('Cancel')}</Button>
      <Button size="sm" variant="primary" data-testid="drawing-save" onClick={done} disabled={saving}>{saving ? t('Saving…') : t('Done')}</Button>
    </div>
    <div className="drawing-stage" dir="ltr"><Suspense fallback={<p>{t('Loading…')}</p>}><DrawingCanvas initial={initial} onApi={a => { api.current = a }} /></Suspense></div>
  </div>
}

/** The old drawing UI, returning scene JSON through the new editor's port. */
export async function openDrawingEditor(json: string, max: number, notify: (message: string) => void): Promise<string | null> {
  await prepareExcalidraw()
  const { restore } = await import('@excalidraw/excalidraw')
  const loaded = readScene(json, data => restore(data as Parameters<typeof restore>[0], null, null))
  if (loaded.status === 'unreadable') { notify(t('This drawing could not be loaded. Its file is missing or unreadable; nothing was changed.')); return null }
  return new Promise(resolve => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const close = (scene: string | null) => { root.unmount(); host.remove(); resolve(scene) }
    root.render(<DrawingEditor initial={loaded.status === 'ok' ? loaded.scene : null} max={max} notify={notify} close={close} />)
  })
}
