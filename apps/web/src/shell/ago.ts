import { locale } from '../i18n'

const rtf = () => new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
/** "5 minutes ago", "yesterday": relative time in the interface language. */
export function ago(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000)
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [Infinity, 'day']]
  const div = [1, 60, 3600, 86400]
  for (let i = 0; i < steps.length; i++) if (Math.abs(s) < steps[i]![0]) return rtf().format(Math.round(s / div[i]!), steps[i]![1])
  return ''
}
