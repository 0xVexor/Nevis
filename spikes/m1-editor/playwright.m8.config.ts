import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'tests', testMatch: /fuzz\.spec\.ts/, timeout: 30 * 60_000, reporter: [['list']],
  use: { baseURL: 'http://localhost:5183', channel: 'chrome', headless: true },
  webServer: { command: './node_modules/.bin/vite --port 5183 --strictPort', url: 'http://localhost:5183', reuseExistingServer: false, timeout: 60_000 },
})
