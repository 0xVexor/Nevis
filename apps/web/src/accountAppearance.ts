import { readAccountAppearance, writeAccountAppearance, type AppearanceValues } from './auth'
import { applyAccountAppearance, FONTS, getSettings, subscribeSettingsEdits, type Settings } from './deviceSettings'

const fields = ['accent', 'font', 'fontEn', 'fontSize', 'textColor'] as const
type Appearance = Partial<Pick<Settings, typeof fields[number]>>

function appearanceOf(settings: Partial<Settings>): AppearanceValues {
  return Object.fromEntries(fields.flatMap(key => {
    const value = settings[key]
    const valid = key === 'accent' || key === 'textColor'
      ? value === null || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
      : key === 'fontSize'
        ? typeof value === 'number' && Number.isInteger(value) && value >= 12 && value <= 28
        : (key === 'fontEn' && value === null) || FONTS.some(font => font.id === value)
    return valid && value !== undefined ? [[key, value] as const] : []
  }))
}

/** Sync personal appearance separately from shared workspace settings. */
export function syncAccountAppearance(accountId: string): () => void {
  const queueKey = 'nevis.appearance.pending.' + accountId
  const readQueue = (): AppearanceValues => {
    try { return appearanceOf(JSON.parse(localStorage.getItem(queueKey) ?? '{}') as Appearance) } catch { return {} }
  }
  let queue = readQueue()
  let stopped = false
  let running = false
  let queued = false

  const storeQueue = () => {
    try {
      if (Object.keys(queue).length) localStorage.setItem(queueKey, JSON.stringify(queue))
      else localStorage.removeItem(queueKey)
    } catch { /* keep pending edits in memory while storage is unavailable */ }
  }

  const refresh = async () => {
    if (stopped || !navigator.onLine || document.hidden) return
    if (running) { queued = true; return }
    running = true
    try {
      const sent = { ...queue }
      let current = Object.keys(sent).length
        ? await writeAccountAppearance(accountId, sent)
        : await readAccountAppearance()
      if (current.accountId !== accountId) return
      for (const key of Object.keys(sent)) if (queue[key] === sent[key]) delete queue[key]
      storeQueue()
      if (stopped) return
      // The first upgraded device seeds existing local choices. Later devices only fill missing fields.
      if (fields.some(key => !Object.hasOwn(current.values, key))) {
        current = await writeAccountAppearance(accountId, appearanceOf(getSettings()), true)
      }
      if (!stopped && current.accountId === accountId) {
        applyAccountAppearance({ ...appearanceOf(current.values as Appearance), ...queue } as Appearance)
      }
    } catch { /* offline or an older server: keep the local appearance and retry */ }
    finally {
      running = false
      if (queued) { queued = false; void refresh() }
    }
  }

  const off = subscribeSettingsEdits(patch => {
    const changed = appearanceOf(patch)
    if (!Object.keys(changed).length) return
    queue = { ...readQueue(), ...queue, ...changed }
    storeQueue()
    void refresh()
  })
  const resume = () => { void refresh() }
  const onStorage = (event: StorageEvent) => { if (event.key === queueKey) queue = readQueue() }
  const timer = window.setInterval(resume, 10_000)
  window.addEventListener('storage', onStorage)
  window.addEventListener('online', resume)
  window.addEventListener('focus', resume)
  document.addEventListener('visibilitychange', resume)
  resume()
  return () => {
    stopped = true
    off()
    clearInterval(timer)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('online', resume)
    window.removeEventListener('focus', resume)
    document.removeEventListener('visibilitychange', resume)
  }
}
