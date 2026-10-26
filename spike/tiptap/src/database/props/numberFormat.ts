// Number display (handoff §7): formatting never rescales the stored raw value (0.25 stays 0.25 when shown as 25%).
import type { NumberConfig } from './config.ts'

/** Currencies offered in the UI; the stored value is the 3-letter code, never a translated label. IRR is a deliberate local addition. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'CHF', 'INR', 'TRY', 'AED', 'SAR', 'RUB', 'BRL', 'KRW', 'MXN', 'SEK', 'NOK', 'DKK', 'PLN', 'IRR'] as const

export function formatNumber(value: number, cfg: NumberConfig, locale = 'en-US'): string {
  const frac = { minimumFractionDigits: cfg.precision, maximumFractionDigits: cfg.precision }
  switch (cfg.format) {
    case 'plain': {
      const s = cfg.precision ? value.toFixed(cfg.precision) : String(roundPlain(value))
      return locale.startsWith('fa') ? s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]).replace('.', '٫') : s
    }
    case 'grouped': return new Intl.NumberFormat(locale, { ...frac, useGrouping: true }).format(value)
    case 'percent': return new Intl.NumberFormat(locale, { ...frac, style: 'percent' }).format(value)
    case 'currency': return new Intl.NumberFormat(locale, { ...frac, style: 'currency', currency: cfg.currencyCode ?? 'USD' }).format(value)
  }
}

// precision 0 plain: show the number as typed, not rounded to an integer (a plain Number with no decimals set still keeps 1.5)
const roundPlain = (v: number) => v

/** Progress fraction [0,1] for bar/ring display; the raw value is untouched. */
export function progressOf(value: number, cfg: NumberConfig): number | null {
  if (!cfg.progress) return null
  return Math.max(0, Math.min(1, value / cfg.progress.target))
}

/** Shortest locale-neutral decimal (no exponent form) for formula `format()`. */
export function plainDecimal(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n)
  const s = String(n)
  if (!/e/i.test(s)) return s
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
}
