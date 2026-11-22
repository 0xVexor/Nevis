// The menus and pop-ups of the shell and the page, old vs new: open each one the same way in both apps and list what it offers.
//   node tools/uiparity/menus.mjs        (same data/language as shoot.mjs)
import { browser, openNew, openOld } from './lib.mjs'

const items = page => page.evaluate(() => [...document.querySelectorAll('.ds-menu-item, [role=menuitem], .ds-pop button, .ds-pop [role=option]')].filter(e => e.getBoundingClientRect().width).map(e => (e.getAttribute('aria-label') || e.textContent).replace(/\s+/g, ' ').trim().slice(0, 50)).filter(Boolean))
const close = async page => { await page.keyboard.press('Escape'); await page.waitForTimeout(350) }
const click = (sel, o = {}) => async page => { await page.locator(sel).first().click(o); await page.waitForTimeout(500) }
const dbl = sel => async page => { await page.locator(sel).first().dblclick(); await page.waitForTimeout(900) }
const STEPS = {
  'rail: New menu': click('.side-new'),
  'rail: workspace card': click('.wscard'),
  'rail: logo (pin)': click('.ds-workspace-header button, .ws button'),
  'panel: options (⋮)': click('.context-tools button[aria-haspopup=menu], .context-tools button:last-child'),
  'tree: row context menu': click('.tree-frame .row, [data-testid=page-row], .cmp-list .row', { button: 'right' }),
  'tree: row ⋯ button': async page => { const row = page.locator('[data-testid=page-row], .tree-row, .twisty ~ *').first(); await page.locator('.tree .row, .tree-row').first().hover().catch(() => {}); await page.locator('.row .acts button').first().click({ force: true }) ; await page.waitForTimeout(500) },
  'home: page card context': click('.home-page, .home-return-page', { button: 'right' }),
  'page: share (Share/خروجی)': async page => { await page.locator('.tree-frame .row, [data-testid=page-row]').first().dblclick(); await page.waitForTimeout(1200); await page.locator('.share-btn').click(); await page.waitForTimeout(500) },
  'page: status chip': click('.pg-props .ds-chip-btn, .pg-props [aria-haspopup]'),
  'page: icon button': click('.pg-icon'),
  'page: tag chip right-click': click('.pg-props .ds-tag, .pg-props .ds-chip', { button: 'right' }),
  'page: editor right-click': click('.ProseMirror p', { button: 'right' }),
  'page: breadcrumb … menu': click('.crumb-more button'),
  'page: drawer actions': async page => { await page.locator('.topbar button[aria-label*="side panel"], .topbar [data-testid=page-panel-toggle], .tb-group button').nth(1).click(); await page.waitForTimeout(500) },
}
const apps = { old: await openOld(), new: await openNew() }
let missing = 0
for (const [name, step] of Object.entries(STEPS)) {
  const got = {}
  for (const k of ['old', 'new']) {
    const { page } = apps[k]
    try {
      if (name.startsWith('page:') || name.startsWith('tree:') || name.startsWith('home:')) { await page.goto(page.url().split('#')[0] + (k === 'new' ? '#/home' : ''), { waitUntil: 'load' }).catch(() => {}); await page.waitForTimeout(1500) }
      await step(page); got[k] = await items(page); await close(page)
    } catch (e) { got[k] = ['(could not open: ' + String(e).split('\n')[0].slice(0, 70) + ')'] }
  }
  const n = new Set(got.new); const lack = got.old.filter(x => !n.has(x) && !x.startsWith('('))
  missing += lack.length
  console.log(`\n== ${name}: old ${got.old.length}, new ${got.new.length}`)
  if (got.old.length && got.new[0]?.startsWith('(')) console.log('  NEW:', got.new[0])
  if (got.old[0]?.startsWith('(')) console.log('  OLD:', got.old[0])
  if (lack.length) console.log('  only in OLD:\n    ' + lack.join('\n    '))
}
console.log('\nmissing menu entries:', missing)
await browser.close()
