import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
await mkdir(new URL('./dist/', import.meta.url), { recursive: true })
await build({
  entryPoints: [fileURLToPath(new URL('./server.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/server.cjs', import.meta.url)),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
})
await writeFile(new URL('./dist/sea-config.json', import.meta.url), JSON.stringify({
  main: `${here}dist/server.cjs`,
  output: `${here}dist/nevis-mcp-spike${process.platform === 'win32' ? '.exe' : ''}`,
  disableExperimentalSEAWarning: true,
  useCodeCache: false, useSnapshot: false,
  execArgvExtension: 'none',
}, null, 2) + '\n')
