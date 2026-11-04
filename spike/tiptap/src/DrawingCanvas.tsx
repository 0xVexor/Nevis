// The Excalidraw canvas used by both the page "Drawing" block (in a modal) and Board pages (inline).
// Loaded on demand only: it pulls in the whole library.
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useRef, useState, type KeyboardEvent } from 'react'
import './editor/excalidrawAssets' // sets the font path; must come before the library
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { loadLibrary, saveLibrary, type SceneData } from './editor/excalidraw'
import { isDark, useSettings } from './settings'
import { getLang, t } from './i18n'
import { Icon, IconButton } from './design-system'

interface Props {
  initial: SceneData | null
  onApi: (api: ExcalidrawImperativeAPI) => void
  onChange?: (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => void
  viewMode?: boolean
}

type Tool = 'hand' | 'selection' | 'rectangle' | 'diamond' | 'ellipse' | 'arrow' | 'line' | 'freedraw' | 'text' | 'image' | 'eraser'

/** The drawing tools in the library's order, with our icons and the keys the library already answers to. */
const TOOLS: { tool: Tool; icon: string; label: string; key: string }[] = [
  { tool: 'hand', icon: 'hand', label: 'Move the canvas', key: 'H' },
  { tool: 'selection', icon: 'pointer', label: 'Select', key: '1' },
  { tool: 'rectangle', icon: 'square', label: 'Rectangle', key: '2' },
  { tool: 'diamond', icon: 'rhombus', label: 'Diamond', key: '3' },
  { tool: 'ellipse', icon: 'circle', label: 'Ellipse', key: '4' },
  { tool: 'arrow', icon: 'arrow-tool', label: 'Arrow', key: '5' },
  { tool: 'line', icon: 'line', label: 'Line', key: '6' },
  { tool: 'freedraw', icon: 'pencil', label: 'Draw', key: '7' },
  { tool: 'text', icon: 'type', label: 'Text', key: '8' },
  { tool: 'image', icon: 'image', label: 'Image', key: '9' },
  { tool: 'eraser', icon: 'eraser', label: 'Eraser', key: '0' },
]

/** The Latin character a physical letter or number key types: KeyR → r, Digit1 → 1. */
const latinOf = (code: string) => (/^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit[0-9]$/.test(code) ? code.slice(5) : null)

/**
 * The library reads shortcuts from the typed character, so with a Persian (or any non-Latin) keyboard 1 to 0, the
 * letter tools and Ctrl+Z stop working. Like the rest of Nevis, shortcuts follow the physical key: a key that typed
 * something else is handed on as the Latin key in the same place. Typing text in the drawing is left alone.
 */
function physicalKeys(e: KeyboardEvent<HTMLDivElement>) {
  const native = e.nativeEvent
  if (!native.isTrusted || native.isComposing) return
  const target = e.target as HTMLElement
  if (target.isContentEditable || target.matches('input, textarea, select')) return
  const latin = latinOf(native.code)
  if (!latin || native.key.toLowerCase() === latin) return
  e.stopPropagation()
  e.preventDefault()
  target.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      key: native.shiftKey ? latin.toUpperCase() : latin,
      code: native.code,
      ctrlKey: native.ctrlKey,
      metaKey: native.metaKey,
      shiftKey: native.shiftKey,
      altKey: native.altKey,
      bubbles: true,
      cancelable: true,
    }),
  )
}

/**
 * Excalidraw dressed in Nevis: its colours, surfaces, corners and type come from our tokens (`.ds-canvas` in
 * drawings.css), and its tool bar is ours, drawn with our icons and buttons and driving the library through its API.
 */
export default function DrawingCanvas({ initial, onApi, onChange, viewMode }: Props) {
  useSettings() // re-render when the light/dark setting changes
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const [tool, setTool] = useState<{ type: string; locked: boolean }>({ type: 'selection', locked: false })

  const changed = (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    const next = appState.activeTool
    // the library reports every change; the bar only re-renders when the tool or the lock actually changed
    if (next.type !== tool.type || next.locked !== tool.locked) setTool({ type: next.type, locked: next.locked })
    onChange?.(elements, appState, files)
  }
  const pick = (type: Tool) => api.current?.setActiveTool({ type, locked: tool.locked })

  return (
    <div className="ds-canvas" onKeyDownCapture={physicalKeys}>
      {!viewMode && (
        <div className="ds-canvas-tools" role="toolbar" aria-label={t('Drawing tools')}>
          <IconButton label={t(tool.locked ? 'Keep the tool after drawing: on' : 'Keep the tool after drawing: off') + '  Q'} pressed={tool.locked} onClick={() => api.current?.setActiveTool({ type: tool.type as Tool, locked: !tool.locked })}>
            <Icon name={tool.locked ? 'lock' : 'unlock'} size={17} />
          </IconButton>
          <span className="ds-canvas-sep" aria-hidden="true" />
          {TOOLS.map((x) => (
            <IconButton key={x.tool} label={t(x.label) + '  ' + x.key} pressed={tool.type === x.tool} onClick={() => pick(x.tool)}>
              <Icon name={x.icon} size={17} />
              {/^[0-9]$/.test(x.key) && <span className="ds-canvas-key">{x.key}</span>}
            </IconButton>
          ))}
        </div>
      )}
      <Excalidraw
        excalidrawAPI={(a) => ((api.current = a), onApi(a))}
        initialData={{
          elements: initial?.elements ?? [],
          // Persian reads from the right, so new text starts right-aligned (it can still be changed per text)
          appState: { ...(initial?.appState ?? {}), ...(getLang() === 'fa' ? { currentItemTextAlign: 'right' as const } : {}), collaborators: new Map() },
          files: initial?.files ?? {},
          libraryItems: loadLibrary(),
          scrollToContent: !!initial,
        }}
        theme={isDark() ? 'dark' : 'light'}
        langCode={getLang() === 'fa' ? 'fa-IR' : 'en'}
        viewModeEnabled={viewMode}
        onChange={changed}
        onLibraryChange={(items) => saveLibrary(items)}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
        autoFocus
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  )
}
