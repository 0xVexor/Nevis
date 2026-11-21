// SYNCED settings: they follow the person to every device through the log (the `settings` entity, one register per setting: ADR-0004).
import { setSetting } from '@nevis/core'
import type { Json } from '@nevis/protocol'
import type { Workspace } from './workspace'

export interface SyncedSettings { calendar: 'jalali' | 'gregorian'; weekStart: 'sat' | 'sun' | 'mon' }
export const DEFAULT_SYNCED: SyncedSettings = { calendar: 'jalali', weekStart: 'sat' }

export function readSynced(ws: Workspace): SyncedSettings {
  const s = ws.data.settings
  return {
    calendar: s.calendar === 'gregorian' ? 'gregorian' : 'jalali',
    weekStart: s.weekStart === 'sun' || s.weekStart === 'mon' ? s.weekStart : 'sat',
  }
}

/** One op per change (a register of the settings entity). */
export const writeSynced = <K extends keyof SyncedSettings>(ws: Workspace, key: K, value: SyncedSettings[K]) => ws.mutate([ws.ws], c => setSetting(c, key, value as Json))
