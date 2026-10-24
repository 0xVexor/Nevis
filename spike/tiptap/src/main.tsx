import 'katex/dist/katex.min.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './settings'
import App from './App.tsx'
import './notion-preview.css'
import './notion-color-preview.css'
import { initStore } from './store'
import { initBackup } from './autobackup'

// Opt-in visual experiment only; the regular URL keeps the original design.
const designPreview = new URLSearchParams(window.location.search).get('design')
if (designPreview === 'notion' || designPreview === 'notion-color') {
  document.documentElement.dataset.designPreview = 'notion'
  if (designPreview === 'notion-color') document.documentElement.dataset.designTone = 'color'
}

// The workspace lives in IndexedDB (async), so it is loaded before the first render.
initStore().then(() => {
  void initBackup()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
