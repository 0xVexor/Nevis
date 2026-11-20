import { defineConfig, devices } from '@playwright/test'

// Three engines: Chromium (the installed Chrome), WebKit (Safari's engine) and Firefox. WebKit here is Playwright's build, not
// Safari itself and not iOS: the owner's checklist covers the real devices.
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  timeout: 5 * 60_000,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/global-setup.ts',
  use: { baseURL: 'http://localhost:5174' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: { command: './node_modules/.bin/vite', url: 'http://localhost:5174', reuseExistingServer: true, timeout: 60_000 },
})
