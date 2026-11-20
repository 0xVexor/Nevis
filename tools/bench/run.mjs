// pnpm bench:startup [pages=10000] [engines=chromium,webkit,firefox]
// Builds the web app, serves the build (no dev server: its unbundled modules would distort the numbers), and in each browser:
// seeds N pages in IndexedDB, RELOADS the page (a cold start), and times the page list and opening a page.
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit } from '@playwright/test'

const web = fileURLToPath(new URL('../../apps/web', import.meta.url))
const n = Number(process.argv[2] ?? 10000)
const engines = (process.argv[3] ?? 'chromium,webkit,firefox').split(',')
execFileSync(join(web, 'node_modules/.bin/vite'), ['build', '--logLevel', 'error'], { cwd: web, stdio: 'inherit' })
const dist = join(web, 'dist')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const srv = createServer((q, r) => {
  const path = join(dist, new URL(q.url, 'http://x').pathname)
  if (!existsSync(path) || statSync(path).isDirectory()) { r.writeHead(404).end(); return }
  r.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
  createReadStream(path).pipe(r)
})
await new Promise(res => srv.listen(0, '127.0.0.1', res))
const url = `http://localhost:${srv.address().port}/bench.html`
const launch = { chromium: () => chromium.launch({ channel: 'chrome' }), webkit: () => webkit.launch(), firefox: () => firefox.launch() }

for (const e of engines) {
  const b = await launch[e]()
  const page = await (await b.newContext()).newPage()
  page.on('pageerror', x => console.log(e, 'page error:', x.message))
  await page.goto(url)
  const seeded = await page.evaluate(n => window.__bench.seed(n), n)
  await page.goto(url + '?cold') // a fresh load: nothing from the seeding run is in memory
  const cold = await page.evaluate(() => window.__bench.cold())
  const opened = await page.evaluate(ids => window.__bench.open(ids, 20), seeded.withBody)
  const { withBody, ...s } = seeded
  console.log(JSON.stringify({ engine: e, seed: s, cold, openPage: opened }))
  await b.close()
}
srv.close()
