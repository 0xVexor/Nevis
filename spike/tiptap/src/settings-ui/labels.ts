import { useSettings } from '../settings'
import { t } from '../i18n'
export function useLabels() {
  useSettings()
  return t
}
