// Normalizes text for full-text search (index time and query time must use the same function).
const AR_DIGITS = /[٠-٩۰-۹]/g

export function normalizeFa(s: string): string {
  return s
    .replace(/ي|ى/g, 'ی') // ي ى -> ی
    .replace(/ك/g, 'ک') // ك -> ک
    .replace(/[‌‍‎‏]/g, ' ') // ZWNJ/ZWJ/LRM/RLM -> space
    .replace(/[ً-ٰٟـ]/g, '') // harakat, dagger alif, tatweel
    .replace(AR_DIGITS, (d: string) => String(d.charCodeAt(0) & 0xf))
    .toLowerCase()
}
