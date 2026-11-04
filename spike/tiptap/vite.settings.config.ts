import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Design study only: independent entry/output/cache, no change to the production app. */
export default defineConfig({
  plugins: [react()],
  cacheDir: '.vite-settings-study',
  server: { host: '127.0.0.1', port: 4182, strictPort: true },
  build: { outDir: 'dist-settings-study', rolldownOptions: { input: 'settings-preview.html' } },
})
