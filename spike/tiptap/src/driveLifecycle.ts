import { invoke } from '@tauri-apps/api/core'
import { saveForSync } from './syncActions'

const ACTIVE_POLL_MS = 10_000

/** Lifecycle remote flush is best effort; local save is awaited before a native close. */
export function watchDriveLifecycle(onError: (message: string) => void = () => {}): () => void {
  let disposed = false
  let lastWake = 0
  let pending: Promise<void> | undefined
  const wake = (background: boolean) => {
    if (disposed || (!background && Date.now() - lastWake < 5000)) return
    lastWake = Date.now()
    pending ??= saveForSync().then(async () => { if (!disposed) await invoke('sync_wake', { background }) }).catch(error => onError(String(error))).finally(() => { pending = undefined })
    return pending
  }
  const focus = () => void wake(false)
  const visibility = () => void wake(document.visibilityState === 'hidden')
  window.addEventListener('focus', focus)
  window.addEventListener('online', focus)
  document.addEventListener('visibilitychange', visibility)
  // While the window is in use, look for changes from other devices often. An unchanged workspace
  // answers with a single small request, so this stays cheap; hidden or unfocused windows keep the slow poll.
  const watching = window.setInterval(() => {
    if (disposed || document.visibilityState !== 'visible' || !document.hasFocus() || !navigator.onLine) return
    void invoke('sync_wake', { background: false, poll: true }).catch(() => {})
  }, ACTIVE_POLL_MS)
  let unlisten: (() => void) | undefined
  let closing = false
  void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
    const window = getCurrentWindow()
    const stop = await window.onCloseRequested(async event => {
      if (closing || disposed) return
      event.preventDefault()
      closing = true
      try { await saveForSync(); await invoke('sync_wake', { background: true }); await window.destroy() }
      catch (error) { onError(String(error)); closing = false } // A failed local save keeps the window open.
    })
    if (disposed) stop(); else unlisten = stop
  }).catch(() => {})
  return () => { disposed = true; window.clearInterval(watching); unlisten?.(); window.removeEventListener('focus', focus); window.removeEventListener('online', focus); document.removeEventListener('visibilitychange', visibility) }
}
