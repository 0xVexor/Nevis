import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'

// ROADMAP M3 criterion 4. The scenario is a plain Node script (tests/two-engines.mjs): it must launch two different engines,
// which the test runner's per-project `channel` setting does not allow.
test('Chromium and WebKit both edit offline, then converge', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'launches both engines itself')
  const r = spawnSync('node', ['tests/two-engines.mjs'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 180_000 })
  console.log((r.stdout + r.stderr).trim())
  expect(r.status).toBe(0)
})
