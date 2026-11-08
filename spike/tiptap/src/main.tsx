import { startMcpBridge } from './mcp/bridge'
import 'katex/dist/katex.min.css'
import { lazy, StrictMode, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './settings'
import App from './App.tsx'
import { initStore, repo } from './store'
import { initBackup } from './autobackup'
import { isTauri, vaultList, vaultClose } from './db'
import { VaultPicker } from './VaultPicker'
import { FirstLaunch, firstNoteMark, pendingFirstNote } from './onboarding/FirstNoteStart'
import { LandingFrame } from './onboarding/Onboarding'
import { initPreferences } from './sharedPreferences'
import { initInputMenu } from './inputMenu'
import { Button, Dialog, Notice } from './design-system'
import { DesktopFrame } from './DesktopFrame'

initInputMenu()
const root = createRoot(document.getElementById('root')!)
const render = (content: ReactNode) => root.render(<DesktopFrame>{content}</DesktopFrame>)
// the component gallery: development only, open /#/design-system
const Gallery = import.meta.env.DEV ? lazy(() => import('./design-system/Gallery').then((m) => ({ default: m.Gallery }))) : null
const showGallery = () => !!Gallery && location.hash === '#/design-system'

function start() {
  // the workspace is loaded before the first render
  const bench = import.meta.env.DEV && !isTauri ? Number(new URLSearchParams(location.search).get('bench')) : 0
  const seeded = bench > 0 ? import('./devBench').then((m) => m.seedBench(bench)) : Promise.resolve()
  // a new workspace: keep the start flow's last frame on screen while it loads, so there is no blank moment
  const handoff = firstNoteMark()
  if (handoff !== null) render(<LandingFrame name={handoff} />)
  seeded
    .then(initPreferences)
    .then(initStore)
    .then(() => {
      void initBackup()
      void repo.watch()
      if (isTauri) void startMcpBridge().catch(() => {})
      const app = (
        <StrictMode>
          {Gallery && showGallery() ? (
            <Suspense fallback={null}>
              <Gallery />
            </Suspense>
          ) : (
            <App />
          )}
        </StrictMode>
      )
      // a workspace just created by the start flow opens on its first note, then on the app
      const firstNote = pendingFirstNote()
      render(firstNote === null ? app : <FirstLaunch workspace={firstNote} app={app} />)
    })
    .catch((e) => {
      render(<StartupError error={e} kept chooseWorkspace={isTauri} />)
    })
}

// Desktop app: a vault must be open first; otherwise the user picks or creates one (there is no default location).
if (isTauri) {
  vaultList()
    .then(({ current }) => {
      if (current) return start()
      render(<VaultPicker onOpened={() => window.location.reload()} />)
    })
    .catch((e) => {
      render(<StartupError error={e} />)
    })
} else {
  start()
}

// Desktop app: the browser's own context menu (Back, Reload, Inspect…) makes it feel like a web page.
// The app has its own menus; text fields keep the native one (cut/copy/paste).
if (isTauri) {
  document.addEventListener('contextmenu', (e) => {
    if (!e.defaultPrevented && !(e.target as HTMLElement).closest('input, textarea')) e.preventDefault()
  })
}

/** The workspace could not be opened. Shown before the app (and its language) exist, so the text is in both languages. */
function StartupError({ error, kept, chooseWorkspace }: { error: unknown; kept?: boolean; chooseWorkspace?: boolean }) {
  return (
    <Dialog
      open
      title="Unable to open workspace / باز کردن فضای کاری ممکن نشد"
      onClose={() => {}}
      actions={
        <>
          {chooseWorkspace && (
            <Button
              onClick={() =>
                void vaultClose()
                  .then(() => location.reload())
                  .catch(console.error)
              }
            >
              Choose workspace / انتخاب فضای کاری
            </Button>
          )}
          <Button variant="primary" onClick={() => location.reload()}>
            Retry / تلاش دوباره
          </Button>
        </>
      }
    >
      <div className="ds-modal-body">
        <Notice tone="bad">{String(error)}</Notice>
        {kept && <p>The original files were kept. / فایل‌های اصلی حفظ شده‌اند.</p>}
      </div>
    </Dialog>
  )
}
