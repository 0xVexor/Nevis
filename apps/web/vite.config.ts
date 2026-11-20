import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Go server is reached through the dev server (same origin): no CORS, and the page stays a secure context on localhost.
const server = process.env.NEVIS_SERVER ?? 'http://127.0.0.1:8787'
// HTTPS for a phone on the same network (docs/dev-https.md): NEVIS_TLS_CERT=/path/cert.pem NEVIS_TLS_KEY=/path/key.pem
const https = process.env.NEVIS_TLS_CERT && process.env.NEVIS_TLS_KEY ? { cert: readFileSync(process.env.NEVIS_TLS_CERT), key: readFileSync(process.env.NEVIS_TLS_KEY) } : undefined
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, host: true, https, proxy: { '/v1': server } },
  preview: { port: 5174, strictPort: true, host: true, https, proxy: { '/v1': server } },
})
