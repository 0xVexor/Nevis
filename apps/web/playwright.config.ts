import { defineConfig, devices } from '@playwright/test'
const webPort = Number(process.env.NEVIS_TEST_PORT ?? 5174)
const baseURL = `http://localhost:${webPort}`

// Three engines: Chromium (the installed Chrome), WebKit (Safari's engine) and Firefox. WebKit here is Playwright's build, not
// Safari itself and not iOS: the owner's checklist covers the real devices.
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  timeout: 5 * 60_000,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/global-setup.ts',
  // reducedMotion: the start animation (a 2-second logo) is skipped, as it is for a person who asks for less motion
  use: { baseURL, reducedMotion: 'reduce' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: { command: `./node_modules/.bin/vite --port ${webPort}`, url: baseURL, reuseExistingServer: true, timeout: 60_000 },
})
