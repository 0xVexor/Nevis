import 'katex/dist/katex.min.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './settings'
import App from './App.tsx'
import { initStore, repo } from './store'
import { initBackup } from './autobackup'
import { initSearchIndex } from './searchIndex'
import { isTauri, vaultList } from './db'
import { VaultPicker } from './VaultPicker'
import { initInputMenu } from './inputMenu'

initInputMenu()
const root = createRoot(document.getElementById('root')!)

function start() {
  // the workspace is loaded before the first render
  initStore().then(() => {
    void initBackup()
    void repo.watch()
    initSearchIndex()
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
}

// Desktop app: a vault must be open first; otherwise the user picks or creates one (there is no default location).
if (isTauri) {
  vaultList().then(({ current }) => {
    if (current) return start()
    root.render(<VaultPicker onOpened={() => window.location.reload()} />)
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
