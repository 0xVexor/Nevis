import { defineConfig } from '@playwright/test'
const port = Number(process.env.NEVIS_SPIKE_PORT ?? 5173)
const baseURL = `http://localhost:${port}`
// Real Chrome (installed on the machine) so no browser download is needed. WebKit/Safari is covered by the owner's checklist.
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  timeout: 30 * 60_000,
  reporter: [['list']],
  use: { baseURL, channel: 'chrome', headless: true },
  webServer: { command: `./node_modules/.bin/vite --port ${port}`, url: baseURL, reuseExistingServer: true, timeout: 60_000 },
})
