import { settingsPolicy, preserveDeviceSettings, type SettingsPolicy } from './driveSettingsPolicy'
import { invoke } from '@tauri-apps/api/core'
import { kvGet, isTauri, storageFrozen } from './db'
import { getSettings, reloadSettings } from './settings'
import { preferenceKey, rebasePreferences, type Preferences } from './preferencesModel'
const KEYS = new Set(['not.settings', 'not.reader.cfg', 'not.page.width', 'not.sideW', 'not.side', 'not.panel.v2', 'not.explorer.mode', 'not.db.weekStart', 'not.db.map', 'not.db.gateway', 'not.drawing.library'])
const allowed = (k: string) => KEYS.has(k) || /^db\.personal\.[a-zA-Z0-9_-]+$/.test(k)
let policy: SettingsPolicy = {}
let baseline: Preferences = {}
let seen = ''
let saving: Promise<void> | null = null
let ready = false
let applying = false
const snapshot = (): Preferences => Object.fromEntries([...new Set([...KEYS, ...Object.keys(localStorage).filter(allowed)])].sort().map((k) => [k, k === 'not.settings' ? JSON.stringify(getSettings()) : localStorage.getItem(k)]))
function report(e: unknown) { window.dispatchEvent(new CustomEvent('storage-error', { detail: String(e) })) }
function apply(values: Preferences) {
  values = { ...values }
  if (typeof values['not.settings'] === 'string') values['not.settings'] = preserveDeviceSettings(values['not.settings'], JSON.stringify(getSettings()), policy)
  applying = true
  try {
    for (const [k, v] of Object.entries(values)) if (allowed(k) && (v === null || typeof v === 'string')) {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    }
    reloadSettings()
    window.dispatchEvent(new Event('preferences-changed'))
  } finally { applying = false }
}
export async function flushPreferences(): Promise<void> {
  if (!ready || applying || storageFrozen()) return
  if (saving) { await saving; return flushPreferences() }
  const next = snapshot()
  if (preferenceKey(next) === seen) return
  saving = invoke<Preferences>('preferences_save', { base: baseline, next }).then((merged) => {
    // A control may have changed again while the durable command was waiting for the vault lock.
    apply(rebasePreferences(next, snapshot(), merged))
    baseline = merged
    seen = preferenceKey(merged)
  }).finally(() => { saving = null })
  await saving
  return flushPreferences()
}
async function pull() {
  policy = settingsPolicy(await kvGet('settings'))
  if (saving) await saving
  const remote = await kvGet<Preferences>('preferences')
  if (!remote) return
  apply(rebasePreferences(baseline, snapshot(), remote))
  baseline = remote
  seen = preferenceKey(remote)
  await flushPreferences()
}
export async function initPreferences() {
  if (!isTauri) return
  policy = settingsPolicy(await kvGet('settings'))
  const saved = await kvGet<Preferences>('preferences')
  if (saved) { apply(saved); baseline = saved; seen = preferenceKey(snapshot()) }
  ready = true
  await flushPreferences()
  window.setInterval(() => void flushPreferences().catch(report), 1000)
  const { listen } = await import('@tauri-apps/api/event')
  await listen('vault-changed', () => void pull().catch(report))
  window.addEventListener('preferences-edit', () => void flushPreferences().catch(report))
  window.addEventListener('pagehide', () => void flushPreferences().catch(report))
}
