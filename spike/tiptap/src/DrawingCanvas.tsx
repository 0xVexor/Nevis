// The Excalidraw canvas used by both the page "Drawing" block (in a modal) and Board pages (inline).
// Loaded on demand only: it pulls in the whole library.
import './editor/excalidrawAssets' // sets the font path; must come before the library
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { loadLibrary, saveLibrary, type SceneData } from './editor/excalidraw'
import { isDark, useSettings } from './settings'
import { getLang } from './i18n'

interface Props {
  initial: SceneData | null
  onApi: (api: any) => void
  onChange?: (elements: readonly any[], appState: any, files: any) => void
  viewMode?: boolean
}

export default function DrawingCanvas({ initial, onApi, onChange, viewMode }: Props) {
  useSettings() // re-render when the light/dark setting changes
  return (
    <Excalidraw
      excalidrawAPI={onApi}
      initialData={{
        elements: (initial?.elements ?? []) as any,
        // Persian reads from the right, so new text starts right-aligned (it can still be changed per text)
        appState: { ...(initial?.appState ?? {}), ...(getLang() === 'fa' ? { currentItemTextAlign: 'right' } : {}), collaborators: new Map() } as any,
        files: (initial?.files ?? {}) as any,
        libraryItems: loadLibrary(),
        scrollToContent: !!initial,
      }}
      theme={isDark() ? 'dark' : 'light'}
      langCode={getLang() === 'fa' ? 'fa-IR' : 'en'}
      viewModeEnabled={viewMode}
      onChange={onChange}
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
  )
}
