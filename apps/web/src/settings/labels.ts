import { useSettings } from '../deviceSettings'
import { t } from '../i18n'
export function useLabels() {
  useSettings()
  return t
}
