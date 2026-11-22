// The control inventory of every screen, old app vs new app, with the same data and language: every button, menu item, checkbox, link and
// text field by its accessible name. A name the old screen has and the new one lacks is a gap; a name only the new one has is listed too.
//   node tools/uiparity/inventory.mjs [screen ...]      (the same screen names as shoot.mjs)
import { SCREENS } from './screens.mjs'
import { browser, openNew, openOld } from './lib.mjs'

const only = process.argv.slice(2)
const names = page => page.evaluate(() => {
  const out = new Set()
  const label = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  for (const el of document.querySelectorAll('button, [role=menuitem], [role=tab], [role=switch], [role=radio], input, select, textarea, a[href], [role=checkbox], summary')) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (getComputedStyle(el).visibility === 'hidden') continue
    const kind = el.tagName === 'INPUT' ? 'input:' + (el.getAttribute('type') || 'text') : el.getAttribute('role') || el.tagName.toLowerCase()
    const l = label(el)
    if (l || kind.startsWith('input')) out.add(kind + ' | ' + l)
  }
  return [...out].sort()
})
const apps = { old: await openOld(), new: await openNew() }
let gaps = 0
for (const [name, s] of Object.entries(SCREENS)) {
  if (only.length && !only.includes(name)) continue
  const got = {}
  for (const k of ['old', 'new']) {
    const { page, ids } = apps[k]
    try { await s[k](page, ids); await page.waitForTimeout(s.wait ?? 600); got[k] = await names(page) } catch (e) { got[k] = []; console.log(`${name}.${k}: ${String(e).split('\n')[0]}`) }
  }
  const o = new Set(got.old), n = new Set(got.new)
  const missing = got.old.filter(x => !n.has(x)), extra = got.new.filter(x => !o.has(x))
  gaps += missing.length
  console.log(`\n== ${name}: old ${o.size}, new ${n.size}`)
  if (missing.length) console.log('  only in OLD:\n    ' + missing.join('\n    '))
  if (extra.length) console.log('  only in NEW:\n    ' + extra.join('\n    '))
}
console.log('\nmissing controls in total:', gaps)
await browser.close()
