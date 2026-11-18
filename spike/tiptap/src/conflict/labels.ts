import { t } from '../i18n'
import type { ConflictMarker, ConflictSideName } from './types'

/** The device's own name, or a generic one when it has none ("This device" is always the local side). */
export function deviceLabel(marker: ConflictMarker, side: ConflictSideName): string {
  const name = marker[side].deviceName.trim()
  return name || (side === 'local' ? t('This device') : t('Another device'))
}
