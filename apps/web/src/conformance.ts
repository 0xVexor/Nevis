// The Store conformance suite, run by the BROWSER'S OWN IndexedDB (Playwright loads this page in Chromium, WebKit, Firefox).
import { blobStoreConformance, storeConformance } from '@nevis/core'
import { IdbBlobStore, IdbStore } from '@nevis/store-idb'
import { harness, runAll } from './harness'

let n = 0
const run = Date.now()
storeConformance(harness, 'IdbStore in the browser', () => new IdbStore({ name: `conformance-${run}-${++n}` }))
blobStoreConformance(harness, 'IdbBlobStore in the browser', () => new IdbBlobStore({ name: `conformance-blobs-${run}-${++n}` }))

void runAll().then(results => {
  ;(window as unknown as { __conformance: unknown }).__conformance = results
  document.getElementById('out')!.textContent = results.map(r => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` — ${r.error}` : ''}`).join('\n')
})
