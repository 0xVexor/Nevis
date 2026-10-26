// Full-screen editor for the "Drawing" block. Loaded on demand (it pulls in the whole library).
import { useEffect, useRef, useState } from 'react'
import { registerUpdateSave } from './updateSave'
import { createRoot } from 'react-dom/client'
import DrawingCanvas from './DrawingCanvas'
import { saveScene, type SceneData } from './editor/excalidraw'
import { t } from './i18n'

/** Stored file ids of the finished drawing (both empty for a cleared canvas). */
export interface DrawingResult {
  scene: string
  preview: string
}

function DrawingEditor({ initial, onClose }: { initial: SceneData | null; onClose: (r: DrawingResult | null) => void }) {
  const api = useRef<any>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => registerUpdateSave(() => { throw new Error('Finish the open drawing before restarting') }), [])

  const done = async () => {
    if (!api.current || saving) return
    setSaving(true)
    try {
      const saved = await saveScene({
        elements: api.current.getSceneElementsIncludingDeleted(),
        appState: api.current.getAppState(),
        files: api.current.getFiles(),
      })
      onClose(saved ?? { scene: '', preview: '' })
    } catch {
      setSaving(false)
    }
  }

  return (
    <div
      className="drawing-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t('Drawing')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), void done())
      }}
    >
      <div className="drawing-bar">
        <strong>{t('Drawing')}</strong>
        <span className="drawing-hint">{t('Ctrl+Enter save')}</span>
        <button type="button" className="drawing-cancel" onClick={() => onClose(null)}>
          {t('Cancel')}
        </button>
        <button type="button" className="drawing-done" onClick={() => void done()} disabled={saving}>
          {saving ? t('Saving…') : t('Done')}
        </button>
      </div>
      <div className="drawing-stage" dir="ltr">
        <DrawingCanvas initial={initial} onApi={(a) => (api.current = a)} />
      </div>
    </div>
  )
}

/** Opens the editor over the app; resolves with the saved file ids, or null if the user cancelled. */
export function openDrawingEditor(initial: SceneData | null): Promise<DrawingResult | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const close = (r: DrawingResult | null) => {
      root.unmount()
      host.remove()
      resolve(r)
    }
    root.render(<DrawingEditor initial={initial} onClose={close} />)
  })
}
