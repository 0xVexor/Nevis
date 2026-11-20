import { expect, test } from '@playwright/test'

test('the Store conformance suite passes on this browser\'s IndexedDB', async ({ page, browserName }) => {
  await page.goto('/conformance.html')
  await page.waitForFunction(() => (window as unknown as { __conformance?: unknown }).__conformance !== undefined, undefined, { timeout: 120_000 })
  const results = await page.evaluate(() => (window as unknown as { __conformance: { name: string; ok: boolean; error?: string }[] }).__conformance)
  console.log(`${browserName}: ${results.filter(r => r.ok).length}/${results.length} conformance tests`)
  expect(results.length).toBeGreaterThanOrEqual(9)
  expect(results.filter(r => !r.ok)).toEqual([])
})
