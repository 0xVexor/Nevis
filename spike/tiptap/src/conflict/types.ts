import type { Page } from '../documents/model.ts'

/** One device's version of a page when the conflict was detected. */
export interface ConflictSide {
  page: Page
  deviceId: string
  deviceName: string
  savedAt: number
}

/** Written by the backend when one page was changed on two devices; the page view offers to resolve it. */
export interface ConflictMarker {
  format: 1
  id: string
  pageId: string
  kind: 'edit' | 'restore' | 'editor-race' | 'deleted-here' | 'deleted-there' | 'merged'
  detectedAt: number
  detectedBy: { deviceId: string; deviceName: string }
  /** The last version both devices agreed on, when the server still had it. */
  base: Page | null
  /** This device's version at detection time. */
  local: ConflictSide
  /** The other device's version. */
  remote: ConflictSide & { serverTime?: number }
  /** The side the page currently shows (and the default wherever the marker has nothing better to say). */
  kept: 'local' | 'remote'
}

export type ConflictSideName = 'local' | 'remote'
