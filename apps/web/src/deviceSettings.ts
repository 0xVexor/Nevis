// DEVICE settings: how THIS device looks (theme, text size, accent, sidebar width). They never leave the device: this module cannot even
// reach the synced log (the architecture rule `device-settings-never-reach-the-outbox` forbids it from importing @nevis/core), and the e2e
// test drives the Settings screen and checks that the outbox did not change.
//
// DEVIATION from ADR-0002 ("a device setting is local `meta`"): they live in localStorage, not in the workspace store's `meta`. One device has
// many workspaces and the theme must apply before sign-in and before any workspace database is open; a per-workspace `meta` cannot do that.
import { useSyncExternalStore } from 'react'

export interface DeviceSettings {
  theme: 'system' | 'light' | 'dark'
  /** text size in percent of the default */
  textScale: number
  /** '' = the default accent */
  accent: string
  sidebarWidth: number
}
export const DEFAULT_DEVICE: DeviceSettings = { theme: 'system', textScale: 100, accent: '', sidebarWidth: 264 }
const KEY = 'nevis.device'

const read = (): DeviceSettings => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DeviceSettings>
    const theme = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system'
    return {
      theme,
      textScale: Math.min(150, Math.max(80, Number(raw.textScale) || 100)),
      accent: typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent) ? raw.accent : '',
      sidebarWidth: Math.min(420, Math.max(200, Number(raw.sidebarWidth) || 264)),
    }
  } catch { return DEFAULT_DEVICE }
}

let current = read()
const listeners = new Set<() => void>()

export const getDeviceSettings = (): DeviceSettings => current
export function setDeviceSettings(patch: Partial<DeviceSettings>) {
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* a private window: the setting lasts for this session only */ }
  apply(current)
  for (const l of listeners) l()
}
export const useDeviceSettings = (): DeviceSettings => useSyncExternalStore(cb => { listeners.add(cb); return () => void listeners.delete(cb) }, getDeviceSettings)

/** Writes the settings onto the document (the design system reads `color-scheme`, `--user-accent` and the root font size). */
export function apply(s: DeviceSettings = current) {
  const root = document.documentElement
  root.style.colorScheme = s.theme === 'system' ? 'light dark' : s.theme
  root.dataset.theme = s.theme
  if (s.accent) root.style.setProperty('--user-accent', s.accent); else root.style.removeProperty('--user-accent')
  root.style.fontSize = `${s.textScale}%`
  root.style.setProperty('--sidebar-width', `${s.sidebarWidth}px`)
}
