import { kvGet } from './db'
import { repo } from './store'
import { extractCards, isDue, type Rec } from './srs'
import { getSettings } from './settings'
import { t } from './i18n'

const NEW_PER_SESSION = 20 // same cap as a review session (Flashcards.tsx)
const EVERY = 5 * 60 * 1000
const NOTIFY_GAP = 4 * 3600 * 1000 // at most one system notification per 4 hours

/** Cards a review session would offer right now: due ones plus a few new ones. */
export async function countDue(): Promise<number> {
  const srs = (await kvGet<Record<string, Rec>>('srs')) ?? {}
  let due = 0
  let fresh = 0
  for (const p of repo.pagesOnly()) {
    if (typeof p.content === 'string') continue
    for (const c of extractCards(p.id, p.content)) {
      const r = srs[c.key]
      if (!r) fresh++
      else if (isDue(r)) due++
    }
  }
  return due + Math.min(fresh, NEW_PER_SESSION)
}

async function notify(n: number) {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')
    if (!(await isPermissionGranted()) && (await requestPermission()) !== 'granted') return
    sendNotification({ title: 'Nevis.', body: t('{n} flashcards are ready to review.', { n }) })
  } catch (e) {
    console.error('notification', e)
  }
}

/** Keeps `onCount` current and, while the app is in the background, reminds about due cards now and then. */
export function watchDueCards(onCount: (n: number) => void, desktop: boolean): () => void {
  const check = async () => {
    try {
      const n = await countDue()
      onCount(n)
      const last = Number(localStorage.getItem('not.cards.notified') ?? 0)
      if (desktop && n > 0 && getSettings().cardReminders && !document.hasFocus() && Date.now() - last > NOTIFY_GAP) {
        localStorage.setItem('not.cards.notified', String(Date.now()))
        void notify(n)
      }
    } catch (e) {
      console.error('due cards', e)
    }
  }
  const first = window.setTimeout(() => void check(), 2500)
  const id = window.setInterval(() => void check(), EVERY)
  window.addEventListener('cards-reviewed', check)
  return () => {
    window.clearTimeout(first)
    window.clearInterval(id)
    window.removeEventListener('cards-reviewed', check)
  }
}
