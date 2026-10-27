import { setPreference } from '../preferenceEvents'
import { putFile, urlFor } from '../attachments'
import { hasArabicScript, loadPersianFont, persianFontCss } from './persianFont'

type Lib = typeof import('@excalidraw/excalidraw')
let lib: Promise<Lib> | null = null

/** Loaded on first use only (the library is large). The Persian font is ready by the time this resolves, so the canvas draws with it from the start. */
export function excalidraw(): Promise<Lib> {
  return (lib ??= import('./excalidrawAssets')
    .then(() => Promise.all([import('@excalidraw/excalidraw'), loadPersianFont()]))
    .then(([m]) => m))
}

export interface SceneData {
  elements: readonly any[]
  appState: Record<string, any>
  files: Record<string, any>
}

/** Reads a stored scene (`att:` id of its JSON) and normalises it for the current Excalidraw version. */
export async function loadScene(id: string): Promise<SceneData | null> {
  await excalidraw() // also for an empty board: the canvas must not mount before the library and font are ready
  if (!id) return null
  const url = await urlFor('att:' + id)
  if (!url) return null
  try {
    const { restore } = await excalidraw()
    const data = JSON.parse(await (await fetch(url)).text())
    const restored = restore(data, null, null)
    return { elements: restored.elements, appState: restored.appState, files: data.files ?? {} }
  } catch {
    return null
  }
}

/** Stores the scene JSON and a picture of it; returns the two file ids, or null for an empty drawing. */
export async function saveScene(scene: SceneData): Promise<{ scene: string; preview: string } | null> {
  const live = scene.elements.filter((e) => !e.isDeleted)
  if (!live.length) return null
  const { serializeAsJSON, exportToSvg } = await excalidraw()
  const json = serializeAsJSON(scene.elements as any, scene.appState as any, scene.files as any, 'local')
  const svg = await exportToSvg({
    elements: scene.elements as any,
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false } as any,
    files: scene.files as any,
    exportPadding: 16,
  })
  if (live.some((e) => e.type === 'text' && hasArabicScript(e.text ?? ''))) {
    // the picture is shown in an <img>, which cannot see the page's fonts: carry the Persian font inside it
    const fontCss = await persianFontCss()
    if (fontCss) {
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
      style.textContent = fontCss
      let defs = svg.querySelector('defs')
      if (!defs) svg.insertBefore((defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')), svg.firstChild)
      defs.append(style)
    }
  }
  const markup = new XMLSerializer().serializeToString(svg)
  return {
    scene: await putFile(new Blob([json], { type: 'application/json' }), 'drawing.excalidraw'),
    preview: await putFile(new Blob([markup], { type: 'image/svg+xml' }), 'drawing.svg'),
  }
}

const LIBRARY_KEY = 'not.drawing.library'

export function loadLibrary(): any[] {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function saveLibrary(items: readonly unknown[]) {
  try {
    setPreference(LIBRARY_KEY, JSON.stringify(items))
  } catch {
    /* storage full or blocked: the library is only a convenience */
  }
}

/** Starts loading the editor in the background (call on hover/press of a "draw" control) so it is ready by the click. */
export const warmDrawing = () => void excalidraw()
