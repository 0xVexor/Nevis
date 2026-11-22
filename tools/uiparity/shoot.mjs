// Side-by-side screenshots of the OLD app (reference) and the NEW app with the SAME data, viewport, theme and language.
//   node tools/uiparity/shoot.mjs <outdir> [screen ...]      OLD=http://localhost:5190 NEW=http://localhost:5174 SERVER=http://127.0.0.1:8787
// Writes <outdir>/<screen>.old.png and <screen>.new.png. Screens are defined in screens.mjs (one entry per screen: how to reach it).
import { mkdirSync } from 'node:fs'
import { SCREENS } from './screens.mjs'
import { browser, openNew, openOld } from './lib.mjs'

const out = process.argv[2]
const only = process.argv.slice(3)
mkdirSync(out, { recursive: true })
const apps = { old: await openOld(), new: await openNew() }
for (const [name, s] of Object.entries(SCREENS)) {
  if (only.length && !only.includes(name)) continue
  for (const k of ['old', 'new']) {
    const { page, ids } = apps[k]
    try { await s[k](page, ids); await page.waitForTimeout(s.wait ?? 600); await page.screenshot({ path: `${out}/${name}.${k}.png` }) }
    catch (e) { console.log(`${name}.${k}: ${String(e).split('\n')[0]}`) }
  }
  console.log('shot', name)
}
await browser.close()
