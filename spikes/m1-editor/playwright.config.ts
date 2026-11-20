import { defineConfig } from '@playwright/test'
// Real Chrome (installed on the machine) so no browser download is needed. WebKit/Safari is covered by the owner's checklist.
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  timeout: 30 * 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', channel: 'chrome', headless: true },
  webServer: { command: './node_modules/.bin/vite', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
})
