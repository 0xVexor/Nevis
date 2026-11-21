// The drawing block: the scene is a JSON string, either in the node (`scene`, <= 256 KB: pages written before SV 3 and editors with no
// attachments) or in an attachment (`sceneBlob`, SV 3: no such limit). An inline scene is moved to an attachment only when it is next EDITED,
// never on open. A scene whose attachment has not arrived is shown as "still arriving" and can be neither edited nor overwritten. The preview is drawn FROM the
// scene on screen (no stored picture); editing opens Excalidraw full-screen, loaded on first use. Fonts and assets come from the app's
// own origin (`./excalidraw-assets/`, copied by the web build): nothing loads from a CDN, so it works offline and under both CSPs.
import type { NodeViewRendererProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Drawing as DrawingSpec, MAX_DRAWING_SCENE, isBlobHash } from '@nevis/schema'
import type { Editor } from '@tiptap/core'
import { whenAvailable } from '../attachments'
import { optionsOf } from '../options'
import { readScene, writeScene } from '../scene'
import { S } from '../strings'

// Excalidraw's hand-drawn fonts have no Persian letters; its font stack ends in the family "Xiaolai", so Vazirmatn is registered under
// that name for Arabic-script code points only: Persian looks the same everywhere and Latin text keeps the hand-drawn font.
const FONT_FILE = 'fonts/Vazirmatn/Vazirmatn-arabic-400.woff2'
const RANGE = 'U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF,U+200C-200D'
const assetBase = () => new URL('./excalidraw-assets/', document.baseURI).href
let font: Promise<void> | null = null
const loadPersianFont = () => (font ??= (async () => { document.fonts.add(await new FontFace('Xiaolai', `url(${assetBase()}${FONT_FILE})`, { unicodeRange: RANGE }).load()) })().catch(() => undefined))

type Lib = typeof import('@excalidraw/excalidraw')
let lib: Promise<Lib> | null = null
const loadExcalidraw = () => (lib ??= (async () => {
  ;(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = assetBase()
  await loadPersianFont()
  await import('@excalidraw/excalidraw/index.css')
  return import('@excalidraw/excalidraw')
})())

const restoreScene = (L: Lib) => (data: unknown) => {
  const d = data as { elements?: unknown[]; appState?: Record<string, unknown> }
  return L.restore({ elements: (d.elements ?? []) as never, appState: (d.appState ?? {}) as never, files: {} }, null, null)
}

/** The picture of a scene as an SVG element, drawn at its own size (for a list of drawings); null when the scene is empty or cannot be read. */
export async function drawingSvg(json: string): Promise<SVGSVGElement | null> {
  if (!json) return null
  try {
    const L = await loadExcalidraw()
    const r = readScene(json, restoreScene(L))
    if (r.status !== 'ok') return null
    const svg = await L.exportToSvg({ elements: r.scene.elements.filter(e => !e.isDeleted), appState: { ...r.scene.appState, exportBackground: false }, files: null })
    svg.style.maxWidth = '100%'; svg.style.maxHeight = '100%'; svg.style.height = 'auto'; svg.style.display = 'block'
    return svg
  } catch { return null }
}

async function preview(host: HTMLElement, json: string) {
  host.textContent = ''
  if (!json) { host.classList.add('empty'); host.textContent = '✎'; return }
  host.classList.remove('empty', 'error')
  try {
    const L = await loadExcalidraw()
    const r = readScene(json, restoreScene(L))
    if (r.status !== 'ok') { host.classList.add('error'); host.textContent = S.formulaError; return }
    const svg = await L.exportToSvg({ elements: r.scene.elements.filter(e => !e.isDeleted), appState: { ...r.scene.appState, exportBackground: false }, files: null })
    // natural size (what the export measured), never stretched to the page width; only shrunk to fit, and never taller than most of a screen
    svg.style.maxWidth = '100%'; svg.style.maxHeight = '70vh'; svg.style.height = 'auto'; svg.style.display = 'block'; svg.style.marginInline = 'auto'
    host.append(svg)
  } catch { host.classList.add('error'); host.textContent = S.formulaError }
}

/** A scene stored as an attachment may be as large as an attachment; an inline one is limited by the op size. */
const MAX_ATTACHED_SCENE = 64 * 1024 * 1024

/** The full-screen editor. Resolves with the new scene JSON, or null if cancelled or refused. */
async function edit(json: string, notify: (m: string) => void, max: number): Promise<string | null> {
  const L = await loadExcalidraw()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const loaded = readScene(json, restoreScene(L))
  if (loaded.status === 'unreadable') { notify(S.formulaError); return null } // never save over a scene that could not be read
  const initial = loaded.status === 'ok' ? loaded.scene : { elements: [], appState: {}, files: {} }
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'drawing-overlay'
    overlay.setAttribute('dir', 'ltr')
    const bar = document.createElement('div'); bar.className = 'drawing-bar'
    const mount = document.createElement('div'); mount.className = 'drawing-canvas'
    const save = document.createElement('button'); save.type = 'button'; save.textContent = S.save; save.dataset.testid = 'drawing-save'
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = S.cancel
    bar.append(cancel, save); overlay.append(bar, mount); document.body.append(overlay)
    const root = createRoot(mount)
    let latest: { elements: readonly unknown[]; appState: Record<string, unknown> } = { elements: initial.elements, appState: initial.appState as Record<string, unknown> }
    const close = (v: string | null) => { root.unmount(); overlay.remove(); resolve(v) }
    cancel.onclick = () => close(null)
    save.onclick = () => {
      const out = writeScene({ type: 'excalidraw', version: 2, source: 'nevis', elements: latest.elements.filter(e => !(e as { isDeleted?: boolean }).isDeleted), appState: { viewBackgroundColor: String(latest.appState.viewBackgroundColor ?? '#ffffff') } }, max)
      if (!out.ok) { notify(S.tooLargeDrawing); return } // stay open: the person can delete something and try again
      close(out.json)
    }
    root.render(React.createElement(L.Excalidraw, {
      initialData: { elements: initial.elements as never, appState: initial.appState as never },
      langCode: 'fa-IR', UIOptions: { tools: { image: false } },
      onChange: (elements: readonly unknown[], appState: Record<string, unknown>) => { latest = { elements, appState } },
    } as never))
  })
}

export const Drawing = DrawingSpec.extend({
  addNodeView() {
    return ({ node, editor, getPos }: NodeViewRendererProps) => {
      let cur = node
      const dom = document.createElement('div')
      dom.className = 'drawing-block'
      dom.contentEditable = 'false'
      const view = document.createElement('div')
      view.className = 'drawing-preview'
      const btn = document.createElement('button')
      btn.type = 'button'; btn.className = 'drawing-edit'; btn.textContent = S.editDrawing; btn.dataset.testid = 'drawing-edit'
      btn.onmousedown = e => e.preventDefault()
      dom.append(view, btn)
      let busy = false
      /** the scene JSON now: '' (empty), the text, or null (its attachment has not arrived) */
      const sceneNow = async (): Promise<string | null> => {
        const hash = String(cur.attrs.sceneBlob)
        if (!isBlobHash(hash)) return String(cur.attrs.scene)
        const b = await optionsOf(editor).attachments?.open(hash, 'application/json').catch(() => null)
        return b ? b.text() : null
      }
      const open = async () => {
        if (busy || !editor.isEditable) return
        busy = true
        try {
          const json = await sceneNow()
          if (json === null) { optionsOf(editor).notify?.(S.drawingMissing); return } // never edit or save over a scene that is not here
          const port = optionsOf(editor).attachments
          const next = await edit(json, m => optionsOf(editor).notify?.(m), port ? MAX_ATTACHED_SCENE : MAX_DRAWING_SCENE)
          const pos = getPos()
          if (next === null || pos == null || next === json) return
          let attrs: Record<string, unknown>
          if (port) {
            const ref = await port.add(new Blob([next], { type: 'application/json' }), 'drawing.json', 'application/json')
            attrs = { ...cur.attrs, scene: '', sceneBlob: ref.blob }
          } else attrs = { ...cur.attrs, scene: next }
          const now = getPos()
          if (now != null) editor.view.dispatch(editor.state.tr.setNodeMarkup(now, undefined, attrs))
        } catch (e) { optionsOf(editor).notify?.(S.attachFailed); console.error(e) } finally { busy = false }
      }
      btn.onclick = () => void open()
      view.ondblclick = () => void open()
      let stopWatch: (() => void) | null = null
      let shown = ''
      const refresh = () => {
        const key = `${String(cur.attrs.sceneBlob)}|${String(cur.attrs.scene)}`
        if (key === shown) return
        shown = key
        stopWatch?.(); stopWatch = null
        const hash = String(cur.attrs.sceneBlob)
        if (!isBlobHash(hash)) { void preview(view, String(cur.attrs.scene)); return }
        stopWatch = whenAvailable(editor as Editor, hash, 'application/json', b => void b.text().then(t => void preview(view, t)), () => { view.textContent = S.drawingMissing; view.classList.add('empty') })
      }
      refresh()
      return {
        dom,
        update: (n: PMNode) => { if (n.type !== cur.type) return false; cur = n; refresh(); return true },
        destroy: () => { stopWatch?.() },
        stopEvent: (e: Event) => e.type === 'dblclick' || (e.target as HTMLElement).closest('button') !== null,
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
      }
    }
  },
})
