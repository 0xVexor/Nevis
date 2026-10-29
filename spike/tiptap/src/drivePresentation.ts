import { driveSettingKeys } from './driveSettingsPolicy'

export type DriveTab = 'overview' | 'workspaces' | 'history' | 'preferences' | 'advanced'
export type DriveVisualState = 'checking' | 'local' | 'signed-out' | 'paused' | 'conflicts' | 'offline' | 'error' | 'syncing' | 'pending' | 'idle' | 'waiting'
export function driveVisualState(input: { connected: boolean; signedIn: boolean; checking?: boolean; paused: boolean; state?: string; reason?: string; error?: string; pending: number; verified: number }): DriveVisualState {
  if (!input.connected) return 'local'
  if (input.checking) return 'checking'
  if (!input.signedIn) return 'signed-out'
  if (input.paused) return 'paused'
  if (input.reason === 'CONFLICTS' || /db_relation_cardinality|db_duplicate_edge/.test(input.error ?? '')) return 'conflicts'
  if (input.state === 'paused') return 'paused'
  if (input.state === 'offline') return 'offline'
  if (input.state === 'error' || input.error) return 'error'
  if (input.state === 'syncing') return 'syncing'
  if (input.pending > 0 || input.state === 'pending') return 'pending'
  return input.verified > 0 ? 'idle' : 'waiting'
}
export const driveStateLabels: Record<DriveVisualState, string> = { checking: 'Checking secure account storage…', local: 'Local only', 'signed-out': 'Sign in required', paused: 'Paused', conflicts: 'Needs review', offline: 'Offline', error: 'Sync needs attention', syncing: 'Syncing…', pending: 'Saved locally — waiting to sync', idle: 'Up to date', waiting: 'Waiting to sync' }
export const drivePreferenceGroups: { title: string; keys: (typeof driveSettingKeys)[number][] }[] = [
  { title: 'Appearance', keys: ['theme', 'accent', 'bg', 'bgStrength', 'radius', 'sidebar', 'sideGlass', 'mainGlass', 'showCovers', 'showIcons'] },
  { title: 'Language and reading', keys: ['lang', 'dir', 'font', 'fontSize', 'textColor', 'reduceMotion'] },
  { title: 'Workspace behavior', keys: ['pagesView', 'cardReminders', 'compressImages'] },
  { title: 'Updates', keys: ['prereleaseUpdates'] },
]

export function driveTimestamp(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A previous success cannot turn pending, paused or failed work green. */
export function syncSucceeded(status: { signedIn: boolean; syncOn: boolean; state: string; lastAt: number; error?: string; reason?: string }): boolean {
  return status.signedIn && status.syncOn && status.state === 'idle' && status.lastAt > 0 && !status.error && !status.reason
}
