import { expect, test } from '@playwright/test'

// ADR-0010 §6, §7: `Intl.Collator('fa')` and the Persian calendar in each engine. The results are printed (the report records them) and asserted.
test('Intl.Collator("fa") orders Persian words in the alphabet order, and the Persian calendar formats a known date', async ({ page, browserName }) => {
  await page.goto('/')
  const r = await page.evaluate(() => {
    const words = ['ی', 'پ', 'ا', 'ب', 'ک', 'گ', 'ز', 'ژ', 'چ', 'ج', 'ه', 'م', 'آ', 'ت', 'س', 'ش', 'ص', 'ف', 'ق', 'ل', 'ن', 'و', 'خ', 'د', 'ذ', 'ر', 'ع', 'غ', 'ط', 'ظ', 'ض', 'ث', 'ح']
    const sorted = [...words].sort(new Intl.Collator('fa').compare)
    const sample = ['کتاب', 'گل', 'پدر', 'ایران', 'بابا', 'یار', 'ژاله', 'چای', 'جام', 'آب'].sort(new Intl.Collator('fa').compare)
    const date = new Intl.DateTimeFormat('fa-IR', { calendar: 'persian', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 2, 20)))
    const num = new Intl.DateTimeFormat('fa-IR-u-nu-latn', { calendar: 'persian', year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 2, 20)))
    return { sorted: sorted.join(''), sample, date, num, locale: new Intl.Collator('fa').resolvedOptions().locale }
  })
  console.log(`INTL ${browserName}: ${JSON.stringify(r)}`)
  // 20 March 2024 is 1 Farvardin 1403
  expect(r.date).toContain('فروردین')
  expect(r.date).toMatch(/۱۴۰۳/)
  expect(r.num.replace(/\D/g, '')).toBe('14030101')
  // the order that matters in a list: آ/ا first, then ب پ ت, ..., ی last
  expect(r.sample).toEqual(['آب', 'ایران', 'بابا', 'پدر', 'جام', 'چای', 'ژاله', 'کتاب', 'گل', 'یار'])
})
