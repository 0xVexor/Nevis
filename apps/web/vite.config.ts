import { cpSync, existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Go server is reached through the dev server (same origin): no CORS, and the page stays a secure context on localhost.
// Host must reach the server unchanged: its CSRF guard compares the Origin header with Host (a reverse proxy in production must do the same).
const server = { target: process.env.NEVIS_SERVER ?? 'http://127.0.0.1:8787', changeOrigin: false, xfwd: true }
// HTTPS for a phone on the same network (docs/dev-https.md): NEVIS_TLS_CERT=/path/cert.pem NEVIS_TLS_KEY=/path/key.pem
const https = process.env.NEVIS_TLS_CERT && process.env.NEVIS_TLS_KEY ? { cert: readFileSync(process.env.NEVIS_TLS_CERT), key: readFileSync(process.env.NEVIS_TLS_KEY) } : undefined
// Excalidraw loads its fonts at run time. They come from OUR origin (`/excalidraw-assets/`), never from a CDN: the app works offline and under
// both content security policies. The files are copied from node_modules into `public/` (not committed) when the dev server or a build starts.
function excalidrawAssets() {
  return {
    name: 'nevis-excalidraw-assets',
    buildStart() {
      // direct paths (the packages' `exports` maps do not expose their folders)
      const from = join(import.meta.dirname, '../../packages/editor/node_modules/@excalidraw/excalidraw/dist/prod/fonts')
      const to = join(import.meta.dirname, 'public/excalidraw-assets/fonts')
      if (existsSync(from)) cpSync(from, to, { recursive: true })
      mkdirSync(join(to, 'Vazirmatn'), { recursive: true })
      copyFileSync(join(import.meta.dirname, 'node_modules/@fontsource/vazirmatn/files/vazirmatn-arabic-400-normal.woff2'), join(to, 'Vazirmatn/Vazirmatn-arabic-400.woff2'))
    },
  }
}
// Excalidraw ALSO lists a CDN as the last place to look for a font (`https://esm.sh/@excalidraw/excalidraw@x/dist/prod/`). Under our content
// security policy that is a blocked request and a violation report for every font, and it is a hard-coded third-party address in the bundle.
// Rewritten at build time to our own origin: the base becomes `<origin>/excalidraw-assets/#...` (a URL fragment in a base is dropped when
// a relative path is resolved against it), so the fallback is the same place as the first choice.
function excalidrawNoCdn() {
  return {
    name: 'nevis-excalidraw-no-cdn',
    transform(code: string, id: string) {
      if (!id.includes('excalidraw') || !code.includes('https://esm.sh/')) return null
      return { code: code.split('https://esm.sh/').join('${globalThis.location?.origin ?? ""}/excalidraw-assets/#'), map: null }
    },
  }
}
export default defineConfig({
  plugins: [react(), excalidrawAssets(), excalidrawNoCdn()],
  build: { rollupOptions: { input: { index: 'index.html', bench: 'bench.html', conformance: 'conformance.html', 'desktop-selftest': 'desktop-selftest.html', 'desktop-bench': 'desktop-bench.html', 'desktop-typing': 'desktop-typing.html', 'desktop-sync': 'desktop-sync.html' } } },
  server: { port: 5174, strictPort: true, host: true, https, proxy: { '/v1': server } },
  preview: { port: 5174, strictPort: true, host: true, https, proxy: { '/v1': server } },
})
