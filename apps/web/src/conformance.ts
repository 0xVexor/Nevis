// The Store conformance suite, run by the BROWSER'S OWN IndexedDB (Playwright loads this page in Chromium, WebKit, Firefox).
import { storeConformance } from '@nevis/core'
import { IdbStore } from '@nevis/store-idb'
import { harness, runAll } from './harness'

let n = 0
const run = Date.now()
storeConformance(harness, 'IdbStore in the browser', () => new IdbStore({ name: `conformance-${run}-${++n}` }))

void runAll().then(results => {
  ;(window as unknown as { __conformance: unknown }).__conformance = results
  document.getElementById('out')!.textContent = results.map(r => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` — ${r.error}` : ''}`).join('\n')
})
