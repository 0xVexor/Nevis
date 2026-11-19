import { kvGet, prefsSave, isTauri, storageFrozen } from './db'
import { isUnreadable } from './kvStore'
import { getSettings, reloadSettings } from './settings'
import { preferenceKey, type Preferences } from './preferencesModel'
const KEYS = new Set([
  'not.settings',
  'not.reader.cfg',
  'not.page.width',
  'not.sideW',
  'not.side',
  'not.panel.v2',
  'not.explorer.mode',
  'not.db.weekStart',
  'not.db.map',
  'not.db.gateway',
  'not.drawing.library',
])
const allowed = (k: string) => KEYS.has(k) || /^db\.personal\.[a-zA-Z0-9_-]+$/.test(k)
let seen = ''
let saving: Promise<void> | null = null
let ready = false
let applying = false
let base: Preferences = {} // the stored preferences this device's values descend from ({} when nothing was stored)
let blocked = false // the stored file could not be read or merged: nothing is saved until it is read again
const snapshot = (): Preferences =>
  Object.fromEntries([...new Set([...KEYS, ...Object.keys(localStorage).filter(allowed)])].sort().map((k) => [k, k === 'not.settings' ? JSON.stringify(getSettings()) : localStorage.getItem(k)]))
function report(e: unknown) {
  window.dispatchEvent(new CustomEvent('storage-error', { detail: String(e) }))
}
function apply(values: Preferences) {
  applying = true
  try {
    for (const [k, v] of Object.entries(values))
      if (allowed(k) && (v === null || typeof v === 'string')) {
        if (v === null) localStorage.removeItem(k)
        else localStorage.setItem(k, v)
      }
    reloadSettings()
    window.dispatchEvent(new Event('preferences-changed'))
  } finally {
    applying = false
  }
}
/** Writes the preferences of this device into the vault when they changed (the vault keeps them with its notes). */
export async function flushPreferences(): Promise<void> {
  if (!ready || applying || storageFrozen()) return
  if (saving) {
    await saving
    return flushPreferences()
  }
  const next = snapshot()
  const key = preferenceKey(next)
  if (key === seen) return
  if (blocked) return
  saving = prefsSave(base, next)
    .then((merged) => {
      // another device's changes come back merged with ours; adopt them unless something was edited here meanwhile
      if (preferenceKey(snapshot()) === key) {
        base = merged
        apply(merged)
        seen = preferenceKey(snapshot())
      } else base = next
    })
    .catch((e) => {
      if (isUnreadable(e)) blocked = true // nothing was written; keep the values in memory
      throw e
    })
    .finally(() => {
      saving = null
    })
  await saving
  return flushPreferences()
}
/** Reads the stored preferences (at start and after a sync download) and adopts them. */
async function loadPreferences() {
  const saved = await kvGet<Preferences>('preferences')
  base = saved ?? {}
  if (saved) {
    apply(saved)
    seen = preferenceKey(snapshot())
  }
  blocked = false
}
export async function initPreferences() {
  if (!isTauri) return
  await loadPreferences()
  ready = true
  await flushPreferences()
  window.setInterval(() => void flushPreferences().catch(report), 1000)
  window.addEventListener('preferences-edit', () => void flushPreferences().catch(report))
  window.addEventListener('pagehide', () => void flushPreferences().catch(report))
  // a sync download changed the stored file: adopt it, so the next save does not overwrite it
  window.addEventListener(
    'external-change',
    () =>
      void (saving ?? Promise.resolve())
        .catch(() => {})
        .then(loadPreferences)
        .catch(report),
  )
}
